# pi-question

A [pi](https://pi.dev/) extension that lets the agent ask the user structured questions instead of free-form text. The `question` tool renders one or several multi-select checkbox questions in a dock at the bottom of the terminal, with an optional note field, and returns the selections to the agent as a tool result.

## Install

```bash
pi install git:github.com/fdietze/pi-question
```

## Interface

The agent receives the `question` tool: one or more questions per call, each with options (optional short `tag` badge, e.g. "recommended"), answered together with one shared free-form note. Only one question call is active at a time; a second call is rejected while the first is pending.

The user interface:

- Batch view: list of all questions with the active one below, `Tab`/`Shift+Tab` switch questions, `Enter` advances (submits on the last), `Space` toggles options, typing jumps to the note.
- `Esc` minimizes the dock; a one-line indicator stays. `/question` re-opens the pending question. There is no cancel key — answering or skipping ends the call.
- Sending a chat message while a question is pending resolves it as skipped and the message itself reaches the agent.

Interrupted question calls (crash, restart, reload) are recovered: pending answers are re-presented on the next start and their result is repaired into the conversation so nothing is lost.

## Development

```bash
nix develop
npm ci
npm run ci
npm pack --dry-run
```

Architecture is documented in [DESIGN.md](DESIGN.md).

## License

[MIT](LICENSE)
