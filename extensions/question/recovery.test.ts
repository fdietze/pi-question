import assert from "node:assert/strict";
import { test } from "node:test";
import { formatQuestionResult, shouldSettleModalOnShutdown } from "./core.ts";
import {
	createQuestionRecovery,
	findLatestDanglingQuestionCall,
	formatRecoveredUserMessage,
	isRecoveryContinuationComplete,
	isReplayableAssistant,
	isStartupPresentation,
	loadQuestionRecoveries,
	parseQuestionParams,
	QUESTION_RECOVERY_ENTRY_TYPE,
	repairQuestionContext,
	selectRecoveryGate,
	selectStartupRecovery,
} from "./recovery.ts";

const params = {
	questions: [
		{
			question: "Ship it?",
			options: [
				{ label: "Yes", tag: "recommended", tagColor: "success" as const },
				{ label: "No", description: "Wait" },
			],
		},
	],
};

const answeredResult = formatQuestionResult(params, {
	kind: "answered",
	answer: {
		answers: [["Yes"]],
		notes: [null],
		content: '"Ship it?": 1. Yes',
	},
});

const skippedResult = formatQuestionResult(params, { kind: "skipped" });

const call = (id: string, name = "question", arguments_: unknown = params) => ({
	type: "toolCall",
	id,
	name,
	arguments: arguments_,
});

const assistant = (
	calls: ReturnType<typeof call>[],
	stopReason = "toolUse",
) => ({
	role: "assistant",
	stopReason,
	content: calls,
});

const toolResult = (toolCallId: string, toolName = "question") => ({
	role: "toolResult",
	toolCallId,
	toolName,
	content: [{ type: "text", text: `${toolName} result` }],
	isError: false,
	timestamp: 1,
});

const messageEntry = (id: string, message: unknown) => ({
	type: "message",
	id,
	message,
});

const assistantEntry = (
	id: string,
	calls: ReturnType<typeof call>[],
	stopReason = "toolUse",
) => messageEntry(id, assistant(calls, stopReason));

const recoveryEntry = (
	id: string,
	recovery: ReturnType<typeof createQuestionRecovery>,
) => ({
	type: "custom",
	id,
	customType: QUESTION_RECOVERY_ENTRY_TYPE,
	data: recovery,
});

const resultIds = (messages: readonly unknown[]) =>
	messages.flatMap((rawMessage) => {
		const message = rawMessage as { role?: string; toolCallId?: string };
		return message.role === "toolResult" && message.toolCallId
			? [message.toolCallId]
			: [];
	});

test("parseQuestionParams returns a safe copy and rejects malformed historical arguments", () => {
	const parsed = parseQuestionParams(params);
	assert.deepEqual(parsed, params);
	assert.notEqual(parsed, params);
	assert.equal(parseQuestionParams({ questions: [] }), undefined);
	assert.equal(
		parseQuestionParams({
			questions: [{ question: "Broken", options: [{ label: 1 }] }],
		}),
		undefined,
	);
	assert.equal(
		parseQuestionParams({
			questions: [
				{
					question: "Broken",
					options: [{ label: "A", tagColor: "purple" }],
				},
			],
		}),
		undefined,
	);
});

test("replayability matches pinned tool execution semantics", () => {
	for (const stopReason of ["stop", "toolUse", "deferred"]) {
		assert.equal(isReplayableAssistant(assistant([call("q")], stopReason)), true);
	}
	for (const stopReason of ["error", "aborted", "length", "pending", undefined]) {
		assert.equal(
			isReplayableAssistant({
				role: "assistant",
				stopReason,
				content: [call("q")],
			}),
			false,
		);
	}
});

test("findLatestDanglingQuestionCall ignores completed and durably recovered calls", () => {
	const entries = [
		assistantEntry("a1", [call("call-complete")]),
		messageEntry("r1", toolResult("call-complete")),
		assistantEntry("a2", [call("call-recovered")]),
		assistantEntry("a3", [call("call-latest")]),
	];
	assert.deepEqual(
		findLatestDanglingQuestionCall(entries, new Set(["call-recovered"])),
		{ toolCallId: "call-latest", arguments: params },
	);
	assert.equal(
		findLatestDanglingQuestionCall(
			entries,
			new Set(["call-recovered", "call-latest"]),
		),
		undefined,
	);
});

test("non-replayable assistants never become modal candidates", () => {
	for (const stopReason of ["error", "aborted", "length"]) {
		assert.equal(
			findLatestDanglingQuestionCall(
				[assistantEntry("a1", [call(`call-${stopReason}`)], stopReason)],
				new Set(),
			),
			undefined,
		);
	}
});

test("latest malformed dangling arguments do not fall back to an older question", () => {
	const entries = [
		assistantEntry("a1", [call("call-valid")]),
		assistantEntry("a2", [call("call-malformed", "question", { questions: [] })]),
	];
	const latest = findLatestDanglingQuestionCall(entries, new Set());
	assert.equal(latest?.toolCallId, "call-malformed");
	assert.equal(parseQuestionParams(latest?.arguments), undefined);
});

test("only a question in the final still-open assistant batch is recoverable", () => {
	const dangling = assistantEntry("dangling", [
		call("bash", "bash"),
		call("question"),
	]);
	assert.equal(
		findLatestDanglingQuestionCall([dangling], new Set())?.toolCallId,
		"question",
	);
	assert.equal(
		findLatestDanglingQuestionCall(
			[
				dangling,
				messageEntry("user", { role: "user", content: "continue" }),
				assistantEntry("done", [], "stop"),
			],
			new Set(),
		),
		undefined,
	);
	assert.equal(
		findLatestDanglingQuestionCall(
			[dangling, assistantEntry("boundary", [], "stop")],
			new Set(),
		),
		undefined,
	);
});

test("sibling results resolve only their own calls in the open batch", () => {
	const entries = [
		assistantEntry("assistant", [call("bash", "bash"), call("question")]),
		messageEntry("bash-result", toolResult("bash", "bash")),
	];
	assert.equal(
		findLatestDanglingQuestionCall(entries, new Set())?.toolCallId,
		"question",
	);
});

test("context projection boundaries mirror pinned convertToLlm", () => {
	const dangling = assistantEntry("assistant", [call("question")]);
	const metadata = {
		type: "custom",
		id: "metadata",
		customType: QUESTION_RECOVERY_ENTRY_TYPE,
		data: {},
	};
	assert.equal(findLatestDanglingQuestionCall([metadata], new Set()), undefined);
	assert.equal(
		findLatestDanglingQuestionCall([dangling, metadata], new Set())?.toolCallId,
		"question",
	);
	for (const boundary of [
		{ type: "custom_message", id: "custom-message", content: "context" },
		{ type: "branch_summary", id: "branch", summary: "branch" },
		messageEntry("bash", { role: "bashExecution", excludeFromContext: false }),
	]) {
		assert.equal(
			findLatestDanglingQuestionCall([dangling, boundary], new Set()),
			undefined,
		);
	}
	assert.equal(
		findLatestDanglingQuestionCall(
			[
				dangling,
				messageEntry("hidden-bash", {
					role: "bashExecution",
					excludeFromContext: true,
				}),
			],
			new Set(),
		)?.toolCallId,
		"question",
	);
	assert.equal(
		findLatestDanglingQuestionCall(
			[dangling, { type: "branch_summary", id: "empty", summary: "" }],
			new Set(),
		)?.toolCallId,
		"question",
	);
});

test("compaction is a user boundary, while a retained call after it can be open", () => {
	const dangling = assistantEntry("old", [call("question")]);
	const compaction = { type: "compaction", id: "compact", summary: "old work" };
	assert.equal(
		findLatestDanglingQuestionCall([dangling, compaction], new Set()),
		undefined,
	);
	assert.equal(
		findLatestDanglingQuestionCall([compaction, dangling], new Set())?.toolCallId,
		"question",
	);
});

test("branch-local markers cannot repair a branch before the marker", () => {
	const recovery = createQuestionRecovery("call-question", answeredResult, 1234);
	const dangling = assistantEntry("assistant", [call("call-question")]);
	const branchA = [dangling, recoveryEntry("marker", recovery)];
	const branchB = [dangling];
	const branchARecoveries = loadQuestionRecoveries(branchA);
	const branchBRecoveries = loadQuestionRecoveries(branchB);
	assert.equal(
		repairQuestionContext(
			[assistant([call("call-question")])],
			[...branchARecoveries.values()].map((loaded) => loaded.record),
		).length,
		2,
	);
	assert.deepEqual(
		repairQuestionContext(
			[assistant([call("call-question")])],
			[...branchBRecoveries.values()].map((loaded) => loaded.record),
		),
		[assistant([call("call-question")])],
	);
});

test("recovery continuation requires a later successful terminal assistant", () => {
	const recovery = createQuestionRecovery("call-question", answeredResult, 1234);
	const marker = recoveryEntry("marker", recovery);
	const loaded = loadQuestionRecoveries([marker]).get("call-question");
	assert.ok(loaded);

	assert.equal(isRecoveryContinuationComplete([marker], loaded), false);
	assert.equal(
		isRecoveryContinuationComplete(
			[marker, messageEntry("user", { role: "user", content: "transformed" })],
			loaded,
		),
		false,
	);
	assert.equal(
		isRecoveryContinuationComplete(
			[
				marker,
				messageEntry("user", { role: "user", content: "transformed" }),
				assistantEntry("done", [], "stop"),
			],
			loaded,
		),
		true,
	);
	assert.equal(
		isRecoveryContinuationComplete(
			[marker, assistantEntry("still-running", [call("next-tool", "bash")], "stop")],
			loaded,
		),
		false,
	);
	for (const stopReason of ["error", "aborted", "length", "toolUse", "deferred"]) {
		assert.equal(
			isRecoveryContinuationComplete(
				[marker, assistantEntry("not-done", [], stopReason)],
				loaded,
			),
			false,
		);
	}
	// A terminal assistant on a sibling branch is absent from this active path.
	assert.equal(isRecoveryContinuationComplete([marker], loaded), false);
});

test("marker after the pending user still repairs context and observes completion", () => {
	const recovery = createQuestionRecovery("question", answeredResult, 1234);
	const marker = recoveryEntry("marker", recovery);
	const user = messageEntry("user", { role: "user", content: "continue" });
	const done = assistantEntry("done", [], "stop");
	const branch = [assistantEntry("question", [call("question")]), user, marker, done];
	const loaded = loadQuestionRecoveries(branch).get("question");
	assert.ok(loaded);
	assert.equal(isRecoveryContinuationComplete(branch, loaded), true);
	assert.deepEqual(
		resultIds(
			repairQuestionContext(
				[assistant([call("question")]), (user as { message: unknown }).message, done.message],
				[loaded.record],
			),
		),
		["question"],
	);
});

test("recovery gate opens only a valid unrecovered TUI question", () => {
	const dangling = assistantEntry("assistant", [call("question")]);
	assert.equal(
		selectRecoveryGate([dangling], new Map(), "tui")?.call.toolCallId,
		"question",
	);
	assert.equal(selectRecoveryGate([dangling], new Map(), "print"), undefined);
	assert.equal(
		selectRecoveryGate(
			[assistantEntry("malformed", [call("question", "question", { questions: [] })])],
			new Map(),
			"tui",
		),
		undefined,
	);

	const recovery = createQuestionRecovery("question", answeredResult, 1234);
	const marker = recoveryEntry("marker", recovery);
	assert.equal(
		selectRecoveryGate(
			[dangling, marker],
			loadQuestionRecoveries([dangling, marker]),
			"tui",
		),
		undefined,
	);
});

test("auto-show and redelivery stay restricted while the gate does not", () => {
	const dangling = [assistantEntry("assistant", [call("question")])];
	for (const reason of ["startup", "resume"]) {
		assert.equal(isStartupPresentation(reason, "/tmp/session.jsonl"), true);
	}
	for (const reason of ["fork", "new", "reload"]) {
		assert.equal(isStartupPresentation(reason, "/tmp/session.jsonl"), false);
		// The awaited gate ignores the reason, so a live question still blocks a turn.
		assert.equal(
			selectRecoveryGate(dangling, new Map(), "tui")?.call.toolCallId,
			"question",
		);
	}
	assert.equal(isStartupPresentation("startup", undefined), false);
});

test("newest valid dangling question wins over older incomplete redelivery", () => {
	const recovery = createQuestionRecovery("question-1", answeredResult, 1234);
	const branch = [
		assistantEntry("question-1-assistant", [call("question-1")]),
		recoveryEntry("question-1-marker", recovery),
		messageEntry("recovery-user", {
			role: "user",
			content: [{ type: "text", text: recovery.userMessage }],
		}),
		assistantEntry("question-2-assistant", [call("question-2")]),
	];
	const action = selectStartupRecovery(
		branch,
		branch,
		loadQuestionRecoveries(branch),
	);
	assert.equal(action.kind, "modal");
	if (action.kind === "modal") {
		assert.equal(action.call.toolCallId, "question-2");
		assert.deepEqual(action.params, params);
	}
});

test("malformed newest question falls back to older incomplete redelivery", () => {
	const recovery = createQuestionRecovery("question-1", answeredResult, 1234);
	const branch = [
		assistantEntry("question-1-assistant", [call("question-1")]),
		recoveryEntry("question-1-marker", recovery),
		messageEntry("recovery-user", { role: "user", content: "transformed" }),
		assistantEntry("question-2-assistant", [
			call("question-2", "question", { questions: [] }),
		]),
	];
	const action = selectStartupRecovery(
		branch,
		branch,
		loadQuestionRecoveries(branch),
	);
	assert.equal(action.kind, "redeliver");
	if (action.kind === "redeliver") {
		assert.equal(action.recovery.record.toolCallId, "question-1");
	}
});

test("repair orders a recovered first question before an existing following sibling", () => {
	const recovery = createQuestionRecovery("question", answeredResult, 100);
	const bashResult = toolResult("bash", "bash");
	const messages = [assistant([call("question"), call("bash", "bash")]), bashResult];
	const repaired = repairQuestionContext(messages, [recovery]);
	assert.deepEqual(resultIds(repaired), ["question", "bash"]);
	assert.equal(repaired[2], bashResult);
});

test("repair source-orders a middle question with existing preceding and following siblings", () => {
	const recovery = createQuestionRecovery("question", answeredResult, 100);
	const readResult = toolResult("read", "read");
	const bashResult = toolResult("bash", "bash");
	const messages = [
		assistant([call("read", "read"), call("question"), call("bash", "bash")]),
		bashResult,
		readResult,
	];
	const repaired = repairQuestionContext(messages, [recovery]);
	assert.deepEqual(resultIds(repaired), ["read", "question", "bash"]);
	assert.equal(repaired[1], readResult);
	assert.equal(repaired[3], bashResult);
});

test("repair orders a recovered last question after an existing preceding sibling", () => {
	const recovery = createQuestionRecovery("question", answeredResult, 100);
	const readResult = toolResult("read", "read");
	const repaired = repairQuestionContext(
		[assistant([call("read", "read"), call("question")]), readResult],
		[recovery],
	);
	assert.deepEqual(resultIds(repaired), ["read", "question"]);
	assert.equal(repaired[1], readResult);
});

test("repair supplies pinned placeholders for still-missing siblings in source order", () => {
	const recovery = createQuestionRecovery("question", answeredResult, 100);
	const repaired = repairQuestionContext(
		[
			assistant([
				call("bash", "bash"),
				call("question"),
				call("read", "read"),
			]),
		],
		[recovery],
	);
	assert.deepEqual(resultIds(repaired), ["bash", "question", "read"]);
	for (const index of [1, 3]) {
		assert.deepEqual(repaired[index], {
			role: "toolResult",
			toolCallId: index === 1 ? "bash" : "read",
			toolName: index === 1 ? "bash" : "read",
			content: [{ type: "text", text: "No result provided" }],
			isError: true,
			timestamp: 100,
		});
	}
});

test("repair source-orders multiple recovered questions and missing siblings", () => {
	const recovery1 = createQuestionRecovery("question-1", answeredResult, 100);
	const recovery2 = createQuestionRecovery("question-2", answeredResult, 200);
	const repaired = repairQuestionContext(
		[
			assistant([
				call("question-1"),
				call("bash", "bash"),
				call("question-2"),
			]),
		],
		[recovery1, recovery2],
	);
	assert.deepEqual(resultIds(repaired), ["question-1", "bash", "question-2"]);
});

test("repair never duplicates a real question result", () => {
	const recovery = createQuestionRecovery("question", answeredResult, 100);
	const real = toolResult("question");
	const messages = [assistant([call("question")]), real];
	assert.deepEqual(repairQuestionContext(messages, [recovery]), messages);
});

test("repair never replays non-replayable assistant calls", () => {
	const recovery = createQuestionRecovery("question", answeredResult, 100);
	for (const stopReason of ["error", "aborted", "length"]) {
		const messages = [assistant([call("question")], stopReason)];
		assert.deepEqual(repairQuestionContext(messages, [recovery]), messages);
	}
});

test("quit leaves the pending question dangling and therefore recoverable", () => {
	// shouldSettleModalOnShutdown("quit") === false means no cancelled result is
	// raced into the session, so the next start still sees an unresolved call and
	// re-asks the question instead of silently dropping it.
	assert.equal(shouldSettleModalOnShutdown("quit"), false);
	const dangling = assistantEntry("assistant", [call("question")]);
	assert.equal(
		selectRecoveryGate([dangling], new Map(), "tui")?.call.toolCallId,
		"question",
	);
	const startup = selectStartupRecovery([dangling], [dangling], new Map());
	assert.equal(startup.kind, "modal");
	// Replacement/reload DO settle the modal, which persists a cancelled result;
	// that marker then closes the call for good.
	assert.equal(shouldSettleModalOnShutdown("resume"), true);
	const cancelled = createQuestionRecovery(
		"question",
		formatQuestionResult(params, { kind: "cancelled" }),
		99,
	);
	const settled = [dangling, recoveryEntry("marker", cancelled)];
	assert.equal(
		selectRecoveryGate(settled, loadQuestionRecoveries(settled), "tui"),
		undefined,
	);
});

test("gate-opened modal skipped by Esc: marker persists, gate no-ops, turn proceeds", () => {
	// Gate flow: the user submitted prompt P, before_agent_start opened the modal,
	// Esc resolved it as skipped (it cannot minimize), so the operation appends the
	// marker with NO continuation message — P itself is the continuation.
	const recovery = createQuestionRecovery("question", skippedResult, 4321);
	const marker = recoveryEntry("marker", recovery);
	const dangling = assistantEntry("assistant", [call("question")]);
	const afterSkip = [dangling, marker];
	const loaded = loadQuestionRecoveries(afterSkip);

	// The gate loop re-checks after the operation resolves: no action left, so
	// the awaited turn returns instead of reopening a modal (no wedge).
	assert.equal(selectRecoveryGate(afterSkip, loaded, "tui"), undefined);
	// Before the marker existed the same entries DID require the gate — proving
	// the marker is what releases the turn.
	assert.equal(
		selectRecoveryGate([dangling], new Map(), "tui")?.call.toolCallId,
		"question",
	);
	// Startup would not redeliver a continuation for it either while the turn runs.
	assert.equal(recovery.result.details.skipped, true);
});

test("recovered user messages distinguish answers from cancellation and skip", () => {
	assert.equal(
		formatRecoveredUserMessage(answeredResult),
		'Recovered question response:\n"Ship it?": 1. Yes',
	);
	assert.equal(
		formatRecoveredUserMessage(
			formatQuestionResult(params, { kind: "cancelled" }),
		),
		"Recovered question cancelled by user.",
	);
	assert.equal(
		formatRecoveredUserMessage(skippedResult),
		"Recovered question skipped by the user (they responded in chat instead).",
	);
});

test("skipped recoveries round-trip through persisted entries", () => {
	const recovery = createQuestionRecovery("question-skipped", skippedResult, 1234);
	const marker = recoveryEntry("marker", recovery);
	const loaded = loadQuestionRecoveries([marker]).get("question-skipped");
	assert.ok(loaded);
	// The skipped flag must survive parsing so a reload renders (and repairs)
	// the call as skipped, never as cancelled or answered.
	assert.equal(loaded.record.result.details.skipped, true);
	assert.equal(loaded.record.result.details.cancelled, false);
	assert.equal(
		loaded.record.result.details.questions.length,
		params.questions.length,
	);
	// Malformed skipped flags are rejected like any other corrupt detail.
	const corrupt = {
		type: "custom",
		id: "corrupt",
		customType: QUESTION_RECOVERY_ENTRY_TYPE,
		data: {
			...recovery,
			result: {
				...recovery.result,
				details: { ...recovery.result.details, skipped: "yes" },
			},
		},
	};
	assert.equal(loadQuestionRecoveries([corrupt]).size, 0);
});

test("skip ordering: durable marker precedes the submitted chat message and closes the gate", () => {
	// State after a chat skip of a recovered question: the marker was appended
	// while the input handler awaited, and only then the user message persisted.
	const recovery = createQuestionRecovery("question", skippedResult, 1234);
	const marker = recoveryEntry("marker", recovery);
	const chat = messageEntry("chat", { role: "user", content: "use sqlite" });
	const entries = [assistantEntry("assistant", [call("question")]), marker, chat];
	const loaded = loadQuestionRecoveries(entries);

	// Gate no-op: the call is recovered, so before_agent_start must not reopen it.
	assert.equal(selectRecoveryGate(entries, loaded, "tui"), undefined);
	assert.equal(
		findLatestDanglingQuestionCall(entries, new Set(loaded.keys())),
		undefined,
	);

	// Repair injects the synthetic skipped toolResult between the call and the
	// chat answer, so the provider sees: toolCall → skipped result → user answer.
	const repaired = repairQuestionContext(
		[assistant([call("question")]), (chat as { message: unknown }).message],
		[recovery],
	);
	assert.deepEqual(resultIds(repaired), ["question"]);
	const synthetic = repaired[1] as { content: { text: string }[] };
	assert.equal(synthetic.content[0].text, skippedResult.content[0].text);
});
