# Design

## Purpose

The `question` tool presents one or more multi-select questions in a dock below the transcript, each with its own note and optionally preceded by the agent's `context`. `blocking` defaults to `true`: the answer is the tool result. With `blocking: false`, the call acknowledges a durably stored background batch immediately and the answer arrives later as a custom message. Background questions require the TUI, like the existing form.

## Question lifetimes

`index.ts` owns at most one blocking call or blocking recovery operation. A second blocking call is rejected. Blocking calls keep their tool promise pending; abort cancels them, and a normal chat submission skips a minimized blocking call. The input handler waits for the result or recovery marker before passing that chat message onward.

`background-questions.ts` owns multiple independent background batches. Their lifetime does not depend on the initiating tool promise or abort signal. Chat and agent interruption leave them open; only answering settles them. There is no background skip or dismiss action.

## Shared presentation

All batches share one visible dock. New background requests open the view immediately, including when it was minimized, but do not replace an already visible form. A blocking question takes initial presentation priority and parks the background draft. `/question` uses Pi's selection dialog when several batches are pending, allowing the user to choose their order. Each batch retains its own in-memory controller and draft when switching. Drafts are not persisted across restart or branch changes.

`modal.ts` owns a controller and completion promise; `modal-component.ts` renders the form. `Esc` minimizes without settling. `presentation-lifecycle.ts` generation-counts transitions so stale callbacks from a disposed presentation cannot minimize or settle a newer one. `index.ts` owns the shared pending-count widget, avoiding competing controllers clearing one another's indicator.

## Background persistence and delivery

`background-state.ts` reconstructs the background state from the active **raw session branch**, not compacted model context. Append-only `question-background-v1` custom entries contain:

- `pending`: version, request ID, original tool-call ID, question parameters, and creation time;
- `answered`: version, request ID, answer ID, and structured result.

The pending record is appended before the immediate tool acknowledgement. The answer record is appended before delivery. A `question-answer` custom message includes the questions, option labels, selections and note in its model-visible text; its details correlate request ID, tool-call ID and answer ID. `pi.sendMessage` uses `triggerTurn: true` and `deliverAs: "steer"`, supporting both a running and an idle agent.

An in-flight set prevents repeated enqueueing during a run. It is reset when the run ends or the branch is rebuilt, because Pi can clear queued messages without a delivery event. A matching persisted custom message is delivery evidence on reconstruction; no separate delivery marker is needed. Saved answers without that evidence are retried after restart, branch reconstruction or the next agent run. Ending a run does not itself restart the agent. This is at-least-once interrupted delivery, not an exactly-once guarantee or proof that the model processed the answer.

Startup restores the ledger synchronously and schedules guarded presentation and delivery without awaiting an answer. Background questions never enter the blocking recovery gate. Shutdown closes presentations without settling pending background records. Branch changes rebuild the ledger and invalidate old controller callbacks.

Queued messages can outlive a stopped run and a branch change. The `message_end` hook checks for the matching answered record on the current branch and for prior delivery. An invalid or duplicate answer is replaced with an empty, hidden `question-answer-discarded` custom message before persistence and display. The `context` hook removes discarded or unassociated answers entirely: hiding a message alone does not exclude it from model context.

## Blocking recovery compatibility

`question-recovery-v1` and `recovery.ts` retain the existing interrupted-blocking-call flow. Recovery records contain the tool-call ID, synthetic result, continuation user message and timestamp. Context repair supplies the stored result for a dangling blocking call; startup may re-present the questions or redeliver the continuation outside the TUI.

Explicit non-blocking calls and known background call IDs are excluded from blocking recovery. If a crash leaves a persisted background request without its acknowledgement, context repair supplies only the missing acknowledgement. A completed tool result is never replaced with the later answer.

A recovered blocking modal may gate a new agent turn. That gate cannot be minimized because Pi dispatches no editor input while awaiting it; `Esc` skips it instead. Idle recovery presentations remain minimizable. This distinction is unchanged by the background mode.

## Source map and verification

- `index.ts`: Pi registration, blocking lifetime, shared navigation/widget, lifecycle and message hooks.
- `background-questions.ts`: background lifetime, controller cache, persistence and delivery orchestration.
- `background-state.ts`: pure ledger reconstruction, answer association, formatting and receipt repair.
- `core.ts`, `recovery.ts`, `presentation-lifecycle.ts`: pure result formatting, blocking recovery and presentation state transitions.
- `modal.ts`, `modal-component.ts`: dock controller and form.
- Adjacent unit tests and `index.test.ts`: pure behavior plus a Pi I/O harness exercising real modal input and lifecycle events.

The package has no service or network interface of its own; it runs with Pi's process permissions. Setup and verification commands are in `AGENTS.md`.
