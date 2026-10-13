import assert from "node:assert/strict";
import { test } from "node:test";
import { formatQuestionResult } from "./core.ts";
import { BACKGROUND_ENTRY_TYPE, ANSWER_MESSAGE_TYPE, loadBackgroundBatches,
  isAssociatedAnswer, repairBackgroundReceipts, type BackgroundPending } from "./background-state.ts";
import { findLatestDanglingQuestionCall, selectRecoveryGate } from "./recovery.ts";

const params = { questions: [{ question: "Ship?", options: [{ label: "Yes" }] }] };
const pending: BackgroundPending = { version: 1, kind: "pending", requestId: "request", toolCallId: "call", params, createdAt: 1 };
const entry = (data: unknown) => ({ type: "custom", customType: BACKGROUND_ENTRY_TYPE, data });
const result = formatQuestionResult(params, { kind: "answered", answer: { answers: [["Yes"]], notes: ["note"], content: '"Ship?": 1. Yes | note: note' } });
const answered = { version: 1, kind: "answered", requestId: "request", answerId: "answer", result };
const message = { customType: ANSWER_MESSAGE_TYPE, details: { requestId: "request", answerId: "answer" } };

test("raw branch ledger retains multiple pending batches through compaction", () => {
  const batches = loadBackgroundBatches([entry(pending), { type: "compaction" }, entry({ ...pending, requestId: "second", toolCallId: "second-call" })]);
  assert.equal(batches.size, 2);
  assert.equal(batches.get("request")?.answered, undefined);
});
test("answer persistence precedes delivery evidence; exact answer identity scopes branches", () => {
  const before = loadBackgroundBatches([entry(pending)]);
  assert.equal(isAssociatedAnswer(message, before), false);
  const after = loadBackgroundBatches([entry(pending), entry(answered)]);
  assert.equal(isAssociatedAnswer(message, after), true);
  assert.equal(after.get("request")?.delivered, false);
  const delivered = loadBackgroundBatches([entry(pending), entry(answered), { type: "custom_message", ...message }]);
  assert.equal(delivered.get("request")?.delivered, true);
  assert.equal(isAssociatedAnswer(message, loadBackgroundBatches([entry(pending), entry({ ...answered, answerId: "other-branch" })])), false);
  assert.equal(loadBackgroundBatches([entry(pending), entry(answered), { type: "custom_message", ...message, customType: "question-answer-discarded" }]).get("request")?.delivered, false);
});
test("malformed and non-answer records cannot terminate a background batch", () => {
  assert.equal(loadBackgroundBatches([entry({ ...pending, params: {} })]).size, 0);
  const cancelled = formatQuestionResult(params, { kind: "cancelled" });
  const batches = loadBackgroundBatches([entry(pending), entry({ ...answered, result: cancelled })]);
  assert.equal(batches.get("request")?.answered, undefined);
});
test("missing ack is repaired without replacing completed results", () => {
  const batches = loadBackgroundBatches([entry(pending)]);
  const assistant = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call", name: "question" }] };
  const repaired = repairBackgroundReceipts([assistant], batches.values());
  assert.equal(repaired.length, 2);
  assert.match((repaired[1] as {content: {text:string}[]}).content[0].text, /queued/);
  const completed = { role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "original" }] };
  assert.deepEqual(repairBackgroundReceipts([assistant, completed], batches.values()), [assistant, completed]);
});
test("blocking recovery skips explicit async calls before any ledger exists and scans blocking siblings", () => {
  const call = (id: string, args: unknown) => ({ type: "toolCall", id, name: "question", arguments: args });
  const entries = [{ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [call("blocking", params), call("async", { ...params, blocking: false })] } }];
  assert.equal(findLatestDanglingQuestionCall(entries, new Set())?.toolCallId, "blocking");
  assert.equal(selectRecoveryGate(entries, new Map(), "tui", new Set(["blocking"])), undefined);
});
