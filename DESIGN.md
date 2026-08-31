# Design

## Purpose

The `question` tool replaces "ask the user in plain text" with a structured multi-select form docked below the transcript. The agent gets a machine-readable result (original option order, per-question selections, trimmed notes); the user gets checkboxes, an optional note field, and minimize-or-skip control. One call can batch several questions to gather more input per round-trip.

## Modal lifecycle

`modal.ts` owns one dock presentation: open (`shown`) or `minimized`. `Esc` minimizes — the chat editor regains input and a one-line pending indicator appears; `/question` opens a fresh presentation from the same draft; answering or ending the run settles the presentation. There is no cancel key in the live flow: an answer, a chat-message skip, an abort, or a shutdown are the only outcomes (`answered` / `skipped` / `cancelled` in `core.ts`).

`presentation-lifecycle.ts` is the disposable-presentation state machine. Every transition bumps a generation counter, and older callbacks present a stale generation and are ignored — after a minimize/reopen race, only the newest presentation can settle or minimize the run. This is what makes re-opening `/question` while an old modal component is still mounted safe.

## One-active-question latch

`index.ts` keeps a single `active` question. A second `question` tool call while one is pending is rejected deterministically with a busy result instead of silently replacing the active controller. The latch also routes recovery: skip suppression and the durability-boundary promise hang off the active record.

## Input-skip and abort handling

A normal chat submission while the question is minimized resolves the call as skipped and then flows through unchanged: the skip is a state change, the message itself is the agent's continuation. The handler awaits the call's durability boundary (tool result produced live, recovery marker appended otherwise) before letting the message flow, so the real tool result always precedes the chat message in provider context. Abort (`signal`) and session shutdown settle an open modal as cancelled; on replacement/reload the modal is settled so teardown can complete, on quit it is left dangling deliberately so the next start recovers it.

## Recovery semantics

A settled interrupted call is not a dead end. `recovery.ts` turns the branch's `question-recovery-v1` custom entries (toolCallId, synthetic result, original user message, timestamp) into recoverable questions and repairs the provider context: `context` events rewrite the dangling tool call into the stored synthetic result so the model never sees a call without a result.

On session start, a freshly opened persisted session may re-present a pending recovered question as a modal, or — outside TUI — redeliver the original user message. The recovery gate variant opened at startup behaves differently from a live call: pi dispatches no editor input while the gate awaits, so `Esc` resolves it as skipped immediately, and a chat-message skip suppresses the continuation message because the message itself is the continuation.

## Structure

`core.ts` (result formatting, cursor bounds, skip/abort predicates) and `recovery.ts` / `presentation-lifecycle.ts` are pure and unit-tested without pi or the TUI. `index.ts` is the imperative shell: tool/command registration, lifecycle wiring, and the latch. `modal.ts` + `modal-component.ts` are the TUI layer.

The package has no service or network interface of its own; it runs inside pi with the same process permissions.
