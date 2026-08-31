// Focused rendering and input component for the question UI.

import { Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type Component,
  type EditorTheme,
  Key,
  matchesKey,
  truncateToWidth,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  clampCursor,
  escapeAction,
  formatBatchResult,
  isNoteRow,
  type QuestionModalOutcome,
  type QuestionParams,
} from "./core.ts";
export interface QuestionModalActions {
  minimize(): void;
  skip(): void;
}

export interface QuestionModalDraft {
  /** Persistent values survive disposable dock presentations. */
  checked: boolean[][];
  noteText: string[];
  activeQuestion: number;
  selectedRow: number;
}

/** Correctness by Construction: every question and option gets matching draft state. */
export function createQuestionModalDraft(
  params: QuestionParams,
): QuestionModalDraft {
  return {
    checked: params.questions.map((question) =>
      question.options.map(() => false),
    ),
    noteText: params.questions.map(() => ""),
    activeQuestion: 0,
    selectedRow: 0,
  };
}

/** Creates one question component. Lifecycle and result formatting stay in modal.ts. */
export function createQuestionModalComponent(
  tui: TUI,
  theme: Theme,
  params: QuestionParams,
  coreQuestions: { question: string; labels: string[] }[],
  draft: QuestionModalDraft,
  minimizable: boolean,
  actions: QuestionModalActions,
  finish: (outcome: QuestionModalOutcome) => void,
): Component {
  const questions = params.questions;
  const multi = questions.length > 1;
  // Draft state lives outside this disposable presentation. Cursor position
  // alone drives behavior — no separate edit/nav mode (KISS).
  let cachedLines: string[] | undefined;
  // Width the cache was built at. A terminal resize calls render() with a new
  // width but no state change, so the cache must also invalidate on width
  // change — otherwise stale lines persist until the next keypress.
  let cachedWidth: number | undefined;

  const editorTheme: EditorTheme = {
    borderColor: (s) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    },
  };
  // One editor per question — each keeps its own note text + cursor; the
  // active question's editor is shown in its note row and swaps on Tab.
  const noteEditors = questions.map((_, questionIndex) => {
    const editor = new Editor(tui, editorTheme);
    editor.setText(draft.noteText[questionIndex]);
    return editor;
  });
  const noteEditor = () => noteEditors[draft.activeQuestion];

  const optCount = () => questions[draft.activeQuestion].options.length;

  function refresh() {
    cachedLines = undefined;
    tui.requestRender();
  }

  function submit() {
    const r = formatBatchResult(
      coreQuestions,
      draft.checked,
      draft.noteText,
    );
    finish({
      kind: "answered",
      answer: { answers: r.answers, notes: r.notes, content: r.content },
    });
  }

  // Move the active question by dir (±1), wrapping around. Keep the cursor on
  // the note row if it was there; otherwise clamp it into the new question's
  // option range so it never points past the shorter list.
  function switchQuestion(dir: number) {
    const n = questions.length;
    const wasNote = isNoteRow(draft.selectedRow, optCount());
    draft.activeQuestion = (draft.activeQuestion + dir + n) % n;
    draft.selectedRow = wasNote
      ? optCount()
      : clampCursor(draft.selectedRow, optCount());
    refresh();
  }

  function handleInput(data: string) {
    // Enter: auto-accept the focused option first if the active question is
    // unchecked and the cursor is on an option row (so Enter accepts the
    // recommended/first option). On the note row, or when the active
    // question already has a pick, no checkbox changes. Then: on the last
    // question, submit the whole batch; otherwise advance to the next
    // question (non-wrapping) and reset the cursor to its first option — a
    // fresh start each step. Enter never wraps past the end; Tab wraps.
    if (matchesKey(data, Key.enter)) {
      const onOptionRow = !isNoteRow(draft.selectedRow, optCount());
      if (onOptionRow && !draft.checked[draft.activeQuestion].some(Boolean)) {
        draft.checked[draft.activeQuestion][draft.selectedRow] = true;
      }
      if (draft.activeQuestion === questions.length - 1) {
        submit();
      } else {
        draft.activeQuestion += 1;
        draft.selectedRow = 0;
        refresh();
      }
      return;
    }
    // Esc never cancels: it minimizes, or resolves a non-minimizable
    // (gate-opened) modal as skipped. See escapeAction() for why.
    if (matchesKey(data, Key.escape)) {
      if (escapeAction(minimizable) === "minimize") actions.minimize();
      else actions.skip();
      return;
    }
    // Tab / Shift+Tab switch the active question (options swap). Intercepted
    // before note handling so Tab switches even while editing the note.
    if (matchesKey(data, Key.tab)) {
      switchQuestion(1);
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      switchQuestion(-1);
      return;
    }
    // ↑/↓ move within the active question's option rows + the global note row.
    if (matchesKey(data, Key.up)) {
      draft.selectedRow = clampCursor(draft.selectedRow - 1, optCount());
      refresh();
      return;
    }
    if (matchesKey(data, Key.down)) {
      draft.selectedRow = clampCursor(draft.selectedRow + 1, optCount());
      refresh();
      return;
    }
    // Note row: the active question's editor is active — forward all other
    // input (incl. Space) to it.
    if (isNoteRow(draft.selectedRow, optCount())) {
      noteEditor().handleInput(data);
      draft.noteText[draft.activeQuestion] = noteEditor().getText();
      refresh();
      return;
    }
    // Option row: Space toggles its checkbox. Any other key forwards to the
    // note editor; focus jumps to the note row only if that keystroke actually
    // changed the note text (so typing lands in the note without navigating,
    // while a stray ←/→ won't steal focus).
    if (matchesKey(data, Key.space)) {
      const row = draft.checked[draft.activeQuestion];
      row[draft.selectedRow] = !row[draft.selectedRow];
      refresh();
      return;
    }
    const before = noteEditor().getText();
    noteEditor().handleInput(data);
    draft.noteText[draft.activeQuestion] = noteEditor().getText();
    if (noteEditor().getText() !== before) {
      draft.selectedRow = optCount(); // note row
    }
    refresh();
  }

  // Wrap a styled block: wrap raw text, then reapply style per line (tui
  // resets SGR each line). The prefix is shown at the start of every wrapped
  // line; its VISIBLE width is subtracted from the wrap budget. style receives
  // the wrapped-line index so callers can treat line 0 specially.
  function addWrapped(
    lines: string[],
    width: number,
    raw: string,
    prefix: string,
    style: (t: string, lineIdx: number) => string,
  ) {
    const wrapped = wrapTextWithAnsi(
      raw,
      Math.max(1, width - visibleWidth(prefix)),
    );
    for (let li = 0; li < wrapped.length; li++) {
      lines.push(truncateToWidth(prefix + style(wrapped[li], li), width));
    }
  }

  // One option row for question qi at option index i, with checkbox, 1-based
  // number, optional tag pill (first wrapped line only), and description.
  function renderOption(
    lines: string[],
    width: number,
    qi: number,
    i: number,
  ) {
    const opt = questions[qi].options[i];
    const onRow = qi === draft.activeQuestion && draft.selectedRow === i;
    const box = draft.checked[qi][i] ? "[x]" : "[ ]";
    const prefix = onRow ? theme.fg("accent", "> ") : "  ";
    const labelStyle = (t: string) =>
      onRow || draft.checked[qi][i]
        ? theme.fg("accent", t)
        : theme.fg("text", t);
    // Tag pill: reverse-video on the semantic color, before the label. Its pad
    // spaces are part of the RAW text so wrap-width math matches visible width.
    const pill = opt.tag ? ` ${opt.tag} ` : "";
    const pillColor = opt.tagColor ?? "accent";
    const tagRaw = pill ? `${pill} ` : "";
    addWrapped(
      lines,
      width,
      `${box} ${i + 1}. ${tagRaw}${opt.label}`,
      prefix,
      (t, li) => {
        if (li === 0 && pill) {
          const at = t.indexOf(pill);
          if (at >= 0)
            return (
              labelStyle(t.slice(0, at)) +
              theme.inverse(theme.fg(pillColor, pill)) +
              labelStyle(t.slice(at + pill.length))
            );
        }
        return labelStyle(t);
      },
    );
    if (opt.description) {
      // 9 cols = 2 gutter + len("[x] N. "), so description aligns under label.
      addWrapped(lines, width, opt.description, "         ", (t) =>
        theme.fg("muted", t),
      );
    }
  }

  function renderNote(lines: string[], width: number) {
    const noteFocused = isNoteRow(draft.selectedRow, optCount());
    const notePointer = noteFocused ? theme.fg("accent", "> ") : "  ";
    lines.push(
      truncateToWidth(
        notePointer +
          theme.fg("muted", "Note:") +
          (noteFocused ? theme.fg("accent", " ✎") : ""),
        width,
      ),
    );
    for (const line of noteEditor().render(width - 2)) {
      lines.push(truncateToWidth(` ${line}`, width));
    }
  }

  function render(width: number): string[] {
    if (cachedLines && cachedWidth === width) return cachedLines;
    const lines: string[] = [];
    lines.push(
      truncateToWidth(theme.fg("accent", "─".repeat(width)), width),
    );

    if (multi) {
      // Count banner.
      lines.push(
        truncateToWidth(
          " " +
            theme.fg("accent", `${questions.length} questions`) +
            theme.fg(
              "muted",
              " — Tab to switch, Enter advances (submits on last)",
            ),
          width,
        ),
      );
      lines.push("");
      // Question list: ">" marker on the active question, ○/✓ answered glyph,
      // full wrapped question text so nothing is lost when a question is long.
      for (let qi = 0; qi < questions.length; qi++) {
        const onQ = qi === draft.activeQuestion;
        // Answered = at least one option checked OR a non-empty note.
        const answered =
          draft.checked[qi].some(Boolean) ||
          noteEditors[qi].getText().trim() !== "";
        const marker = onQ ? theme.fg("accent", "> ") : "  ";
        const glyph = answered ? "✓" : "○";
        const qStyle = (t: string) =>
          onQ ? theme.fg("accent", t) : theme.fg("text", t);
        addWrapped(
          lines,
          width,
          `${glyph} ${qi + 1}. ${questions[qi].question}`,
          marker,
          (t, li) => {
            if (li === 0) {
              const g = answered
                ? theme.fg("success", glyph)
                : theme.fg("muted", glyph);
              return g + qStyle(t.slice(1)); // t.slice(1) drops the 1-col glyph
            }
            return qStyle(t);
          },
        );
      }
      lines.push(
        truncateToWidth(
          " " +
            theme.fg(
              "dim",
              "─".repeat(Math.max(1, Math.min(width - 2, 8))),
            ),
          width,
        ),
      );
      // Active question's options swap here.
      for (let i = 0; i < questions[draft.activeQuestion].options.length; i++) {
        renderOption(lines, width, draft.activeQuestion, i);
      }
    } else {
      // Single question: plain layout (question text, then options).
      addWrapped(lines, width, questions[0].question, " ", (t) =>
        theme.fg("text", t),
      );
      for (let i = 0; i < questions[0].options.length; i++) {
        renderOption(lines, width, 0, i);
      }
    }

    renderNote(lines, width);
    // Hint is context-aware: Enter submits only on the last question,
    // otherwise it advances to the next.
    const onLast = draft.activeQuestion === questions.length - 1;
    const hint = multi
      ? ` Tab switch • ↑↓ move • Space toggle • Enter ${onLast ? "submit" : "next"} • Esc minimize`
      : " ↑↓ move • Space toggle • type → note • Enter submit • Esc minimize";
    lines.push(truncateToWidth(theme.fg("dim", hint), width));
    lines.push(
      truncateToWidth(theme.fg("accent", "─".repeat(width)), width),
    );

    cachedLines = lines;
    cachedWidth = width;
    return lines;
  }

  return {
    render,
    invalidate: () => {
      cachedLines = undefined;
    },
    handleInput,
  };
}
