// Pure logic for the question tool: result formatting and cursor bounds.
// Functional core — no TUI/IO — so it is unit-testable with node:test.

export type TagColor = "accent" | "success" | "warning" | "error" | "muted";

export interface QuestionOption {
	label: string;
	description?: string;
	tag?: string;
	tagColor?: TagColor;
}

export interface QuestionParams {
	/** Background for the user, shown above the questions; never echoed in results. */
	context?: string;
	questions: { question: string; options: QuestionOption[] }[];
}

// Type alias, not an interface: pi's `ToolResultMessage.details` is gated by
// `IsJsonCompatible<TDetails>`, which requires an implicit index signature.
// Interfaces have none, so an interface here makes every synthetic toolResult
// message carrying these details unassignable to `AgentMessage`.
export type QuestionDetails = {
	questions: { question: string; options: string[] }[];
	answers: string[][];
	notes: (string | null)[];
	cancelled: boolean;
	/** User minimized and answered in chat instead; distinct from `cancelled`. */
	skipped?: boolean;
}

export interface QuestionModalAnswer {
	answers: string[][];
	notes: (string | null)[];
	content: string;
}

/** How a question modal run ended. Functional core for the minimize/skip flow. */
export type QuestionModalOutcome =
	| { kind: "answered"; answer: QuestionModalAnswer }
	| { kind: "cancelled" }
	| { kind: "skipped" };

// The chat message after a skip is not always a reply to the form: a recovered
// question can open while the user submits an unrelated message (index.ts
// before_agent_start gate), so the text asks the agent to read, not to assume.
export const SKIPPED_RESULT_TEXT =
	"Not answered: the user skipped the form and continued in chat. Read their next message.";

// Cancellation only comes from aborts and session teardown, never from a user
// gesture in the dock (Esc minimizes or skips), see modal.ts cancel().
export const CANCELLED_RESULT_TEXT = "Not answered: the run was interrupted.";

export interface QuestionToolResult {
	content: [{ type: "text"; text: string }];
	details: QuestionDetails;
}

export interface BatchResult {
	answers: string[][]; // checked labels per question, original order
	notes: (string | null)[]; // per-question trimmed note, null if empty
	content: string; // agent-facing text, one line per question (note inline)
}

// Build the agent-facing batch result. Per-question selections use the ORIGINAL
// 1-based option index so the agent can map an answer back to the option it
// offered. A single question omits the "Q<n> " prefix (nothing to disambiguate).
// Each question owns its note, appended inline after "|" on that question's line.
export function formatBatchResult(
	questions: { question: string; labels: string[] }[],
	checked: boolean[][],
	notes: string[],
): BatchResult {
	const answers: string[][] = [];
	const outNotes: (string | null)[] = [];
	const lines: string[] = [];
	const multi = questions.length > 1;
	for (let q = 0; q < questions.length; q++) {
		const labels = questions[q].labels;
		const row = checked[q] ?? [];
		const sel: string[] = [];
		const parts: string[] = [];
		for (let i = 0; i < labels.length; i++) {
			if (row[i]) {
				sel.push(labels[i]);
				parts.push(`${i + 1}. ${labels[i]}`);
			}
		}
		answers.push(sel);
		const trimmed = (notes[q] ?? "").trim();
		const note = trimmed.length > 0 ? trimmed : null;
		outNotes.push(note);
		const prefix = multi ? `Q${q + 1} ` : "";
		lines.push(`${prefix}"${questions[q].question}": ${formatSelection(parts, note)}`);
	}
	return { answers, notes: outNotes, content: lines.join("\n") };
}

/** One question's answer as the agent reads it: numbered picks plus the note.
 * Shared by blocking results and background answers (background-state.ts) so
 * both read the same (DRY). */
export function formatSelection(parts: string[], note: string | null): string {
	const selStr = parts.length ? parts.join(", ") : "(no selection)";
	return note !== null ? `${selStr} | note: ${note}` : selStr;
}

// Rows are: option rows 0..optionCount-1, then the note row at index optionCount.
// Functional Core / Imperative Shell: both live execution and session recovery use
// this constructor so their persisted meaning cannot drift apart.
export function formatQuestionResult(
	params: QuestionParams,
	outcome: QuestionModalOutcome,
): QuestionToolResult {
	const questions = params.questions.map((question) => ({
		question: question.question,
		options: question.options.map((option) => option.label),
	}));
	if (outcome.kind === "cancelled") {
		return {
			content: [{ type: "text", text: CANCELLED_RESULT_TEXT }],
			details: {
				questions,
				answers: [],
				notes: [],
				cancelled: true,
			},
		};
	}
	if (outcome.kind === "skipped") {
		// Distinct from cancelled: the user deliberately answered in chat, so the
		// agent must treat the following chat message as the real answer.
		return {
			content: [{ type: "text", text: SKIPPED_RESULT_TEXT }],
			details: {
				questions,
				answers: [],
				notes: [],
				cancelled: false,
				skipped: true,
			},
		};
	}
	return {
		content: [{ type: "text", text: outcome.answer.content }],
		details: {
			questions,
			answers: outcome.answer.answers,
			notes: outcome.answer.notes,
			cancelled: false,
		},
	};
}

/** Result returned when a second `question` call arrives while another question
 * is already pending. `details: undefined` satisfies the SDK type contract
 * (AgentToolResult.details is a required property) while keeping renderResult
 * on the plain-text path instead of an answer summary. */
export function formatBusyQuestionResult(): {
	content: [{ type: "text"; text: string }];
	details: undefined;
} {
	return {
		details: undefined,
		content: [
			{
				type: "text",
				text: "Not asked: another blocking question is still open. Ask again after it is answered, or set blocking:false.",
			},
		],
	};
}

export function clampCursor(cursor: number, optionCount: number): number {
	if (cursor < 0) return 0;
	if (cursor > optionCount) return optionCount;
	return cursor;
}

export function isNoteRow(cursor: number, optionCount: number): boolean {
	return cursor === optionCount;
}

export interface SkipInputEligibility {
	/** The active question modal is minimized according to its run lifecycle,
	 * independent of any disposable dock component. */
	minimized: boolean;
	/** The input event's `source` field. */
	source: string;
	/** Raw submitted text. */
	text: string;
}

/** A chat message skips a pending question only when the modal is minimized and
 * the message is a genuine interactive, non-command, non-empty submission.
 * Extension commands are dispatched before the input event, so a plain
 * "/question" text never reaches this check, but the guard stays as defense in
 * depth against future dispatch-order changes. */
export function isSkipEligibleInput(eligibility: SkipInputEligibility): boolean {
	const text = eligibility.text.trim();
	return (
		eligibility.minimized &&
		eligibility.source === "interactive" &&
		text.length > 0 &&
		!text.startsWith("/")
	);
}

/** What Esc does in a question dock.
 *
 * A minimizable modal hides and hands input back to the chat editor. A modal
 * opened by the recovery GATE is NOT minimizable: pinned pi runs that gate
 * inside `session.prompt()`, where `onInputCallback` is cleared and streaming
 * has not started, so a submitted message lands in `pendingUserInputs` without
 * firing the input event and extension commands cannot be dispatched. A hidden
 * gate modal would therefore capture no input at all and wedge the session, so
 * Esc resolves it as skipped instead — exact, because the prompt the user
 * already submitted IS the continuation. */
export function escapeAction(minimizable: boolean): "minimize" | "skip" {
	return minimizable ? "minimize" : "skip";
}

/** Whether a shutdown must settle an open question modal.
 *
 * Runtime replacement ("new"/"resume"/"fork") and "reload" tear the old runtime
 * down deterministically — pinned pi aborts and then awaits idle — so a modal
 * left pending there would block the teardown.
 *
 * "quit" is different: nothing awaits the modal, so cancelling only starts a
 * race between agent-core persisting a "cancelled" tool result and the process
 * exiting. That race would decide by luck whether the question is re-asked on
 * the next start, and quitting is not cancelling anyway. Leaving the call
 * dangling is both truthful and deterministic: session recovery re-opens it. */
export function shouldSettleModalOnShutdown(reason: string): boolean {
	return reason !== "quit";
}

export interface OutcomeLatch<T> {
	promise: Promise<T>;
	readonly settled: boolean;
	settle(value: T): void;
}

/** First-settled-wins latch. The modal's own keys, an external skip and an abort
 * all race for the same run: every caller may settle again harmlessly and all
 * awaiters observe the first value. */
export function createOutcomeLatch<T>(): OutcomeLatch<T> {
	let resolve!: (value: T) => void;
	let settled = false;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return {
		promise,
		get settled() {
			return settled;
		},
		settle(value: T) {
			if (settled) return;
			settled = true;
			resolve(value);
		},
	};
}
