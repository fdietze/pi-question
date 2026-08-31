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

`index.ts` is the pi entry point and imperative shell. It registers the `question` tool and the `/question` command, keeps the single-active-question latch, wires pi lifecycle events, and bridges the TUI modal to the tool-call promise.

A tool call opens the dock through `modal.ts` (controller + completion). `modal-component.ts` renders it. The presentation state machine in `presentation-lifecycle.ts` generation-counts every transition so stale callbacks from an older presentation cannot settle or minimize a newer one. Result formatting and skip/abort predicates live in `core.ts`.

While a question is pending, `Esc` minimizes (indicator shown), a chat message skips it (the message is the continuation), abort and shutdown settle it as cancelled, and only the answer path produces a full `QuestionDetails` result.

Settled interrupted calls persist as `question-recovery-v1` custom entries via `pi.appendEntry`. On session start, `recovery.ts` selects the recoverable question (modal in TUI, or redeliver of the original user message otherwise) and `context` events repair the dangling tool call into the stored synthetic result.

## External interfaces

- Pi package entry: `extensions/question/index.ts`
- Tool: `question` (multi-select questions, shared note; second call while pending is rejected)
- Command: `/question` (expand the pending question overlay)
- Persistence custom entry type: `question-recovery-v1` (toolCallId, synthetic tool result, user message, timestamp)
- No configuration, no policy file, no network interface; the extension runs with pi's process permissions

## Source map

- `index.ts`: pi integration, latch, lifecycle wiring, recovery orchestration
- `modal.ts`, `modal-component.ts`: dock controller and TUI component
- `presentation-lifecycle.ts`: disposable-presentation state machine
- `recovery.ts`: recovery records, context repair, startup selection
- `core.ts`: result formatting, cursor bounds, skip/abort predicates
- adjacent `*.test.ts` files are the unit tests for the pure modules

## Change rules

Preserve the tool name `question`, the command `/question`, and the `question-recovery-v1` entry type verbatim — old sessions depend on them. Keep pure modules free of pi/TUI I/O. Prefer direct, narrow changes over speculative abstractions (KISS/YAGNI), and add tests for changed pure behavior.
