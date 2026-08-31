/**
 * Question Tool — ask one OR several questions in a single call. Each question
 * is multi-select checkboxes; one global free-form note applies to the whole
 * batch. The custom UI occupies pi's bottom dock below the transcript.
 *
 * Batch (≥2 questions): master-detail. A count banner + a list of ALL questions
 * (with a ">" marker on the active one and a ○/✓ answered indicator) sits on top;
 * below a thin divider, ONLY the active question's options AND its own note are
 * shown, swapping as you Tab between questions (each question owns its note).
 * Tab/Shift+Tab switch question; ↑/↓ move within the active question's option
 * rows + note; Space toggles; typing forwards to the note (focus jumps there if
 * text changed). Enter advances to the next question (auto-accepting the
 * focused option first if that question is unchecked and the cursor is on an
 * option row) and resets the cursor to the top of the next question; on the
 * last question, Enter submits the whole batch. Enter never wraps past the
 * end — Tab does. Esc MINIMIZES the dock: the chat editor regains input, a
 * one-line indicator widget appears, `/question` creates a fresh presentation
 * from the same draft, and submitting a chat message resolves the question as
 * skipped so the message itself reaches the agent. There is no cancel key.
 * A modal opened by the recovery GATE is the one exception: pi dispatches no
 * editor input while that gate awaits, so Esc resolves it as skipped right
 * away (the already-submitted prompt is the continuation) and no indicator is
 * shown. Abort and shutdown settle any modal as cancelled.
 *
 * Single question: the banner/list/marker are omitted, so it renders exactly
 * like a plain one-question prompt (question text, options, note).
 *
 * An option may carry a short `tag` rendered as a semantic-colored pill before
 * its label (e.g. "recommended"). All text wraps to terminal width.
 * Pure result/cursor/skip logic lives in ./core.ts (unit-tested).
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  formatBusyQuestionResult,
  isSkipEligibleInput,
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

const OptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(
    Type.String({ description: "Optional description shown below label" }),
  ),
  tag: Type.Optional(
    Type.String({
      description:
        'Short one-word badge shown before the label, e.g. "recommended". Use to flag a preferred option; list tagged options first.',
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
          'Semantic color of the `tag` pill (default "accent"): success = safe/green, warning = caution/yellow, error = danger/red, muted = low-priority/grey.',
      },
    ),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  options: Type.Array(OptionSchema, {
    description: "Options for the user to choose from",
  }),
});

const QuestionParamsSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description:
      "One or more questions to ask at once. Batch several independent clarifications into a single call to gather more per round-trip. Each question is its own multi-select list; the user answers them all together with one shared free-form note.",
  }),
});

const PENDING_WIDGET_KEY = "question-pending";
const PENDING_WIDGET_TEXT =
  "? question pending · /question to answer · sending a message skips";

// One non-interactive indicator line above the chat input, shown only while the
// active question dock is minimized. Width-safe: pi passes the render width,
// so the line truncates on narrow terminals instead of wrapping.
const showPendingWidget = (ctx: ExtensionContext) => {
  ctx.ui.setWidget(PENDING_WIDGET_KEY, (_tui, theme) => ({
    render: (width: number) => [
      truncateToWidth(theme.fg("accent", PENDING_WIDGET_TEXT), width),
    ],
    invalidate: () => {},
  }));
};

const clearPendingWidget = (ctx: ExtensionContext) => {
  ctx.ui.setWidget(PENDING_WIDGET_KEY, undefined);
};

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
   * Durability boundary for an external skip. Live: resolves once the tool
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
        const opened = openQuestionModal(ctx, action.params, {
          minimizable: options.minimizable,
          onStateChange: (state) => {
            if (state === "minimized") showPendingWidget(ctx);
            else clearPendingWidget(ctx);
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
          finished: recoveryFinished,
        };
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
        if (openingShouldSendContinuation) {
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
        if (session) clearPendingWidget(ctx);
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

  pi.on("context", (event) => {
    if (recoveries.size === 0) return;
    const messages = repairQuestionContext(event.messages, recoveries.values());
    if (messages.length === event.messages.length) return;
    return { messages };
  });

  pi.on("session_tree", (_event, ctx) => {
    refreshRecoveries(ctx.sessionManager.getBranch());
  });

  pi.on("session_shutdown", (event, ctx) => {
    runtimeActive = false;
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
    clearPendingWidget(ctx);
  });

  // A normal chat submission while the active question is minimized resolves it
  // as skipped and then flows through unchanged. The handler returns nothing,
  // so pi queues/steers the original text exactly as if no question existed.
  pi.on("input", async (event) => {
    const current = active;
    if (!current) return;
    if (
      !isSkipEligibleInput({
        minimized: current.controller.state() === "minimized",
        source: event.source,
        text: event.text,
      })
    ) {
      return;
    }
    current.suppressContinuation();
    current.controller.skip();
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
      if (!active) {
        ctx.ui.notify("No question is pending.", "info");
        return;
      }
      // A shown dock already owns input; expanding is only meaningful when
      // minimized. The persistent draft initializes a fresh component.
      if (active.controller.state() === "minimized") {
        active.controller.expand();
      }
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
      "Ask the user one or more questions whenever you need their input. Prefer this over asking in plain text. Include an executive summary, assuming the user did not read the whole conversation. Prefer orthogonal questions and options. Pass several questions at once to gather more information per round-trip; each is multi-select checkboxes and the batch shares one free-form note. When you have a recommendation, tag the recommended option(s) and list them first.",
    parameters: QuestionParamsSchema,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // One question at a time: a second call is rejected deterministically
      // instead of silently replacing the active modal's controller.
      if (active) {
        return formatBusyQuestionResult();
      }

      const session = openQuestionModal(ctx, params, {
        onStateChange: (state) => {
          if (state === "minimized") showPendingWidget(ctx);
          else clearPendingWidget(ctx);
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
        clearPendingWidget(ctx);
        resolveFinished();
      };
      active = {
        controller: session.controller,
        // Live tool calls need no continuation suppression: the agent core
        // persists the real tool result, and the skipped outcome already tells
        // the agent the user answered in chat.
        suppressContinuation: () => {},
        finished,
      };

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
