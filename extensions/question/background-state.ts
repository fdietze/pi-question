// Functional Core: the active raw branch is the authority for durable background
// requests and their outbox, even when compaction removes them from model context.
import { formatSelection, type QuestionParams, type QuestionToolResult } from "./core.ts";
import { isReplayableAssistant, parseQuestionParams, parseQuestionToolResult } from "./recovery.ts";

export const BACKGROUND_ENTRY_TYPE = "question-background-v1";
export const ANSWER_MESSAGE_TYPE = "question-answer";
export const DISCARDED_ANSWER_MESSAGE_TYPE = "question-answer-discarded";

export type BackgroundPending = {
  version: 1;
  kind: "pending";
  requestId: string;
  toolCallId: string;
  params: QuestionParams;
  createdAt: number;
};
/** The user's final response: answered, or dismissed via result.details.dismissed. */
export type BackgroundAnswered = {
  version: 1;
  kind: "answered";
  requestId: string;
  answerId: string;
  result: QuestionToolResult;
};
export interface BackgroundBatch {
  pending: BackgroundPending;
  answered?: BackgroundAnswered;
  delivered: boolean;
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

export function loadBackgroundBatches(entries: readonly unknown[]): Map<string, BackgroundBatch> {
  const batches = new Map<string, BackgroundBatch>();
  for (const raw of entries) {
    const entry = object(raw);
    if (entry?.type === "custom" && entry.customType === BACKGROUND_ENTRY_TYPE) {
      const data = object(entry.data);
      if (data?.version !== 1 || typeof data.requestId !== "string" || !data.requestId) continue;
      if (data.kind === "pending") {
        const params = parseQuestionParams(data.params);
        if (!params || typeof data.toolCallId !== "string" || !data.toolCallId ||
          typeof data.createdAt !== "number" || !Number.isFinite(data.createdAt)) continue;
        if (!batches.has(data.requestId)) batches.set(data.requestId, {
          pending: { version: 1, kind: "pending", requestId: data.requestId,
            toolCallId: data.toolCallId, params, createdAt: data.createdAt }, delivered: false,
        });
      } else if (data.kind === "answered") {
        const batch = batches.get(data.requestId);
        const result = parseQuestionToolResult(data.result);
        if (!batch || batch.answered || typeof data.answerId !== "string" || !data.answerId ||
          !result || result.details.cancelled || result.details.skipped) continue;
        batch.answered = { version: 1, kind: "answered", requestId: data.requestId,
          answerId: data.answerId, result };
      }
    } else if (entry?.type === "custom_message" && entry.customType === ANSWER_MESSAGE_TYPE) {
      const details = object(entry.details);
      const batch = typeof details?.requestId === "string" ? batches.get(details.requestId) : undefined;
      if (batch?.answered && details?.answerId === batch.answered.answerId) batch.delivered = true;
    }
  }
  return batches;
}

export function isAssociatedAnswer(message: unknown, batches: ReadonlyMap<string, BackgroundBatch>): boolean {
  const value = object(message);
  const details = object(value?.details);
  const batch = typeof details?.requestId === "string" ? batches.get(details.requestId) : undefined;
  return value?.customType === ANSWER_MESSAGE_TYPE && batch?.answered !== undefined &&
    details?.answerId === batch.answered.answerId;
}

// The model sees each answer at most once. message_end tombstones duplicates,
// but pi skips that hook for non-triggering (dismissal) messages appended at a
// turn boundary, so context is the authoritative dedupe point.
export function filterBackgroundAnswers<T extends { role: string }>(
  messages: readonly T[], batches: ReadonlyMap<string, BackgroundBatch>,
): T[] {
  const seen = new Set<unknown>();
  return messages.filter((message) => {
    if (message.role !== "custom") return true;
    const customType = object(message)?.customType;
    if (customType === DISCARDED_ANSWER_MESSAGE_TYPE) return false;
    if (customType !== ANSWER_MESSAGE_TYPE) return true;
    const answerId = object(object(message)?.details)?.answerId;
    if (!isAssociatedAnswer(message, batches) || seen.has(answerId)) return false;
    seen.add(answerId);
    return true;
  });
}

export function queuedQuestionResult() {
  return { content: [{ type: "text" as const, text: "Queued for the user. Keep working without the answer; it arrives later as a separate message." }], details: undefined };
}

// The answer repeats the offered options because compaction may have removed
// the original tool call from the agent's context by the time it arrives.
export function formatBackgroundAnswer(batch: BackgroundBatch): string {
  const { questions, answers, notes, dismissed } = batch.answered!.result.details;
  if (dismissed) {
    return ["The user dismissed your background question.",
      ...questions.map((q, i) => `Q${i + 1} "${q.question}"`)].join("\n");
  }
  const lines = ["The user answered your background question."];
  questions.forEach((q, i) => {
    const picks = (answers[i] ?? []).map((label) => `${q.options.indexOf(label) + 1}. ${label}`);
    lines.push(
      `Q${i + 1} "${q.question}"`,
      `  offered: ${q.options.map((label, j) => `${j + 1}. ${label}`).join("; ")}`,
      `  selected: ${formatSelection(picks, notes[i] ?? null)}`,
    );
  });
  return lines.join("\n");
}

// Repair only missing receipts. A completed tool result remains authoritative;
// answers are custom messages, never replacements of the original receipt.
export function repairBackgroundReceipts<T>(messages: readonly T[], batches: Iterable<BackgroundBatch>) {
  const byCall = new Map([...batches].map((b) => [b.pending.toolCallId, b.pending]));
  const repaired: Array<T | { role: "toolResult"; toolCallId: string; toolName: string;
    content: { type: "text"; text: string }[]; isError: boolean; timestamp: number }> = [];
  let index = 0;
  while (index < messages.length) {
    const message = object(messages[index]);
    repaired.push(messages[index++]);
    if (!isReplayableAssistant(message) || !Array.isArray(message?.content)) continue;
    const calls = message.content.map(object).filter((b) => b?.type === "toolCall" && b.name === "question" && typeof b.id === "string" && byCall.has(b.id));
    const resolved = new Set<string>();
    while (index < messages.length && object(messages[index])?.role === "toolResult") {
      const result = object(messages[index]);
      if (typeof result?.toolCallId === "string") resolved.add(result.toolCallId);
      repaired.push(messages[index++]);
    }
    for (const call of calls) {
      const id = call!.id as string;
      if (resolved.has(id)) continue;
      repaired.push({ role: "toolResult", toolCallId: id, toolName: "question",
        content: queuedQuestionResult().content, isError: false, timestamp: byCall.get(id)!.createdAt });
    }
  }
  return repaired;
}
