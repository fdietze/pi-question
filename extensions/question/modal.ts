// TUI shell shared by live question execution and interrupted-call recovery.
// Runs in pi's bottom dock so the transcript remains visible and natively
// scrollable. Esc closes only the current disposable presentation and restores
// the editor while the run keeps awaiting the same pending outcome.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createOutcomeLatch,
  formatQuestionResult,
  type QuestionDetails,
  type QuestionModalOutcome,
  type QuestionParams,
  type QuestionToolResult,
} from "./core.ts";
import {
  createQuestionModalComponent,
  createQuestionModalDraft,
} from "./modal-component.ts";
import { QuestionPresentationLifecycle } from "./presentation-lifecycle.ts";

const MINIMIZED = { kind: "minimized" } as const;
type QuestionPresentationResult = QuestionModalOutcome | typeof MINIMIZED;

export type QuestionModalState = "shown" | "minimized";

/** External control surface for the one active question modal. */
export interface QuestionModalController {
  /** Latched state of this run, independent of disposable presentations. */
  state(): QuestionModalState;
  /** Close the dock presentation and hand input back to the chat editor. */
  minimize(): void;
  /** Create a fresh dock component from the persistent draft. */
  expand(): void;
  /** Resolve as skipped (the user answered in chat). Idempotent. */
  skip(): void;
  /** Resolve as cancelled — abort or shutdown, never a user gesture. Keeps the
   * pre-existing interrupted/error path and lets an aborted turn finalize
   * promptly instead of waiting for a modal nobody can reach. Idempotent. */
  cancel(): void;
}

export interface QuestionModalRun {
  outcome: QuestionModalOutcome;
  result: QuestionToolResult;
}

export interface QuestionModalSession {
  controller: QuestionModalController;
  /** Settles when the run ends (answer, skip, cancel or presentation failure). */
  completion: Promise<QuestionModalRun>;
}

export interface QuestionModalOptions {
  /** Esc minimizes (default true). The recovery gate passes false. */
  minimizable?: boolean;
  /** Fires on minimize/expand. A non-minimizable modal never reports
   * "minimized", so gate modals show no pending indicator. */
  onStateChange?: (state: QuestionModalState) => void;
}

/**
 * Opens the question dock. Returns synchronously so the caller can register
 * the controller as the active question BEFORE awaiting; `completion` settles
 * with the outcome and the formatted tool result.
 */
export function openQuestionModal(
  ctx: ExtensionContext,
  params: QuestionParams,
  options: QuestionModalOptions = {},
): QuestionModalSession {
  // Labels-only view for the details struct / renderResult (`options` = labels).
  const detailQuestions = params.questions.map((q) => ({
    question: q.question,
    options: q.options.map((o) => o.label),
  }));
  // Same data reshaped for the pure core formatter, which reads `labels`.
  const coreQuestions = detailQuestions.map((q) => ({
    question: q.question,
    labels: q.options,
  }));

  if (ctx.mode !== "tui") {
    // No dock exists here, so nothing can minimize, skip or abort it: the
    // no-UI error result keeps its previous shape and meaning.
    const outcome: QuestionModalOutcome = { kind: "cancelled" };
    return {
      controller: {
        state: () => "shown",
        minimize: () => {},
        expand: () => {},
        skip: () => {},
        cancel: () => {},
      },
      completion: Promise.resolve({
        outcome,
        result: {
          content: [
            {
              type: "text",
              text: "Error: UI not available (running in non-interactive mode)",
            },
          ],
          details: {
            questions: detailQuestions,
            answers: [],
            notes: [],
            cancelled: true,
          } as QuestionDetails,
        },
      }),
    };
  }

  const minimizable = options.minimizable ?? true;
  const latch = createOutcomeLatch<QuestionModalOutcome>();
  const lifecycle = new QuestionPresentationLifecycle();
  const draft = createQuestionModalDraft(params);
  let activePresentation:
    | {
        generation: number;
        close(result: QuestionPresentationResult): void;
      }
    | undefined;
  let rejectPresentationFailure!: (error: unknown) => void;
  const presentationFailure = new Promise<never>((_resolve, reject) => {
    rejectPresentationFailure = reject;
  });

  const closePresentation = (
    result: QuestionPresentationResult,
    generation?: number,
  ) => {
    const presentation = activePresentation;
    if (!presentation) return;
    if (
      generation !== undefined &&
      presentation.generation !== generation
    ) {
      return;
    }
    activePresentation = undefined;
    presentation.close(result);
  };

  const settle = (outcome: QuestionModalOutcome, generation?: number) => {
    if (!lifecycle.settle(generation)) return;
    latch.settle(outcome);
    closePresentation(outcome, generation);
  };

  const minimize = (generation?: number) => {
    if (!minimizable || !lifecycle.minimize(generation)) return;
    closePresentation(MINIMIZED, generation);
    options.onStateChange?.("minimized");
  };

  function present(generation: number) {
    if (!lifecycle.isCurrent(generation)) return;
    const presentation = ctx.ui.custom<QuestionPresentationResult>(
      (tui, theme, _kb, done) => {
        // Each expansion gets fresh Editors. Only plain draft values cross the
        // presentation boundary, keeping pi component ownership simple (SoC).
        activePresentation = { generation, close: done };
        return createQuestionModalComponent(
          tui,
          theme,
          params,
          coreQuestions,
          draft,
          minimizable,
          {
            minimize: () => minimize(generation),
            skip: () => settle({ kind: "skipped" }, generation),
          },
          (outcome) => settle(outcome, generation),
        );
      },
    );

    void presentation.then(
      (result) => {
        if (activePresentation?.generation === generation) {
          activePresentation = undefined;
        }
        // Normally the input/controller transition ran before done(). Keeping
        // this fallback makes unexpected external completion deterministic.
        if (result.kind === "minimized") minimize(generation);
        else settle(result, generation);
      },
      (error: unknown) => {
        if (!lifecycle.settle(generation)) return;
        if (activePresentation?.generation === generation) {
          activePresentation = undefined;
        }
        rejectPresentationFailure(error);
      },
    );
  }

  const controller: QuestionModalController = {
    state: () => lifecycle.state(),
    minimize: () => minimize(),
    expand: () => {
      const generation = lifecycle.show();
      if (generation === undefined) return;
      options.onStateChange?.("shown");
      present(generation);
    },
    skip: () => settle({ kind: "skipped" }),
    cancel: () => settle({ kind: "cancelled" }),
  };

  // Urgency hint: emit BEL so the terminal flags attention when the user has
  // tabbed away. Emitted once per run; expanding again stays silent.
  process.stdout.write("\x07");

  const completion = Promise.race([latch.promise, presentationFailure]).then(
    (outcome) => ({
      outcome,
      result: formatQuestionResult(params, outcome),
    }),
  );

  const initialGeneration = lifecycle.show();
  if (initialGeneration !== undefined) present(initialGeneration);

  return { controller, completion };
}
