# pi-question

A [pi](https://pi.dev/) extension that lets the agent ask the user structured questions instead of free-form text. The `question` tool renders multi-select checkbox questions in a terminal dock with an optional shared note. Calls wait for the answer by default; `blocking: false` lets the agent continue and receive the answer later as a message.

## Install

```bash
pi install git:github.com/fdietze/pi-question
```

## Interface

The agent receives the `question` tool: one or more questions per call, each with options (optional short `tag` badge, e.g. "recommended"), answered together with one shared free-form note.

- `blocking` omitted or `true`: wait for a tool result. Only one blocking call may be pending; another blocking call is rejected.
- `blocking: false`: store and immediately display the questions, then return an acknowledgement. Multiple background batches may accumulate alongside a blocking call. Each answer arrives as a `question-answer` custom message associated with its original call.

For example:

```json
{
  "blocking": false,
  "questions": [{
    "question": "Which name do you prefer?",
    "options": [{ "label": "Atlas" }, { "label": "Orbit" }]
  }]
}
```

The user interface:

- Batch view: list of all questions with the active one below, `Tab`/`Shift+Tab` switch questions, `Enter` advances (submits on the last), `Space` toggles options, typing jumps to the note.
- `Esc` minimizes the dock. `/question` re-opens it or offers a choice when several batches are pending; an indicator shows the pending count.
- New background questions open immediately unless another form is already shown. The current form and draft stay intact; a blocking question takes initial presentation priority.
- Switching batches preserves drafts during the session. There is no background skip or dismiss action.
- Sending a chat message skips a **minimized blocking** question and reaches the agent normally. Background questions stay open through chat messages and agent interruption.

Open background questions and submitted answers survive restart or reload and belong to their session branch. Unsubmitted drafts do not survive restart. Interrupted blocking calls use their existing recovery flow; background calls never wait for an answer during startup.

Saved background answers whose message has not been recorded are retried after restart, a branch change or the next agent run. Stopping the agent does not itself restart it. This recovers interrupted delivery, not guaranteed processing by the model.

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
