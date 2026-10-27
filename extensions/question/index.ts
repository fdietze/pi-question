// Pi integration: one blocking call plus durable, independently answerable
// background batches. All batches share one dock and pending-count widget.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createBackgroundQuestions } from "./background-questions.ts";
import {
  ANSWER_MESSAGE_TYPE, DISCARDED_ANSWER_MESSAGE_TYPE, filterBackgroundAnswers, isAssociatedAnswer,
  loadBackgroundBatches, repairBackgroundReceipts,
} from "./background-state.ts";
import {
  formatBusyQuestionResult,
  isChatYieldInput,
  shouldSettleModalOnShutdown,
  type QuestionDetails,
  type TagColor,
} from "./core.ts";
import {
  openQuestionModal,
  type QuestionModalController,
  type QuestionModalSession,
} from "./modal.ts";
import {
  createQuestionRecovery,
  loadQuestionRecoveries,
  isStartupPresentation,
  QUESTION_RECOVERY_ENTRY_TYPE,
  repairQuestionContext,
  selectRecoveryGate,
  selectStartupRecovery,
  type QuestionRecoveryRecord,
  type RecoveryModalAction,
} from "./recovery.ts";

interface OptionWithDesc {
  label: string;
  description?: string;
  tag?: string;
  tagColor?: TagColor;
}

// Agent-facing wording: each fact lives in exactly one description (DRY), so
// the tool description says when to ask and the parameters say how it works.
const OptionSchema = Type.Object({
  label: Type.String({ description: "Short option text." }),
  description: Type.Optional(
    Type.String({ description: "Detail shown below the label." }),
  ),
  tag: Type.Optional(
    Type.String({
      description:
        'One-word badge shown before the label, e.g. "recommended" or "risky".',
    }),
  ),
  tagColor: Type.Optional(
    Type.Union(
      [
        Type.Literal("accent"),
        Type.Literal("success"),
        Type.Literal("warning"),
        Type.Literal("error"),
        Type.Literal("muted"),
      ],
      {
        description:
          'Badge color (default "accent"): success = safe, warning = caution, error = danger, muted = low priority.',
      },
    ),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({
    description: "The question. Keep it short; put shared background in context.",
  }),
  options: Type.Array(OptionSchema, {
    // The Enter default is the focused option, which starts on the first one
    // (modal-component.ts), so the recommendation must come first.
    description:
      'Choices for this question. When you have a recommendation, put it first and tag it "recommended": the first option is the default when the user just presses Enter.',
  }),
});

const QuestionParamsSchema = Type.Object({
  context: Type.Optional(Type.String({
    description: "What you are working on and why you ask, in 1-3 sentences. Shown above the questions.",
  })),
  blocking: Type.Optional(Type.Boolean({
    description: "true (default): wait for the answer. false: queue the questions and keep working; the answer arrives later as a separate message.",
  })),
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    description:
      'Questions whose answers do not depend on each other; the user answers them together. Each question is multi-select; write "pick one" in the question when only one answer fits. Each question has its own free-text note for the user.',
  }),
});

const PENDING_WIDGET_KEY = "question-pending";
/** The one question (live tool call or recovered) whose modal may be open. */
interface ActiveQuestion {
  controller: QuestionModalController;
  /**
   * Recovery only: ensures the recovery operation sends no continuation user
   * message, because the chat message that triggers the skip IS the
   * continuation. Live calls have nothing to suppress.
   */
  suppressContinuation(): void;
  /**
   * The user sent a chat message while this question was minimized. Live:
   * the question moves to a background batch. Recovery: it is skipped.
   */
  yieldToChat(): void;
  /**
   * Durability boundary for yielding to chat. Live: resolves once the tool
   * execute call returned (its tool result is produced). Recovery: resolves
   * once the recovery operation finished (marker appended or failure
   * reported).
   */
  finished: Promise<void>;
}

export default function question(pi: ExtensionAPI) {
  let recoveries = new Map<string, QuestionRecoveryRecord>();
  let active: ActiveQuestion | undefined;
  let openingRecoveryId: string | undefined;
  let openingRecoveryPromise: Promise<void> | undefined;
  let openingShouldSendContinuation = false;
  let presentationTimer: ReturnType<typeof setTimeout> | undefined;
  let presentationEnabled = false;
  let runtimeActive = true;
  let pickerController: AbortController | undefined;
  const dismissPicker = () => {
    pickerController?.abort();
    pickerController = undefined;
  };
  const backgrounds = createBackgroundQuestions(pi, {
    blocking: () => active?.controller,
    picking: () => pickerController !== undefined,
    changed: (ctx) => updatePendingWidget(ctx),
  });
  const updatePendingWidget = (ctx: ExtensionContext) => {
    const count = backgrounds.pending().length + (active ? 1 : 0);
    const minimized = active?.controller.state() === "minimized" ||
      (!active && !backgrounds.shown());
    if (count === 0 || (count === 1 && !minimized)) {
      ctx.ui.setWidget(PENDING_WIDGET_KEY, undefined);
      return;
    }
    const text = `? ${count} question batch${count === 1 ? "" : "es"} pending · /question to answer${active?.controller.state() === "minimized" ? " · chatting moves the blocking one to background" : ""}`;
    ctx.ui.setWidget(PENDING_WIDGET_KEY, (_tui, theme) => ({
      render: (width: number) => [truncateToWidth(theme.fg("accent", text), width)],
      invalidate: () => {},
    }));
  };


  const refreshRecoveries = (branch: readonly unknown[]) => {
    const loaded = loadQuestionRecoveries(branch);
    recoveries = new Map(
      [...loaded].map(([toolCallId, recovery]) => [
        toolCallId,
        recovery.record,
      ]),
    );
    return loaded;
  };

  const resolveQuestion = (
    action: RecoveryModalAction,
    ctx: ExtensionContext,
    options: { minimizable: boolean; sendContinuation: boolean },
  ): Promise<void> => {
    if (openingRecoveryId !== undefined && openingRecoveryPromise) {
      return openingRecoveryPromise;
    }
    openingRecoveryId = action.call.toolCallId;
    openingShouldSendContinuation = options.sendContinuation;
    let resolveRecoveryFinished!: () => void;
    // The input-skip handler awaits this so its chat message is only delivered
    // after the durable recovery marker exists.
    const recoveryFinished = new Promise<void>((resolve) => {
      resolveRecoveryFinished = resolve;
    });
    const operation = (async () => {
      let session: QuestionModalSession | undefined;
      try {
        // Known residual (pre-existing on master): pi's session replacement resets
        // extension UI without completing this modal, so the promise can outlive it.
        dismissPicker();
        backgrounds.park();
        const opened = openQuestionModal(ctx, action.params, {
          minimizable: options.minimizable,
          onStateChange: () => {
            updatePendingWidget(ctx);
          },
        });
        session = opened;
        active = {
          controller: opened.controller,
          // The chat message that skips a recovered question is its own
          // continuation, so the operation must not inject another user message.
          suppressContinuation: () => {
            openingShouldSendContinuation = false;
          },
          // Recovered results live in question-recovery-v1 records; skipping
          // keeps them out of the background ledger (YAGNI: rare path).
          yieldToChat: () => {
            openingShouldSendContinuation = false;
            opened.controller.skip();
          },
          finished: recoveryFinished,
        };
        updatePendingWidget(ctx);
        const { result } = await opened.completion;
        if (!runtimeActive) {
          throw new Error("Question recovery stopped with the session");
        }

        // A programmatic branch change can happen while the modal owns the TUI.
        // Persist only when this call is still the active recoverable question.
        const currentBranch = ctx.sessionManager.getBranch();
        const currentLoaded = refreshRecoveries(currentBranch);
        const currentAction = selectRecoveryGate(
          ctx.sessionManager.buildContextEntries(),
          currentLoaded,
          ctx.mode,
          backgrounds.callIds(),
        );
        if (currentAction?.call.toolCallId !== action.call.toolCallId) {
          ctx.ui.notify(
            "Discarded a recovered question answer: the conversation moved on while it was open.",
            "warning",
          );
          return;
        }

        const recovery = createQuestionRecovery(
          action.call.toolCallId,
          result,
          Date.now(),
        );

        // First Principles: persistence and provider repair must exist before an
        // idle recovery creates its continuation turn.
        pi.appendEntry(QUESTION_RECOVERY_ENTRY_TYPE, recovery);
        recoveries.set(recovery.toolCallId, recovery);
        // A dismissal never wakes the agent (see selectStartupRecovery).
        if (openingShouldSendContinuation && !result.details.dismissed) {
          pi.sendUserMessage(recovery.userMessage);
        }
      } catch (error) {
        if (runtimeActive) {
          try {
            ctx.ui.notify(
              `Failed to recover question: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          } catch {
            // The detached presentation task can outlive a closing terminal.
          }
        }
        throw error;
      } finally {
        if (session && active?.controller === session.controller) {
          active = undefined;
        }
        if (session && runtimeActive) backgrounds.resume(ctx);
        openingRecoveryId = undefined;
        openingRecoveryPromise = undefined;
        openingShouldSendContinuation = false;
        resolveRecoveryFinished();
      }
    })();
    openingRecoveryPromise = operation;
    return operation;
  };

  const clearPresentationTimer = () => {
    if (presentationTimer !== undefined) clearTimeout(presentationTimer);
    presentationTimer = undefined;
  };

  pi.on("context", (event, ctx) => {
    const batches = loadBackgroundBatches(ctx.sessionManager.getBranch());
    const filtered = filterBackgroundAnswers(event.messages, batches);
    const repaired = repairBackgroundReceipts(filtered, batches.values());
    return { messages: repairQuestionContext(repaired, recoveries.values()) };
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "custom" || message.customType !== ANSWER_MESSAGE_TYPE) return;
    const batches = loadBackgroundBatches(ctx.sessionManager.getBranch());
    const answerId = (message.details as { answerId?: string } | undefined)?.answerId;
    if (answerId) backgrounds.delivered(answerId);
    const requestId = (message.details as { requestId?: string } | undefined)?.requestId;
    if (!isAssociatedAnswer(message, batches) ||
      (requestId !== undefined && batches.get(requestId)?.delivered)) {
      // Queues survive /tree and stop. Same-role replacement removes abandoned
      // answer text before persistence/render; context also drops the tombstone.
      return { message: { ...message, customType: DISCARDED_ANSWER_MESSAGE_TYPE,
        content: [], display: false } };
    }
  });

  pi.on("agent_end", () => backgrounds.ended());
  pi.on("agent_start", (_event, ctx) => backgrounds.retry(ctx));

  pi.on("session_tree", (_event, ctx) => {
    dismissPicker();
    // Close the old branch's blocking presentation without recording an answer.
    active?.suppressContinuation();
    active?.controller.cancel();
    refreshRecoveries(ctx.sessionManager.getBranch());
    backgrounds.restore(ctx);
  });

  pi.on("session_shutdown", (event, ctx) => {
    runtimeActive = false;
    dismissPicker();
    presentationEnabled = false;
    clearPresentationTimer();
    // Replacement and reload await idle, so an open modal must settle there or
    // it blocks the teardown; cancellation (not skip) keeps the pre-existing
    // interrupted path, and runtimeActive is already false so the recovery
    // operation aborts instead of persisting a marker. On "quit" nothing awaits
    // the modal: settling would only race process exit for a tool result the
    // user never asked for, so the call stays dangling and is recovered on the
    // next start.
    if (shouldSettleModalOnShutdown(event.reason)) {
      active?.controller.cancel();
    }
    backgrounds.shutdown();
    ctx.ui.setWidget(PENDING_WIDGET_KEY, undefined);
  });

  // A normal chat submission while the active question is minimized yields the
  // question to the chat (see ActiveQuestion.yieldToChat) and then flows through
  // unchanged. The handler returns nothing, so pi queues/steers the original
  // text exactly as if no question existed.
  pi.on("input", async (event) => {
    const current = active;
    if (!current) return;
    if (
      !isChatYieldInput({
        minimized: current.controller.state() === "minimized",
        source: event.source,
        text: event.text,
      })
    ) {
      return;
    }
    current.yieldToChat();
    // Await the durability boundary before letting the message flow: live —
    // the tool result exists; recovery — the marker entry is appended. Pinned
    // pi queues the steer only after input handlers return, and agent-core
    // delivers steered messages after the current tool batch, so the real
    // toolResult always precedes the chat message in provider context.
    await current.finished;
  });

  pi.registerCommand("question", {
    description: "Expand the pending question overlay",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (pickerController) return;
      const blocking = active;
      const pending = backgrounds.pending();
      if (!blocking && pending.length === 0) {
        ctx.ui.notify("No question is pending.", "info");
        return;
      }
      if ((blocking ? 1 : 0) + pending.length === 1) {
        if (blocking) blocking.controller.expand();
        else backgrounds.show(pending[0].pending.requestId, ctx);
        return;
      }
      const picker = new AbortController();
      pickerController = picker;
      blocking?.controller.minimize();
      backgrounds.minimize();
      const choices = [
        ...(blocking ? [{ label: "Blocking question (agent waiting)", id: undefined }] : []),
        ...pending.map((batch, i) => ({
          label: `${i + 1}. ${batch.pending.params.questions[0]?.question ?? "Question"}`,
          id: batch.pending.requestId,
        })),
      ];
      let choice: string | undefined;
      try {
        choice = await ctx.ui.select("Pending question batches", choices.map((c) => c.label), { signal: picker.signal });
      } finally {
        if (pickerController === picker) pickerController = undefined;
      }
      if (!runtimeActive || picker.signal.aborted || !choice) return;
      const selected = choices.find((c) => c.label === choice);
      if (selected?.id) backgrounds.show(selected.id, ctx);
      else if (active === blocking) blocking?.controller.expand();
    },
  });

  // Inversion: provider-bound turns wait for recovery instead of racing an idle
  // presentation callback that may not have run yet.
  // Gate eligibility follows the recoverable question itself, not the session_start
  // reason, so forked, new, and reloaded runtimes still block a turn that would
  // otherwise let the provider close the question with a placeholder result.
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!runtimeActive || ctx.sessionManager.getSessionFile() === undefined) return;
    clearPresentationTimer();
    while (runtimeActive) {
      const branch = ctx.sessionManager.getBranch();
      const loaded = refreshRecoveries(branch);
      const action = selectRecoveryGate(
        ctx.sessionManager.buildContextEntries(),
        loaded,
        ctx.mode,
        backgrounds.callIds(),
      );
      if (!action) return;

      // A submitted prompt takes ownership of any presentation modal. Its own turn
      // is the continuation, so the shared operation must not start a nested prompt.
      if (openingRecoveryPromise) {
        openingShouldSendContinuation = false;
        try {
          await openingRecoveryPromise;
        } catch {
          // Recovery already reported the failure. Let the turn proceed: pinned
          // transformMessages then closes the unanswered call with "No result
          // provided", which is truthful because nothing was persisted.
          return;
        }
        continue;
      }

      try {
        // The submitted prompt already supplies continuation, so sending another user
        // message here would start a nested prompt before _runAgentPrompt marks streaming.
        // Not minimizable: pinned pi processes no editor input while this gate
        // awaits inside session.prompt(), so a hidden modal would wedge the
        // session. Esc resolves it as skipped instead.
        await resolveQuestion(action, ctx, {
          minimizable: false,
          sendContinuation: false,
        });
      } catch {
        return;
      }
    }
  });

  pi.on("session_start", (event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const loaded = refreshRecoveries(branch);
    backgrounds.restore(ctx);
    presentationEnabled = isStartupPresentation(
      event.reason,
      ctx.sessionManager.getSessionFile(),
    );
    clearPresentationTimer();
    if (!presentationEnabled) return;

    const initialAction = selectStartupRecovery(
      ctx.sessionManager.buildContextEntries(),
      branch,
      loaded,
      backgrounds.callIds(),
    );
    if (
      initialAction.kind === "none" ||
      (initialAction.kind === "modal" && ctx.mode !== "tui")
    ) {
      return;
    }

    // resources_discover still runs before InteractiveMode renders restored
    // messages, so a timer is the public API's presentation-only idle fallback.
    presentationTimer = setTimeout(() => {
      presentationTimer = undefined;
      if (
        !runtimeActive ||
        !presentationEnabled ||
        openingRecoveryId !== undefined ||
        openingRecoveryPromise
      ) {
        return;
      }
      const currentBranch = ctx.sessionManager.getBranch();
      const currentLoaded = refreshRecoveries(currentBranch);
      const action = selectStartupRecovery(
        ctx.sessionManager.buildContextEntries(),
        currentBranch,
        currentLoaded,
        backgrounds.callIds(),
      );
      if (action.kind === "redeliver") {
        pi.sendUserMessage(action.recovery.record.userMessage);
      } else if (action.kind === "modal" && ctx.mode === "tui") {
        // Idle auto-show: the agent is not running, the editor owns input, so
        // this modal minimizes and type-to-skip works normally.
        void resolveQuestion(action, ctx, {
          minimizable: true,
          sendContinuation: true,
        }).catch(() => {
          // Detached presentation reports its own error; no provider turn is waiting.
        });
      }
    }, 0);
  });

  pi.registerTool({
    name: "question",
    label: "Question",
    description:
      "Ask the user to decide or clarify something you need to continue well. Use plain text for reports, status updates and open-ended discussion. Put all questions of one round into one call. Make at most one blocking call at a time. Write context, questions and options so the user can answer without reading the chat. Set blocking:false when you can keep working without the answer.",
    parameters: QuestionParamsSchema,

    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (params.blocking === false && ctx.mode === "tui") {
        return backgrounds.queue(toolCallId, params, ctx);
      }
      // One question at a time: a second call is rejected deterministically
      // instead of silently replacing the active modal's controller.
      if (active) {
        return formatBusyQuestionResult();
      }

      if (ctx.mode === "tui") {
        dismissPicker();
        backgrounds.park();
      }
      const session = openQuestionModal(ctx, params, {
        onStateChange: () => {
          updatePendingWidget(ctx);
        },
      });

      if (ctx.mode !== "tui") {
        // Non-TUI sessions never open a dock, so nothing can minimize or skip;
        // the no-UI result flows out unchanged.
        const run = await session.completion;
        return run.result;
      }

      let resolveFinished!: () => void;
      // Resolves when this tool call fully returned — the boundary the input
      // skip handler awaits so the real tool result exists before the chat
      // message is queued.
      const finished = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });
      const settleActive = () => {
        if (active?.controller === session.controller) {
          active = undefined;
        }
        if (runtimeActive) backgrounds.resume(ctx);
        resolveFinished();
      };
      active = {
        controller: session.controller,
        // Live tool calls need no continuation suppression: the agent core
        // persists the real tool result.
        suppressContinuation: () => {},
        // The pending record is appended synchronously here, while the tool
        // result only exists after the completion promise resumes execute, so
        // the durable request always precedes its acknowledgement.
        yieldToChat: () => {
          if (session.controller.background()) {
            backgrounds.adopt(toolCallId, params, session.draft, ctx);
          }
        },
        finished,
      };
      updatePendingWidget(ctx);

      // Honor the tool's abort signal (Esc interrupt, /new, /fork, /resume):
      // without this the run would keep awaiting a modal the user can no longer
      // reach, leaving the session streaming and waitForIdle blocked.
      const onAbort = () => session.controller.cancel();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();

      try {
        const run = await session.completion;
        return run.result;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        settleActive();
      }
    },

    // Header (always shown): single → the question; batch → "N questions" + the first.
    renderCall(args, theme, _context) {
      const qs = Array.isArray(args.questions) ? args.questions : [];
      const title = theme.fg("toolTitle", theme.bold("question "));
      if (qs.length <= 1) {
        return new Text(title + theme.fg("muted", qs[0]?.question ?? ""), 0, 0);
      }
      return new Text(
        title +
          theme.fg("accent", `${qs.length} questions `) +
          theme.fg("muted", qs[0]?.question ?? ""),
        0,
        0,
      );
    },

    // Body under the header. Collapsed: one compact line per question
    // (✓/○ question → selected labels · note). Expanded: each question with its
    // full checkbox rows (reflecting picks) + descriptions/tag pills, then its note.
    renderResult(result, options, theme, context) {
      const details = result.details as QuestionDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }
      if (details.dismissed) {
        return new Text(theme.fg("muted", "Dismissed"), 0, 0);
      }
      if (details.backgrounded) {
        return new Text(
          theme.fg("muted", "Moved to background — responded in chat"),
          0,
          0,
        );
      }
      if (details.skipped) {
        // Distinct from answered and cancelled: the user minimized and answered
        // in chat, so there is no selection to summarize.
        return new Text(
          theme.fg("muted", "Skipped — responded in chat"),
          0,
          0,
        );
      }

      const argQs: { question: string; options: OptionWithDesc[] }[] =
        Array.isArray(context.args?.questions) ? context.args.questions : [];
      const multi = details.questions.length > 1;
      const lines: string[] = [];

      for (let qi = 0; qi < details.questions.length; qi++) {
        const labels = details.questions[qi].options;
        const qtext = details.questions[qi].question;
        const selected = details.answers[qi] ?? [];
        const selectedSet = new Set(selected);

        if (options.expanded) {
          const header = multi
            ? theme.fg("accent", `Q${qi + 1}. `) + theme.fg("text", qtext)
            : theme.fg("text", qtext);
          lines.push(header);
          const argOpts = Array.isArray(argQs[qi]?.options)
            ? argQs[qi].options
            : [];
          for (let i = 0; i < labels.length; i++) {
            const o = argOpts[i];
            const isSel = selectedSet.has(labels[i]);
            const rowStyle = (t: string) =>
              isSel ? theme.fg("accent", t) : theme.fg("muted", t);
            const pill = o?.tag
              ? `${theme.inverse(theme.fg(o.tagColor ?? "accent", ` ${o.tag} `))} `
              : "";
            lines.push(
              rowStyle(`${isSel ? "[x]" : "[ ]"} ${i + 1}. `) +
                pill +
                rowStyle(labels[i]),
            );
            // 7-space indent aligns the description under the label ("[x] N. ").
            if (o?.description)
              lines.push(theme.fg("dim", `       ${o.description}`));
          }
          const note = details.notes[qi];
          if (note)
            lines.push(theme.fg("muted", "note: ") + theme.fg("text", note));
          lines.push("");
        } else {
          const glyph = selected.length
            ? theme.fg("success", "✓")
            : theme.fg("muted", "○");
          const prefix = multi ? theme.fg("muted", `${qi + 1}. `) : "";
          const numbered = selected.map((label) => {
            const idx = labels.indexOf(label) + 1;
            return idx > 0 ? `${idx}. ${label}` : label;
          });
          const sel = numbered.length
            ? theme.fg("accent", numbered.join(", "))
            : theme.fg("muted", "(none)");
          const note = details.notes[qi];
          const noteStr = note
            ? theme.fg("muted", " · note: ") + theme.fg("text", note)
            : "";
          lines.push(
            `${glyph} ${prefix}${theme.fg("text", qtext)} → ${sel}${noteStr}`,
          );
        }
      }

      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
