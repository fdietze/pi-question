# pi-question contributor map

Keep this file, `README.md`, and `DESIGN.md` true to the code whenever architecture, interfaces, paths, or commands change.

## Setup and verification

Nix is the source of truth for Node.js 24, TypeScript Go, and oxlint. npm supplies only pinned development type libraries.

```bash
nix develop
npm ci
npm run ci
npm pack --dry-run
```

`npm run ci` runs strict type-checking, linting, and every `*.test.ts` through Node's test runner. CI runs the same commands inside `nix develop`.

## Architecture and data flow

`index.ts` is the Pi entry point and imperative shell: tool/command registration, one blocking-call latch, lifecycle hooks, shared pending-count widget and batch selection.

`blocking` defaults to `true`. A blocking call awaits its modal; chat skips it only while minimized, and abort cancels it. `blocking: false` persists a background batch and returns immediately. `background-questions.ts` owns multiple background lifetimes and draft-preserving controllers; chat and initiating abort do not settle them. Only answers end background batches.

`modal.ts` supplies controllers and completion promises; `modal-component.ts` renders one visible dock. `presentation-lifecycle.ts` generation-counts transitions to reject stale callbacks. Blocking questions take initial presentation priority; `/question` selects among batches. Drafts survive switching, not restart or branch changes.

Background persistence is append-only `question-background-v1`, reduced from the active raw branch by `background-state.ts`. Persist pending before acknowledgement and answer before enqueueing its `question-answer` message. Matching persisted messages are delivery evidence. Run end and branch reconstruction clear the in-flight guard; startup, branch reconstruction and the next agent run retry undelivered saved answers without awaiting a question. `message_end` neutralizes wrong-branch or duplicate queued answers and `context` filters them out.

Blocking recovery remains `question-recovery-v1` through `recovery.ts`. Background calls are excluded from its gates; context repair supplies missing background acknowledgements without replacing completed results. See `DESIGN.md` for recovery and delivery limits.

## External interfaces

- Pi package entry: `extensions/question/index.ts`
- Tool: `question` (multi-select questions, shared note, optional `blocking` defaulting to `true`; at most one blocking call plus multiple background batches)
- Command: `/question` (open a pending batch or select among several)
- Persistence types: `question-recovery-v1` for blocking recovery; `question-background-v1` for pending and answered background records
- Answer custom message: `question-answer`, correlated by requestId, toolCallId and answerId; `question-answer-discarded` is an inert wrong-branch tombstone
- No configuration, no policy file, no network interface; the extension runs with pi's process permissions

## Source map

- `index.ts`: Pi integration, blocking latch, batch selection/widget, lifecycle and message hooks
- `background-questions.ts`: background controllers, persistence and outbox orchestration
- `background-state.ts`: pure background ledger, answer association and acknowledgement repair
- `modal.ts`, `modal-component.ts`: dock controller and TUI component
- `presentation-lifecycle.ts`: disposable-presentation state machine
- `recovery.ts`: recovery records, context repair, startup selection
- `core.ts`: result formatting, cursor bounds, skip/abort predicates
- adjacent `*.test.ts` files test the pure modules; `index.test.ts` is the Pi I/O/modal-input integration harness

## Change rules

Preserve the tool/command names and persisted entry/message identifiers — old sessions depend on them. Keep pure modules free of Pi/TUI I/O. Prefer direct, narrow changes over speculative abstractions (KISS/YAGNI). Test changed pure behavior and lifecycle wiring through the existing harness.
