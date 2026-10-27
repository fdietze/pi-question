// Integration harness exercises the registered Pi surface and real modal input,
// without a terminal or provider. Only Pi's I/O boundary is replaced.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import question from "./index.ts";
import { ANSWER_MESSAGE_TYPE, BACKGROUND_ENTRY_TYPE, loadBackgroundBatches } from "./background-state.ts";

const params = (question = "Ship?") => ({ questions: [{ question, options: [{ label: "Yes" }, { label: "No" }] }] });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
function harness(initial: unknown[] = [], enqueue?: (message: any, options: any) => void) {
  let branch = [...initial];
  let tool: any;
  let command: any;
  const events = new Map<string, any>();
  const sent: any[] = [];
  const notices: string[] = [];
  let current: { component: Component; done: (value: any) => void } | undefined;
  let maxVisible = 0;
  let visible = 0;
  let picker: string | undefined;
  let widget: any;
  let deferPicker = false;
  let resolvePicker: ((choice?: string) => void) | undefined;
  const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text };
  const ctx = {
    mode: "tui",
    sessionManager: { getBranch: () => branch, buildContextEntries: () => branch, getSessionFile: () => "session.jsonl" },
    ui: {
      setWidget: (_key: string, value: any) => { widget = value; },
      notify: (text: string) => notices.push(text),
      select: async (_title: string, choices: string[], options?: {signal?: AbortSignal}) => {
        if (!deferPicker) return choices.find((choice) => choice === picker);
        visible++;
        maxVisible = Math.max(maxVisible, visible);
        return new Promise<string | undefined>((resolve) => {
          let finished = false;
          resolvePicker = (choice) => {
            if (finished) return;
            finished = true;
            visible--;
            resolve(choice);
          };
          options?.signal?.addEventListener("abort", () => resolvePicker?.(), { once: true });
        });
      },
      custom: (factory: any) => new Promise((resolve) => {
        visible++;
        maxVisible = Math.max(maxVisible, visible);
        const presentation = { component: undefined as unknown as Component, done: (value: any) => {
          visible--;
          if (current === presentation) current = undefined;
          resolve(value);
        } };
        current = presentation;
        presentation.component = factory({ requestRender() {}, terminal: { rows: 40, columns: 100 } }, theme, {}, presentation.done);
      }),
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: any) => events.set(name, handler),
    registerTool: (value: any) => { tool = value; },
    registerCommand: (_name: string, value: any) => { command = value; },
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
    sendMessage: (message: any, options: any) => {
      assert.equal(loadBackgroundBatches(branch).get(message.details.requestId)?.answered?.answerId, message.details.answerId);
      sent.push({ ...message, options });
      enqueue?.(message, options);
    },
    sendUserMessage: () => assert.fail("Unexpected blocking-recovery continuation"),
  } as unknown as ExtensionAPI;
  question(pi);
  return {
    ctx, sent, notices,
    branch: () => branch,
    setBranch: (value: unknown[]) => { branch = value; },
    execute: (id: string, value: any, signal = new AbortController().signal) => tool.execute(id, value, signal, undefined, ctx),
    emit: (name: string, value: any = {}) => events.get(name)?.(value, ctx),
    key: (key: string) => { assert.ok(current); current.component.handleInput?.(key); },
    mouse: (event: any) => { assert.ok(current); return current.component.handleMouse?.({ button: "left", y: 0, width: 100, ...event }); },
    render: () => current?.component.render(100).join("\n"),
    choose: async (choice: string) => { picker = choice; await command.handler("", ctx); },
    reopen: () => command.handler("", ctx),
    deferPicker: () => { deferPicker = true; },
    resolvePicker: (choice?: string) => resolvePicker?.(choice),
    widget: () => widget?.({}, theme).render(100).join("\n"),
    maxVisible: () => maxVisible,
    visible: () => visible,
  };
}

test("background calls return immediately, coexist, preserve draft, and ignore chat/abort/run end", async () => {
  const h = harness();
  const abort = new AbortController();
  const receipt = await h.execute("first", { ...params("First?"), blocking: false }, abort.signal);
  assert.match(receipt.content[0].text, /Queued/);
  assert.equal(h.branch().length, 1);
  h.key(" ");
  h.key("draft note");
  const draft = h.render();
  await h.execute("second", { ...params("Second?"), blocking: false });
  assert.equal(h.render(), draft);
  assert.match(h.widget()!, /2 question batches/);
  h.key("\x1b");
  await h.emit("input", { source: "interactive", text: "Keep working" });
  abort.abort();
  await h.emit("agent_end");
  assert.equal(loadBackgroundBatches(h.branch()).size, 2);
  await h.choose("2. Second?");
  assert.match(h.render()!, /Second/);
  await h.choose("1. First?");
  assert.match(h.render()!, /draft note/);
  h.key("\r");
  await flush();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: "steer" });
  assert.match(h.sent[0].content, /First\?/);
  assert.match(h.sent[0].content, /draft note/);
  assert.equal(h.maxVisible(), 1);
  h.emit("session_shutdown", { reason: "reload" });
});

test("new background requests reopen minimized view without replacing existing draft", async () => {
  const h = harness();
  await h.execute("first", { ...params("First?"), blocking: false });
  h.key("note"); h.key("\x1b");
  await h.execute("second", { ...params("Second?"), blocking: false });
  assert.match(h.render()!, /First/);
  assert.match(h.render()!, /note/);
  assert.equal(h.maxVisible(), 1);
  h.emit("session_shutdown", { reason: "reload" });
});

test("default blocking semantics and priority park and restore background draft", async () => {
  const h = harness();
  await h.execute("background", { ...params("Background?"), blocking: false });
  h.key("saved note");
  let settled = false;
  const blocking = h.execute("blocking", params("Blocking?")).then((result: any) => { settled = true; return result; });
  assert.match(h.render()!, /Blocking/);
  assert.equal(settled, false);
  const busy = await h.execute("busy", { ...params(), blocking: true });
  assert.match(busy.content[0].text, /another blocking question is still open/);
  await h.execute("another-background", { ...params("Another?"), blocking: false });
  assert.match(h.render()!, /Blocking/);
  h.key("\x1b");
  await h.emit("input", { source: "interactive", text: "My answer" });
  assert.equal((await blocking).details.backgrounded, true);
  assert.match(h.render()!, /Background/);
  assert.match(h.render()!, /saved note/);
  assert.equal(h.maxVisible(), 1);
  h.emit("session_shutdown", { reason: "reload" });
});

test("reload restores pending nonblocking requests; answers retry until persisted custom delivery", async () => {
  const h = harness();
  await h.execute("call", { ...params(), blocking: false });
  const pendingBranch = [...h.branch()];
  h.key("\r"); await flush();
  const answeredBranch = [...h.branch()];
  const message = { role: "custom", ...h.sent[0] };
  h.emit("session_shutdown", { reason: "reload" });
  const restored = harness(pendingBranch);
  await restored.emit("session_start", { reason: "reload" });
  await restored.emit("before_agent_start");
  await flush();
  assert.match(restored.render()!, /Ship/);
  restored.emit("session_shutdown", { reason: "reload" });
  const retry = harness(answeredBranch);
  await retry.emit("session_start", { reason: "reload" }); await flush();
  assert.equal(retry.sent.length, 1);
  assert.equal(retry.visible(), 0);
  retry.emit("session_shutdown", { reason: "reload" });
  const delivered = harness([...answeredBranch, { type: "custom_message", ...h.sent[0] }]);
  delivered.emit("session_start", { reason: "reload" }); await flush();
  assert.equal(delivered.sent.length, 0);
  delivered.emit("session_shutdown", { reason: "reload" });

  const moved = harness(answeredBranch);
  moved.setBranch(pendingBranch);
  moved.emit("session_tree");
  const replacement = moved.emit("message_end", { message });
  assert.equal(replacement.message.customType, "question-answer-discarded");
  assert.deepEqual(replacement.message.content, []);
  const projected = moved.emit("context", { messages: [message, replacement.message, { role: "user", content: "keep" }] });
  assert.deepEqual(projected.messages, [{ role: "user", content: "keep" }]);
  moved.setBranch([]); moved.emit("session_tree"); await flush();
  assert.equal(moved.visible(), 0);
  moved.emit("session_shutdown", { reason: "reload" });
});

test("queued request persists before acknowledgement and remains pending through shutdown", async () => {
  const h = harness();
  await h.execute("call", { ...params(), blocking: false });
  h.emit("session_shutdown", { reason: "reload" });
  const entry = h.branch()[0] as any;
  assert.equal(entry.customType, BACKGROUND_ENTRY_TYPE);
  assert.equal(entry.data.kind, "pending");
  assert.equal(h.sent.length, 0);
  assert.equal(ANSWER_MESSAGE_TYPE, "question-answer");
});


test("picker owns the single UI, preserves background arrivals, and blocking calls preempt it", async () => {
  const h = harness();
  await h.execute("a", { ...params("A?"), blocking: false });
  await h.execute("b", { ...params("B?"), blocking: false });
  h.deferPicker();
  const selection = h.reopen();
  assert.equal(h.visible(), 1);
  await h.execute("c", { ...params("C?"), blocking: false });
  assert.equal(h.visible(), 1);
  const abort = new AbortController();
  const blocking = h.execute("blocking", params("Blocking?"), abort.signal);
  await selection;
  assert.match(h.render()!, /Blocking/);
  assert.equal(h.maxVisible(), 1);
  abort.abort(); await blocking;
  h.emit("session_shutdown", { reason: "reload" });
});

test("blocking abort does not replace a user-selected open background form", async () => {
  const h = harness();
  await h.execute("a", { ...params("A?"), blocking: false });
  await h.execute("b", { ...params("B?"), blocking: false });
  const abort = new AbortController();
  const blocking = h.execute("blocking", params("Blocking?"), abort.signal);
  await h.choose("2. B?");
  h.key("B draft");
  abort.abort(); await blocking;
  assert.match(h.render()!, /B\?/);
  assert.match(h.render()!, /B draft/);
  assert.equal(h.maxVisible(), 1);
  h.emit("session_shutdown", { reason: "reload" });
});


test("Pi clearQueue drops custom steers; persisted answers retry next run and surviving duplicates are suppressed", async () => {
  // Exercise real AgentSession ingestion/clearQueue and real Agent queues. The
  // receiver supplies only queue-owned fields, avoiding provider/session setup.
  const packagePath = findPackageJSON("@earendil-works/pi-agent-core", import.meta.resolve("@earendil-works/pi-coding-agent"))!;
  const { Agent } = await import(new URL("./dist/index.js", pathToFileURL(packagePath)).href);
  const agent = new Agent({});
  const session = Object.assign(Object.create(AgentSession.prototype), {
    agent, _isAgentRunActive: true, _steeringMessages: [], _followUpMessages: [], _eventListeners: [],
  }) as AgentSession;
  const h = harness([], (message, options) => { void session.sendCustomMessage(message, options); });
  await h.execute("call", { ...params(), blocking: false });
  h.key("\r"); await flush();
  assert.equal(agent.hasQueuedMessages(), true);
  assert.deepEqual(session.clearQueue(), { steering: [], followUp: [] });
  assert.equal(agent.hasQueuedMessages(), false);
  h.emit("agent_end");
  assert.equal(h.sent.length, 1, "stop must not automatically restart agent");
  h.emit("agent_start");
  assert.equal(h.sent.length, 2);
  assert.equal(agent.hasQueuedMessages(), true);

  // If a queue survived instead, original and retried copies can both arrive.
  // The first is persisted; the second must carry no answer text/context.
  const first = { role: "custom", ...h.sent[0] };
  assert.equal(h.emit("message_end", { message: first }), undefined);
  h.setBranch([...h.branch(), { type: "custom_message", ...h.sent[0] }]);
  const duplicate = h.emit("message_end", { message: { role: "custom", ...h.sent[1] } });
  assert.equal(duplicate.message.customType, "question-answer-discarded");
  assert.deepEqual(duplicate.message.content, []);
  assert.deepEqual(h.emit("context", { messages: [first, duplicate.message] }).messages, [first]);
  h.emit("session_shutdown", { reason: "reload" });
});

test("Tab starts the cursor on the first option of the next question", async () => {
  const h = harness();
  const options = [{ label: "Yes" }, { label: "No" }];
  const pending = h.execute("tab", { questions: [{ question: "One?", options }, { question: "Two?", options }] });
  await flush();
  h.key("\x1b[B"); // down: cursor on "No" of the first question
  h.key("\t");
  h.key(" "); // toggles the focused option of the second question
  h.key("\r"); // submit (second question is last)
  const result = await pending;
  assert.match(result.content[0].text, /Two\?[\s\S]*Yes/);
  assert.doesNotMatch(result.content[0].text, /Two\?[\s\S]*No/);
});

test("context is shown above the questions and not echoed in the result", async () => {
  const h = harness();
  const pending = h.execute("ctx", { context: "Choosing the release day.", ...params("Ship?") });
  await flush();
  const view = h.render()!;
  assert.ok(view.indexOf("Choosing the release day.") < view.indexOf("Ship?"));
  h.key("\r");
  const result = await pending;
  assert.doesNotMatch(result.content[0].text, /release day/);
});

test("chat while a live blocking question is minimized moves it, with its draft, to the background", async () => {
  const h = harness();
  const blocking = h.execute("blocking", params("Blocking?"));
  await flush();
  h.key("kept draft");
  h.key("\x1b");
  assert.match(h.widget()!, /chatting moves the blocking one to background/);
  await h.emit("input", { source: "interactive", text: "Something else first" });
  const result = await blocking;
  assert.equal(result.details.backgrounded, true);
  assert.match(result.content[0].text, /Moved to background/);
  // Persisted under the original call, so recovery and receipt repair skip it.
  const batch = [...loadBackgroundBatches(h.branch()).values()][0];
  assert.equal(batch.pending.toolCallId, "blocking");
  assert.equal(h.visible(), 0, "the user chose the chat; the form stays minimized");
  await h.reopen();
  assert.match(h.render()!, /kept draft/);
  h.key("\r"); await flush();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].content, /answered[\s\S]*kept draft/);
  h.emit("session_shutdown", { reason: "reload" });
});

test("Ctrl+C dismisses a blocking question", async () => {
  const h = harness();
  const blocking = h.execute("blocking", params("Blocking?"));
  await flush();
  h.key("note");
  h.key("\x03");
  const result = await blocking;
  assert.equal(result.details.dismissed, true);
  assert.match(result.content[0].text, /dismissed/);
  assert.equal(h.visible(), 0);
});

test("background dismissal informs the agent without waking it", async () => {
  const h = harness();
  await h.execute("call", { ...params("Dismiss me?"), blocking: false });
  h.key("\x03"); await flush();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, { triggerTurn: false });
  assert.match(h.sent[0].content, /dismissed your background question[\s\S]*Dismiss me\?/);
  assert.equal([...loadBackgroundBatches(h.branch()).values()][0].answered?.result.details.dismissed, true);
  assert.equal(h.visible(), 0);
  h.emit("session_shutdown", { reason: "reload" });
});

test("header actions name their keys and are clickable", async () => {
  const h = harness();
  const blocking = h.execute("blocking", params("Blocking?"));
  await flush();
  const header = h.render()!.split("\n")[0];
  assert.match(header, /ctrl\+c dismiss · esc minimize ─$/);
  assert.doesNotMatch(h.render()!, /Esc minimize/);
  const at = (label: string) => header.indexOf(label);
  assert.equal(h.mouse({ type: "press", x: 0 }), undefined, "the border is not a target");
  assert.deepEqual(h.mouse({ type: "press", x: at("esc minimize") }), { handled: true });
  h.mouse({ type: "click", x: at("esc minimize") });
  assert.equal(h.visible(), 0);
  await h.reopen();
  h.mouse({ type: "click", x: at("ctrl+c dismiss") + 3 });
  assert.equal((await blocking).details.dismissed, true);
});
