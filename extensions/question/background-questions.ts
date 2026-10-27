// Imperative shell for durable background batches. Blocking calls still own
// their tool promise in index.ts; this lifetime never depends on that promise.
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuestionParams } from "./core.ts";
import { openQuestionModal, type QuestionModalController, type QuestionModalSession } from "./modal.ts";
import type { QuestionModalDraft } from "./modal-component.ts";
import {
  ANSWER_MESSAGE_TYPE, BACKGROUND_ENTRY_TYPE, formatBackgroundAnswer,
  loadBackgroundBatches, queuedQuestionResult, type BackgroundBatch,
  type BackgroundPending, type BackgroundAnswered,
} from "./background-state.ts";

export function createBackgroundQuestions(pi: ExtensionAPI, hooks: {
  blocking(): QuestionModalController | undefined;
  picking(): boolean;
  changed(ctx: ExtensionContext): void;
}) {
  let batches = new Map<string, BackgroundBatch>();
  const sessions = new Map<string, QuestionModalSession>();
  // Drafts carried over from backgrounded blocking calls until first shown.
  const drafts = new Map<string, QuestionModalDraft>();
  const inFlight = new Set<string>();
  let selected: string | undefined;
  let epoch = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let parked: string | undefined;

  const pending = () => [...batches.values()].filter((b) => !b.answered);
  const shown = () => selected !== undefined && sessions.get(selected)?.controller.state() === "shown";
  const minimize = () => {
    if (selected) sessions.get(selected)?.controller.minimize();
  };
  const deliver = (ctx: ExtensionContext) => {
    const current = loadBackgroundBatches(ctx.sessionManager.getBranch());
    for (const batch of current.values()) {
      if (!batch.answered || batch.delivered || inFlight.has(batch.answered.answerId)) continue;
      const answerId = batch.answered.answerId;
      inFlight.add(answerId);
      // A dismissal informs the agent without waking it. pi >= 1.4 appends a
      // non-triggering custom message at once when idle, or at the next turn
      // boundary of a running agent, never between a tool call and its result.
      const wake = !batch.answered.result.details.dismissed;
      try {
        pi.sendMessage({ customType: ANSWER_MESSAGE_TYPE, display: true,
          content: formatBackgroundAnswer(batch),
          details: { requestId: batch.pending.requestId, toolCallId: batch.pending.toolCallId, answerId },
        }, wake ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: false });
      } catch (error) {
        inFlight.delete(answerId);
        ctx.ui.notify(`Failed to deliver question answer: ${String(error)}`, "error");
      }
    }
  };

  const show = (requestId: string, ctx: ExtensionContext) => {
    const batch = batches.get(requestId);
    if (stopped || !batch || batch.answered || ctx.mode !== "tui") return;
    hooks.blocking()?.minimize();
    minimize();
    selected = requestId;
    let session = sessions.get(requestId);
    if (!session) {
      const generation = epoch;
      session = openQuestionModal(ctx, batch.pending.params, {
        initiallyMinimized: true,
        draft: drafts.get(requestId),
        onStateChange: () => hooks.changed(ctx),
      });
      drafts.delete(requestId);
      sessions.set(requestId, session);
      const opened = session;
      void session.completion.then((run) => {
        if (stopped || generation !== epoch || sessions.get(requestId) !== opened) return;
        if (run.outcome.kind !== "answered" && run.outcome.kind !== "dismissed") return;
        // Inversion: recheck the raw branch before persistence, then persist the
        // answer before queuing delivery. A queue is not durable storage.
        const current = loadBackgroundBatches(ctx.sessionManager.getBranch()).get(requestId);
        if (!current || current.answered) return;
        const answered: BackgroundAnswered = { version: 1, kind: "answered",
          requestId, answerId: randomUUID(), result: run.result };
        pi.appendEntry(BACKGROUND_ENTRY_TYPE, answered);
        batch.answered = answered;
        sessions.delete(requestId);
        if (selected === requestId) selected = undefined;
        hooks.changed(ctx);
        deliver(ctx);
      }).catch((error: unknown) => {
        if (stopped || generation !== epoch) return;
        // Presentation failure is not an answer: retain the durable request and
        // allow /question to create another presentation.
        sessions.delete(requestId);
        if (selected === requestId) selected = undefined;
        hooks.changed(ctx);
        ctx.ui.notify(`Failed to show question: ${String(error)}`, "error");
      });
    }
    session.controller.expand();
    hooks.changed(ctx);
  };
  // The single writer of pending records. Persistence is the acknowledgement
  // boundary, not modal construction.
  const persistPending = (toolCallId: string, params: QuestionParams) => {
    const entry: BackgroundPending = { version: 1, kind: "pending", requestId: randomUUID(),
      toolCallId, params, createdAt: Date.now() };
    pi.appendEntry(BACKGROUND_ENTRY_TYPE, entry);
    batches.set(entry.requestId, { pending: entry, delivered: false });
    return entry.requestId;
  };
  const autoShow = (ctx: ExtensionContext) => {
    if (shown() || hooks.picking()) return;
    const blocking = hooks.blocking();
    if (blocking) {
      if (blocking.state() === "minimized") blocking.expand();
      return;
    }
    const next = batches.get(selected ?? "");
    const batch = next && !next.answered ? next : pending()[0];
    if (batch) show(batch.pending.requestId, ctx);
  };

  return {
    pending, shown, show, minimize,
    batches: () => batches,
    callIds: () => new Set([...batches.values()].map((b) => b.pending.toolCallId)),
    queue(toolCallId: string, params: QuestionParams, ctx: ExtensionContext) {
      persistPending(toolCallId, params);
      autoShow(ctx);
      hooks.changed(ctx);
      return queuedQuestionResult();
    },
    // A blocking call the user moved aside by chatting. Persisted before the
    // caller settles the blocking call, so the tool result never precedes its
    // durable request. Not shown: the user just chose the chat over the form.
    adopt(toolCallId: string, params: QuestionParams, draft: QuestionModalDraft, ctx: ExtensionContext) {
      drafts.set(persistPending(toolCallId, params), draft);
      hooks.changed(ctx);
    },
    park() {
      parked = shown() ? selected : undefined;
      minimize();
    },
    resume(ctx: ExtensionContext) {
      if (!shown() && !hooks.picking() && parked && batches.has(parked) && !batches.get(parked)?.answered) show(parked, ctx);
      parked = undefined;
      hooks.changed(ctx);
    },
    restore(ctx: ExtensionContext) {
      epoch++;
      inFlight.clear();
      if (timer) clearTimeout(timer);
      minimize();
      sessions.clear();
      drafts.clear();
      selected = undefined;
      parked = undefined;
      batches = loadBackgroundBatches(ctx.sessionManager.getBranch());
      hooks.changed(ctx);
      const generation = epoch;
      timer = setTimeout(() => {
        timer = undefined;
        if (stopped || generation !== epoch) return;
        autoShow(ctx);
        deliver(ctx);
      }, 0);
    },
    shutdown() {
      stopped = true;
      epoch++;
      if (timer) clearTimeout(timer);
      minimize();
      sessions.clear();
    },
    // Pi drains queues before normal agent_end; abort can drop queued custom
    // steers without message_end. Forget enqueue evidence, not durable answers.
    ended() { inFlight.clear(); },
    retry(ctx: ExtensionContext) { if (!stopped) deliver(ctx); },
    delivered(answerId: string) { inFlight.delete(answerId); },
  };
}
