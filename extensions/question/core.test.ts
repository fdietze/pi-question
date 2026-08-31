import { test } from "node:test";
import assert from "node:assert/strict";
import {
	clampCursor,
	createOutcomeLatch,
	escapeAction,
	formatBatchResult,
	formatBusyQuestionResult,
	formatQuestionResult,
	isNoteRow,
	isSkipEligibleInput,
	type QuestionModalOutcome,
	shouldSettleModalOnShutdown,
	SKIPPED_RESULT_TEXT,
} from "./core.ts";

const q = (question: string, labels: string[]) => ({ question, labels });

test("formatBatchResult: multi selected + per-question notes, 1-based indices, note inline", () => {
	const r = formatBatchResult(
		[q("DB?", ["Postgres", "SQLite", "MySQL"]), q("Auth?", ["OAuth", "Password"])],
		[[false, true, false], [true, false]],
		["  managed  ", ""],
	);
	assert.deepEqual(r.answers, [["SQLite"], ["OAuth"]]);
	assert.deepEqual(r.notes, ["managed", null]);
	assert.equal(r.content, 'Q1 "DB?": 2. SQLite | note: managed\nQ2 "Auth?": 1. OAuth');
});

test("formatBatchResult: a question with no selection but a note (single omits Q-prefix)", () => {
	const r = formatBatchResult([q("DB?", ["A", "B"])], [[false, false]], ["later"]);
	assert.deepEqual(r.answers, [[]]);
	assert.deepEqual(r.notes, ["later"]);
	assert.equal(r.content, '"DB?": (no selection) | note: later');
});

test("formatBatchResult: single selected, no note", () => {
	const r = formatBatchResult([q("Ship it?", ["Yes", "No"])], [[true, false]], [""]);
	assert.deepEqual(r.answers, [["Yes"]]);
	assert.deepEqual(r.notes, [null]);
	assert.equal(r.content, '"Ship it?": 1. Yes');
});

test("formatBatchResult: whitespace-only note trims to null", () => {
	const r = formatBatchResult([q("DB?", ["A"])], [[true]], ["   "]);
	assert.deepEqual(r.notes, [null]);
	assert.equal(r.content, '"DB?": 1. A');
});

test("formatQuestionResult: live and recovered answers share the normal result shape", () => {
	const params = {
		questions: [
			{
				question: "Ship it?",
				options: [{ label: "Yes" }, { label: "No" }],
			},
		],
	};
	const answered = {
		kind: "answered" as const,
		answer: {
			answers: [["Yes"]],
			notes: [null],
			content: '"Ship it?": 1. Yes',
		},
	};
	assert.deepEqual(formatQuestionResult(params, answered), {
		content: [{ type: "text", text: '"Ship it?": 1. Yes' }],
		details: {
			questions: [{ question: "Ship it?", options: ["Yes", "No"] }],
			answers: [["Yes"]],
			notes: [null],
			cancelled: false,
		},
	});
});

test("formatQuestionResult: cancellation matches normal tool execution", () => {
	const params = {
		questions: [{ question: "Ship it?", options: [{ label: "Yes" }] }],
	};
	assert.deepEqual(formatQuestionResult(params, { kind: "cancelled" }), {
		content: [{ type: "text", text: "User cancelled the selection" }],
		details: {
			questions: [{ question: "Ship it?", options: ["Yes"] }],
			answers: [],
			notes: [],
			cancelled: true,
		},
	});
});

test("formatQuestionResult: skip is distinct from cancelled and answered", () => {
	const params = {
		questions: [{ question: "Ship it?", options: [{ label: "Yes" }] }],
	};
	const result = formatQuestionResult(params, { kind: "skipped" });
	assert.deepEqual(result, {
		content: [{ type: "text", text: SKIPPED_RESULT_TEXT }],
		details: {
			questions: [{ question: "Ship it?", options: ["Yes"] }],
			answers: [],
			notes: [],
			cancelled: false,
			skipped: true,
		},
	});
	// Not cancelled: the user deliberately answered in chat, and the agent-facing
	// text must say so instead of implying abandonment.
	assert.equal(result.details.cancelled, false);
	assert.equal(result.details.skipped, true);
});

test("formatBusyQuestionResult: explicit rejection text, details undefined", () => {
	const result = formatBusyQuestionResult();
	assert.equal(result.content.length, 1);
	assert.equal(result.content[0].type, "text");
	assert.match(result.content[0].text, /already pending/);
	// `details` must be present (AgentToolResult.details is a required property)
	// but stays undefined, so renderResult falls back to the plain text instead
	// of an answer summary over empty selections.
	assert.equal("details" in result, true);
	assert.equal(result.details, undefined);
});

test("clampCursor: valid rows are 0..optionCount inclusive (note row = optionCount)", () => {
	assert.equal(clampCursor(-1, 3), 0);
	assert.equal(clampCursor(5, 3), 3);
	assert.equal(clampCursor(2, 3), 2);
});

test("isNoteRow: true only at index optionCount", () => {
	assert.equal(isNoteRow(3, 3), true);
	assert.equal(isNoteRow(2, 3), false);
	assert.equal(isNoteRow(0, 0), true);
});

test("isSkipEligibleInput: only interactive non-command text while minimized", () => {
	const base = { minimized: true, source: "interactive", text: "use sqlite" };
	assert.equal(isSkipEligibleInput(base), true);
	// Shown modal: the dock owns input, so a submission can only be synthetic.
	assert.equal(isSkipEligibleInput({ ...base, minimized: false }), false);
	// Extension-injected messages (redelivery, sendUserMessage) must not skip.
	assert.equal(isSkipEligibleInput({ ...base, source: "extension" }), false);
	assert.equal(isSkipEligibleInput({ ...base, source: "rpc" }), false);
	// Commands and empty submissions never skip.
	assert.equal(isSkipEligibleInput({ ...base, text: "/question" }), false);
	assert.equal(isSkipEligibleInput({ ...base, text: "  " }), false);
	assert.equal(isSkipEligibleInput({ ...base, text: "" }), false);
	// Leading whitespace before a slash is still a command.
	assert.equal(isSkipEligibleInput({ ...base, text: "  /model" }), false);
});

test("escapeAction: live and idle modals minimize, gate-opened modals skip", () => {
	// Live tool calls and idle auto-show run while pi dispatches editor input,
	// so minimizing the dock is safe and reversible via /question.
	assert.equal(escapeAction(true), "minimize");
	// The recovery gate awaits inside session.prompt(): a hidden modal there
	// would capture no input and wedge the session, so Esc must resolve it.
	assert.equal(escapeAction(false), "skip");
});

test("shouldSettleModalOnShutdown: quit stays recoverable, replacement settles", () => {
	// Ctrl+D/SIGTERM quit: nothing awaits the modal, so settling would only race
	// process exit over persisting a tool result the user never asked for. The
	// call must stay dangling so the next start recovers the question.
	assert.equal(shouldSettleModalOnShutdown("quit"), false);
	// Reload and session replacement abort and then await idle, so an unsettled
	// modal would block the teardown.
	for (const reason of ["reload", "new", "resume", "fork"]) {
		assert.equal(shouldSettleModalOnShutdown(reason), true);
	}
});

test("createOutcomeLatch: first outcome wins for every awaiter", async () => {
	const latch = createOutcomeLatch<QuestionModalOutcome>();
	assert.equal(latch.settled, false);
	latch.settle({ kind: "skipped" });
	assert.equal(latch.settled, true);
	// A racing Enter-submit after the skip must not overwrite the outcome.
	latch.settle({
		kind: "answered",
		answer: { answers: [["Yes"]], notes: [null], content: "x" },
	});
	assert.deepEqual(await latch.promise, { kind: "skipped" });
});

test("createOutcomeLatch: abort settles cancelled exactly once", async () => {
	const latch = createOutcomeLatch<QuestionModalOutcome>();
	// Tool AbortSignal / session shutdown path: cancelled, never skipped, so the
	// interrupted-call semantics of a torn-down modal stay unchanged.
	latch.settle({ kind: "cancelled" });
	latch.settle({ kind: "skipped" });
	assert.deepEqual(await latch.promise, { kind: "cancelled" });
	assert.equal(latch.settled, true);
	// The result built from that outcome is the pre-existing cancellation shape.
	const params = {
		questions: [{ question: "Ship it?", options: [{ label: "Yes" }] }],
	};
	assert.equal(
		formatQuestionResult(params, await latch.promise).details.cancelled,
		true,
	);
});
