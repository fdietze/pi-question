// Pure session-recovery logic for interrupted question tool calls.
// Functional core — no pi runtime or TUI dependency.

import type {
	QuestionDetails,
	QuestionOption,
	QuestionParams,
	QuestionToolResult,
	TagColor,
} from "./core.ts";

export const QUESTION_RECOVERY_ENTRY_TYPE = "question-recovery-v1";

export interface QuestionRecoveryRecord {
	version: 1;
	toolCallId: string;
	result: QuestionToolResult;
	userMessage: string;
	completedAt: number;
}

export interface LoadedQuestionRecovery {
	entryId: string;
	record: QuestionRecoveryRecord;
}

export interface DanglingQuestionCall {
	toolCallId: string;
	arguments: unknown;
}

export interface SyntheticToolResult {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: [{ type: "text"; text: string }];
	details?: QuestionDetails;
	isError: boolean;
	timestamp: number;
}

const TAG_COLORS = new Set<TagColor>([
	"accent",
	"success",
	"warning",
	"error",
	"muted",
]);

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

// Parse, Don't Validate: recovery code receives untrusted historical JSON, so a
// successful parse returns a fresh value that the modal can use without checks.
export function parseQuestionParams(value: unknown): QuestionParams | undefined {
	const input = record(value);
	if (!input || !Array.isArray(input.questions) || input.questions.length === 0) {
		return undefined;
	}
	const questions: QuestionParams["questions"] = [];
	for (const rawQuestion of input.questions) {
		const question = record(rawQuestion);
		if (
			!question ||
			typeof question.question !== "string" ||
			!Array.isArray(question.options)
		) {
			return undefined;
		}
		const options: QuestionOption[] = [];
		for (const rawOption of question.options) {
			const option = record(rawOption);
			if (!option || typeof option.label !== "string") return undefined;
			if (option.description !== undefined && typeof option.description !== "string") {
				return undefined;
			}
			if (option.tag !== undefined && typeof option.tag !== "string") return undefined;
			if (
				option.tagColor !== undefined &&
				(typeof option.tagColor !== "string" ||
					!TAG_COLORS.has(option.tagColor as TagColor))
			) {
				return undefined;
			}
			options.push({
				label: option.label,
				...(option.description === undefined
					? {}
					: { description: option.description as string }),
				...(option.tag === undefined ? {} : { tag: option.tag as string }),
				...(option.tagColor === undefined
					? {}
					: { tagColor: option.tagColor as TagColor }),
			});
		}
		questions.push({ question: question.question, options });
	}
	return { questions };
}

function parseQuestionDetails(value: unknown): QuestionDetails | undefined {
	const details = record(value);
	if (
		!details ||
		!Array.isArray(details.questions) ||
		!Array.isArray(details.answers) ||
		!Array.isArray(details.notes) ||
		typeof details.cancelled !== "boolean" ||
		(details.skipped !== undefined && typeof details.skipped !== "boolean")
	) {
		return undefined;
	}
	const questions: QuestionDetails["questions"] = [];
	for (const rawQuestion of details.questions) {
		const question = record(rawQuestion);
		if (
			!question ||
			typeof question.question !== "string" ||
			!Array.isArray(question.options) ||
			!question.options.every((option) => typeof option === "string")
		) {
			return undefined;
		}
		questions.push({
			question: question.question,
			options: [...question.options] as string[],
		});
	}
	if (
		!details.answers.every(
			(answer) =>
				Array.isArray(answer) && answer.every((label) => typeof label === "string"),
		) ||
		!details.notes.every((note) => note === null || typeof note === "string")
	) {
		return undefined;
	}
	return {
		questions,
		answers: details.answers.map((answer) => [...answer] as string[]),
		notes: [...details.notes] as (string | null)[],
		cancelled: details.cancelled,
		...(details.skipped === undefined ? {} : { skipped: details.skipped }),
	};
}

function parseQuestionToolResult(value: unknown): QuestionToolResult | undefined {
	const result = record(value);
	if (!result || !Array.isArray(result.content) || result.content.length !== 1) {
		return undefined;
	}
	const content = record(result.content[0]);
	const details = parseQuestionDetails(result.details);
	if (!content || content.type !== "text" || typeof content.text !== "string" || !details) {
		return undefined;
	}
	return { content: [{ type: "text", text: content.text }], details };
}

export function formatRecoveredUserMessage(result: QuestionToolResult): string {
	if (result.details.skipped) {
		return "Recovered question skipped by the user (they responded in chat instead).";
	}
	return result.details.cancelled
		? "Recovered question cancelled by user."
		: `Recovered question response:\n${result.content[0].text}`;
}

export function createQuestionRecovery(
	toolCallId: string,
	result: QuestionToolResult,
	completedAt: number,
): QuestionRecoveryRecord {
	return {
		version: 1,
		toolCallId,
		result,
		userMessage: formatRecoveredUserMessage(result),
		completedAt,
	};
}

export function parseQuestionRecovery(value: unknown): QuestionRecoveryRecord | undefined {
	const recovery = record(value);
	if (
		!recovery ||
		recovery.version !== 1 ||
		typeof recovery.toolCallId !== "string" ||
		recovery.toolCallId.length === 0 ||
		typeof recovery.userMessage !== "string" ||
		recovery.userMessage.length === 0 ||
		typeof recovery.completedAt !== "number" ||
		!Number.isFinite(recovery.completedAt)
	) {
		return undefined;
	}
	const result = parseQuestionToolResult(recovery.result);
	if (!result) return undefined;
	return {
		version: 1,
		toolCallId: recovery.toolCallId,
		result,
		userMessage: recovery.userMessage,
		completedAt: recovery.completedAt,
	};
}

export function loadQuestionRecoveries(
	entries: readonly unknown[],
): Map<string, LoadedQuestionRecovery> {
	const recoveries = new Map<string, LoadedQuestionRecovery>();
	for (const rawEntry of entries) {
		const entry = record(rawEntry);
		if (
			!entry ||
			entry.type !== "custom" ||
			entry.customType !== QUESTION_RECOVERY_ENTRY_TYPE ||
			typeof entry.id !== "string"
		) {
			continue;
		}
		const recovery = parseQuestionRecovery(entry.data);
		if (recovery) {
			recoveries.set(recovery.toolCallId, { entryId: entry.id, record: recovery });
		}
	}
	return recoveries;
}

function messageFromEntry(value: unknown): Record<string, unknown> | undefined {
	const entry = record(value);
	return entry?.type === "message" ? record(entry.message) : undefined;
}

// Pinned pi executes tool calls for successful stop/toolUse/deferred responses.
// Error/aborted responses are dropped during provider transformation, while length
// calls receive pi-generated failures instead of being executed.
export function isReplayableAssistant(message: unknown): boolean {
	const assistant = record(message);
	return (
		assistant?.role === "assistant" &&
		(assistant.stopReason === "stop" ||
			assistant.stopReason === "toolUse" ||
			assistant.stopReason === "deferred")
	);
}

function contextMessageFromEntry(value: unknown): Record<string, unknown> | undefined {
	const entry = record(value);
	if (!entry) return undefined;
	if (entry.type === "branch_summary") {
		return entry.summary ? { role: "user" } : undefined;
	}
	if (entry.type === "custom_message" || entry.type === "compaction") {
		return { role: "user" };
	}
	if (entry.type !== "message") return undefined;
	const message = record(entry.message);
	if (!message || typeof message.role !== "string") return undefined;
	if (message.role === "bashExecution" && message.excludeFromContext === true) {
		return undefined;
	}
	if (
		message.role === "user" ||
		message.role === "assistant" ||
		message.role === "toolResult"
	) {
		return message;
	}
	if (
		message.role === "bashExecution" ||
		message.role === "custom" ||
		message.role === "branchSummary" ||
		message.role === "compactionSummary"
	) {
		return { role: "user" };
	}
	return undefined;
}

// Pinned transformMessages keeps only one pending assistant tool batch. A later
// user-like or assistant message closes it with provider-only placeholders, while
// tool results resolve calls inside it and metadata entries project to nothing.
export function findLatestDanglingQuestionCall(
	entries: readonly unknown[],
	recoveredToolCallIds: ReadonlySet<string>,
): DanglingQuestionCall | undefined {
	let pending:
		| {
				calls: Array<DanglingQuestionCall & { name: string }>;
				resolved: Set<string>;
		  }
		| undefined;
	for (const rawEntry of entries) {
		const message = contextMessageFromEntry(rawEntry);
		if (!message) continue;
		if (message.role === "assistant") {
			pending = undefined;
			if (!isReplayableAssistant(message) || !Array.isArray(message.content)) continue;
			const calls: Array<DanglingQuestionCall & { name: string }> = [];
			for (const rawBlock of message.content) {
				const block = record(rawBlock);
				if (
					block?.type === "toolCall" &&
					typeof block.id === "string" &&
					typeof block.name === "string"
				) {
					calls.push({
						toolCallId: block.id,
						name: block.name,
						arguments: block.arguments,
					});
				}
			}
			if (calls.length > 0) pending = { calls, resolved: new Set() };
			continue;
		}
		if (message.role === "user") {
			pending = undefined;
			continue;
		}
		if (
			message.role === "toolResult" &&
			pending &&
			typeof message.toolCallId === "string"
		) {
			pending.resolved.add(message.toolCallId);
		}
	}
	if (!pending) return undefined;
	for (let index = pending.calls.length - 1; index >= 0; index--) {
		const call = pending.calls[index];
		if (
			call.name === "question" &&
			!pending.resolved.has(call.toolCallId) &&
			!recoveredToolCallIds.has(call.toolCallId)
		) {
			return { toolCallId: call.toolCallId, arguments: call.arguments };
		}
	}
	return undefined;
}

function messageRole(value: unknown): Record<string, unknown> | undefined {
	const message = record(value);
	return typeof message?.role === "string" ? message : undefined;
}

interface ToolCallBlock {
	id: string;
	name: string;
}

function toolCalls(message: Record<string, unknown>): ToolCallBlock[] {
	if (!Array.isArray(message.content)) return [];
	const calls: ToolCallBlock[] = [];
	for (const rawBlock of message.content) {
		const block = record(rawBlock);
		if (
			block?.type === "toolCall" &&
			typeof block.id === "string" &&
			typeof block.name === "string"
		) {
			calls.push({ id: block.id, name: block.name });
		}
	}
	return calls;
}

function recoveredToolResult(recovery: QuestionRecoveryRecord): SyntheticToolResult {
	return {
		role: "toolResult",
		toolCallId: recovery.toolCallId,
		toolName: "question",
		content: recovery.result.content,
		details: recovery.result.details,
		isError: false,
		timestamp: recovery.completedAt,
	};
}

function missingToolResult(
	call: ToolCallBlock,
	completedAt: number,
): SyntheticToolResult {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: "No result provided" }],
		isError: true,
		timestamp: completedAt,
	};
}

// The Map Is Not the Territory: persisted history stays untouched; this projection
// rebuilds each repaired result batch in assistant source order. Pinned pi otherwise
// appends placeholders for missing siblings after existing results, which can reverse
// the provider-visible order.
export function repairQuestionContext<T>(
	messages: readonly T[],
	recoveries: Iterable<QuestionRecoveryRecord>,
): Array<T | SyntheticToolResult> {
	const byId = new Map<string, QuestionRecoveryRecord>();
	for (const recovery of recoveries) byId.set(recovery.toolCallId, recovery);

	const repaired: Array<T | SyntheticToolResult> = [];
	let index = 0;
	while (index < messages.length) {
		const rawMessage = messages[index];
		const message = messageRole(rawMessage);
		if (!isReplayableAssistant(message)) {
			repaired.push(rawMessage);
			index++;
			continue;
		}

		const calls = toolCalls(message!);
		let batchEnd = index + 1;
		while (batchEnd < messages.length) {
			const next = messageRole(messages[batchEnd]);
			if (next?.role !== "toolResult") break;
			batchEnd++;
		}
		const existing = messages.slice(index + 1, batchEnd);
		const existingById = new Map<string, T>();
		for (const result of existing) {
			const resultMessage = messageRole(result);
			if (
				typeof resultMessage?.toolCallId === "string" &&
				!existingById.has(resultMessage.toolCallId)
			) {
				existingById.set(resultMessage.toolCallId, result);
			}
		}
		const needsRecovery = calls.some(
			(call) => byId.has(call.id) && !existingById.has(call.id),
		);
		if (!needsRecovery) {
			repaired.push(rawMessage);
			index++;
			continue;
		}

		repaired.push(rawMessage);
		const consumed = new Set<T>();
		const completedAt = Math.min(
			...calls.flatMap((call) => {
				const recovery = byId.get(call.id);
				return recovery ? [recovery.completedAt] : [];
			}),
		);
		for (const call of calls) {
			const result = existingById.get(call.id);
			if (result) {
				repaired.push(result);
				consumed.add(result);
				continue;
			}
			const recovery = byId.get(call.id);
			repaired.push(
				recovery
					? recoveredToolResult(recovery)
					: missingToolResult(call, completedAt),
			);
		}
		// Preserve malformed duplicate/orphan results rather than silently deleting history.
		for (const result of existing) {
			if (!consumed.has(result)) repaired.push(result);
		}
		index = batchEnd;
	}
	return repaired;
}

// A user entry is persisted before the provider request. Only a later successful
// terminal assistant proves that automatic continuation completed. At-least-once
// redelivery is safer than leaving a recovered answer idle after a crash or error.
export function isRecoveryContinuationComplete(
	entries: readonly unknown[],
	recovery: LoadedQuestionRecovery,
): boolean {
	let afterRecovery = false;
	for (const rawEntry of entries) {
		const entry = record(rawEntry);
		if (!entry) continue;
		if (entry.id === recovery.entryId) {
			afterRecovery = true;
			continue;
		}
		if (!afterRecovery) continue;
		const message = messageFromEntry(entry);
		if (
			message?.role === "assistant" &&
			message.stopReason === "stop" &&
			toolCalls(message).length === 0
		) {
			return true;
		}
	}
	return false;
}

export interface RecoveryModalAction {
	kind: "modal";
	call: DanglingQuestionCall;
	params: QuestionParams;
}

export type StartupRecoveryAction =
	| RecoveryModalAction
	| { kind: "redeliver"; recovery: LoadedQuestionRecovery }
	| { kind: "none" };

function selectRecoveryModal(
	contextEntries: readonly unknown[],
	recoveries: ReadonlyMap<string, LoadedQuestionRecovery>,
): RecoveryModalAction | undefined {
	const call = findLatestDanglingQuestionCall(
		contextEntries,
		new Set(recoveries.keys()),
	);
	if (!call) return undefined;
	const params = parseQuestionParams(call.arguments);
	return params ? { kind: "modal", call, params } : undefined;
}

// The awaited before_agent_start gate is TUI-only. A non-interactive turn must
// never hang on a modal, even when its context contains a recoverable question.
export function selectRecoveryGate(
	contextEntries: readonly unknown[],
	recoveries: ReadonlyMap<string, LoadedQuestionRecovery>,
	mode: string,
): RecoveryModalAction | undefined {
	return mode === "tui" ? selectRecoveryModal(contextEntries, recoveries) : undefined;
}

// Only a freshly opened persisted session may auto-show or redeliver. The awaited
// correctness gate deliberately does not use this: a forked, new, or reloaded
// runtime must still block a turn that would provider-close a live question.
export function isStartupPresentation(
	reason: string,
	sessionFile: string | undefined,
): boolean {
	return (reason === "startup" || reason === "resume") && sessionFile !== undefined;
}

// Bottlenecks: decide the one startup side effect in the pure core so an older
// at-least-once delivery cannot preempt the newest still-open question batch.
export function selectStartupRecovery(
	contextEntries: readonly unknown[],
	branchEntries: readonly unknown[],
	recoveries: ReadonlyMap<string, LoadedQuestionRecovery>,
): StartupRecoveryAction {
	const modal = selectRecoveryModal(contextEntries, recoveries);
	if (modal) return modal;
	const pending = [...recoveries.values()]
		.filter((recovery) => !isRecoveryContinuationComplete(branchEntries, recovery))
		.at(-1);
	return pending ? { kind: "redeliver", recovery: pending } : { kind: "none" };
}
