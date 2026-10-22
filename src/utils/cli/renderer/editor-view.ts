// EditorView: the stage-3b contract object. Composes LineEditor + Popup +
// History, consumes StdinBuffer KeyEvents, and emits the frame-driver events.
// No process/global access anywhere in this file set -- the bridge owns the
// Terminal, the StdinBuffer lifecycle, frame painting, and every response to
// the events below.
//
// Binding map (§4's surviving readline defaults, documented choices):
//   enter/ctrl-j   SUBMIT (popup open -> accept instead)
//   esc            popup open -> close; else INTERRUPT (stash buffer to draft, §4)
//   interrupt      always INTERRUPT (Decisions 2: mirrors Esc, never quits)
//   eof            buffer empty -> QUIT; else delete-forward (readline default)
//   ctrl-a/e       buffer start/end          left/right  cluster steps
//   ctrl-b/f       alias left/right          alt-b/f, ctrl-left/right  word steps
//   backspace/ctrl-h  delete cluster before cursor
//   delete         delete cluster under cursor; ctrl-delete kills word forward
//   ctrl-k/u/w     kill line/start/word      ctrl-y yank (ring merges consecutive kills)
//   ctrl-l         REDRAW (frame repaint)
//   tab / shift-tab  popup next / prev; Tab with no popup requests one
//   up/down        popup open -> cycle; visual rows first; history at the edges
//   ctrl-x         UNHANDLED (stage 3b: dictation toggle binds it)
// Any other key is UNHANDLED so the bridge can extend bindings without an
// editor fork.

import type { KeyEvent } from "./keyevents.ts";
import type { StdinBuffer } from "./stdin-buffer.ts";
import { LineEditor, type EditorBlockView } from "./line-editor.ts";
import { History } from "./history.ts";
import { Popup, POPUP_MAX_ROWS, type Completion, type PopupCloseReason } from "./popup.ts";

export interface EditorViewOptions {
  history?: History;
  /** Viewport width, read at key time (§6 read-per-line posture); bridge passes terminal.columns. */
  width?: () => number;
}

export type EditorEvent =
  | { type: "submit"; text: string }
  | { type: "interrupt" }
  | { type: "quit" }
  | { type: "redraw" }
  | { type: "history"; phase: "prev" | "next" | "draft"; text: string }
  | { type: "popup"; phase: "request"; word: string; from: number; to: number }
  | { type: "popup"; phase: "open"; count: number }
  | { type: "popup"; phase: "close"; reason: PopupCloseReason }
  | { type: "popup"; phase: "accept"; text: string }
  | { type: "unhandled"; key: string }
  | { type: "change" };

const KILL_RING_MAX = 16;

export class EditorView {
  readonly editor: LineEditor;
  readonly popup: Popup;
  readonly history: History;

  private readonly width: () => number;
  private readonly subs = new Set<(e: EditorEvent) => void>();
  private killRing: string[] = [];
  private lastOpWasKill = false;
  private offStdin: (() => void) | null = null;

  /**
   * Bracketed-paste policy delegate (stage 3b). When set, paste events hand
   * the raw payload to this function INSTEAD of the default insertText, so
   * the session layer can turn multi-line payloads into [Paste #N] markers;
   * the handler is expected to place text via insertText itself. Dictation
   * transcripts keep calling insertText directly and are never re-filtered.
   */
  pasteHandler: ((text: string) => void) | null = null;

  constructor(opts: EditorViewOptions = {}) {
    this.editor = new LineEditor();
    this.popup = new Popup();
    this.history = opts.history ?? new History();
    this.width = opts.width ?? (() => 80);
  }

  /** Pipe a StdinBuffer's events in; the returned fn detaches BOTH sides. */
  attachStdin(stdin: StdinBuffer): () => void {
    this.detachStdin();
    const offKeys = stdin.subscribe((e) => this.feedKey(e));
    this.offStdin = offKeys;
    return () => this.detachStdin();
  }

  private detachStdin(): void {
    if (this.offStdin) {
      this.offStdin();
      this.offStdin = null;
    }
  }

  onEvent(cb: (e: EditorEvent) => void): () => void {
    this.subs.add(cb);
    return () => void this.subs.delete(cb);
  }

  // ── state access (frame composer) ──────────────────────────────────────

  get text(): string {
    return this.editor.buffer;
  }

  get cursor(): number {
    return this.editor.cursorOffset;
  }

  get popupOpen(): boolean {
    return this.popup.isOpen;
  }

  setPrompt(p: string): void {
    this.editor.setPrompt(p); // bridge repaints at its own pace (MODEL_CHANGE)
  }

  /** Wrapped editor block + cursor, optionally windowed to maxRows. */
  view(width?: number, maxRows?: number): EditorBlockView {
    return this.editor.view(width ?? this.width(), maxRows);
  }

  /** Popup frame rows (composer places them ABOVE the editor block, §4). */
  popupRows(width?: number, maxRows = POPUP_MAX_ROWS): string[] {
    return this.popup.renderRows(width ?? this.width(), maxRows);
  }

  /** Programmatic insert at the cursor (stage 3b: dictation transcript). */
  insertText(text: string): void {
    const clean = sanitizePaste(text);
    if (clean === "") return;
    this.editor.insert(clean);
    this.lastOpWasKill = false;
    this.afterEdit();
  }

  /** Replace the whole line (bridge-side retarget, tests). */
  setText(text: string): void {
    this.editor.setText(text);
    this.lastOpWasKill = false;
    this.afterEdit();
  }

  /** §4 interrupt stash used by the bridge's own Esc paths (question mode). */
  stashToDraft(): void {
    const text = this.editor.buffer;
    if (text !== "") this.history.saveDraft(text);
    this.editor.setText("");
  }

  // ── key handling ───────────────────────────────────────────────────────

  feedKey(e: KeyEvent): void {
    if (e.kind === "text") {
      if (e.text === "") return;
      this.editor.insert(e.text);
      this.lastOpWasKill = false;
      this.afterEdit();
      return;
    }
    if (e.kind === "paste") {
      if (this.pasteHandler) {
        this.pasteHandler(e.text);
        return;
      }
      this.insertText(e.text);
      return;
    }
    this.handleKey(e.name);
  }

  /**
   * Explicit popup open from the bridge (providers resolved externally).
   * A zero-match set never opens (Popup refuses); replacing an already-open
   * popup with candidates that match nothing closes it, reason "no-match".
   * "open" reports matchCount -- the rows the composer paints -- not the raw
   * candidate count the bridge handed in.
   */
  openPopup(candidates: Completion[], from?: number): void {
    const spanFrom = from ?? this.editor.wordStartBackward();
    const prefix = this.editor.buffer.slice(spanFrom, this.editor.cursorOffset);
    const wasOpen = this.popup.isOpen;
    this.popup.openPopup(candidates, spanFrom, prefix);
    if (this.popup.isOpen) this.emit({ type: "popup", phase: "open", count: this.popup.matchCount });
    else if (wasOpen) this.emit({ type: "popup", phase: "close", reason: "no-match" });
  }

  private handleKey(rawName: string): void {
    const name = rawName.toLowerCase();
    switch (name) {
      case "enter":
      case "ctrl-j":
        if (this.popup.isOpen) this.acceptPopup();
        else this.submit();
        return;
      case "esc":
        if (this.popup.isOpen) this.closePopup("esc");
        else this.interrupt();
        return;
      case "interrupt": // 0x03: pure interrupt, mirrors Esc (Decisions 2)
        this.closePopup("interrupt");
        this.interrupt();
        return;
      case "eof":
        if (this.editor.buffer === "") this.emit({ type: "quit" });
        else if (this.editor.deleteForward()) {
          this.lastOpWasKill = false;
          this.afterEdit();
        }
        return;
      case "backspace":
      case "ctrl-h":
      case "alt-backspace":
        if (name === "alt-backspace") this.kill(this.editor.killWordBackward(), true);
        else if (this.editor.backspace()) {
          this.lastOpWasKill = false;
          this.afterEdit();
        }
        return;
      case "delete":
        if (this.editor.deleteForward()) {
          this.lastOpWasKill = false;
          this.afterEdit();
        }
        return;
      case "ctrl-delete":
        this.kill(this.editor.killWordForward(), false);
        return;
      case "left":
        this.moveCursor(() => this.editor.moveLeft());
        return;
      case "right":
        this.moveCursor(() => this.editor.moveRight());
        return;
      case "home":
      case "ctrl-a":
        this.moveCursor(() => this.editor.moveToStart());
        return;
      case "end":
      case "ctrl-e":
        this.moveCursor(() => this.editor.moveToEnd());
        return;
      case "alt-b":
      case "ctrl-left":
        this.moveCursor(() => this.editor.backwardWord());
        return;
      case "alt-f":
      case "ctrl-right":
        this.moveCursor(() => this.editor.forwardWord());
        return;
      case "ctrl-k":
        this.kill(this.editor.killLine(), false);
        return;
      case "ctrl-u":
        this.kill(this.editor.killToStart(), true);
        return;
      case "ctrl-w":
        this.kill(this.editor.killWordBackward(), true);
        return;
      case "ctrl-y":
        this.yank();
        return;
      case "ctrl-l":
        this.emit({ type: "redraw" });
        return;
      case "tab":
        if (this.popup.isOpen) {
          this.popup.next();
          this.emit({ type: "change" });
        } else {
          const from = this.editor.wordStartBackward();
          this.emit({
            type: "popup",
            phase: "request",
            word: this.editor.buffer.slice(from, this.editor.cursorOffset),
            from,
            to: this.editor.cursorOffset,
          });
        }
        return;
      case "shift-tab":
        if (this.popup.isOpen) {
          this.popup.prev();
          this.emit({ type: "change" });
        } else this.emit({ type: "unhandled", key: rawName });
        return;
      case "up":
        this.handleUpDown(-1);
        return;
      case "down":
        this.handleUpDown(1);
        return;
      default:
        this.emit({ type: "unhandled", key: rawName });
    }
  }

  private handleUpDown(delta: number): void {
    if (this.popup.isOpen) {
      if (delta < 0) this.popup.prev();
      else this.popup.next();
      this.emit({ type: "change" });
      return;
    }
    const moved = this.editor.moveVisual(delta, this.width());
    if (moved === "moved") {
      this.lastOpWasKill = false;
      this.emit({ type: "change" });
      return;
    }
    if (delta < 0) {
      if (!this.history.walkActive) {
        // Up with no entries to show must NOT begin a walk: stashing a draft
        // that prev() can never displace latches walkActive, and a later
        // Down buries freshly typed text under that phantom draft.
        if (this.history.size === 0) return;
        this.history.beginWalk(this.editor.buffer);
      }
      const t = this.history.prev();
      if (t !== null) {
        this.editor.setText(t);
        this.lastOpWasKill = false;
        this.emit({ type: "history", phase: "prev", text: t });
      }
      return;
    }
    if (this.history.walkActive) {
      const t = this.history.next();
      if (t === null) {
        const draft = this.history.takeDraft() ?? "";
        this.editor.setText(draft);
        this.emit({ type: "history", phase: "draft", text: draft });
      } else {
        this.editor.setText(t);
        this.emit({ type: "history", phase: "next", text: t });
      }
    }
  }

  // ── ops ────────────────────────────────────────────────────────────────

  private submit(): void {
    this.closePopup("submit");
    const text = this.editor.buffer;
    this.history.append(text);
    this.editor.setText("");
    this.lastOpWasKill = false;
    this.emit({ type: "submit", text });
  }

  private interrupt(): void {
    this.stashToDraft(); // §4: recoverable, not destructive
    this.lastOpWasKill = false;
    this.emit({ type: "interrupt" });
  }

  private acceptPopup(): void {
    const from = this.popup.from;
    const acc = this.popup.accept();
    if (!acc) {
      this.closePopup("accept");
      return;
    }
    this.editor.insert(acc.text, from);
    this.lastOpWasKill = false;
    this.emit({ type: "popup", phase: "accept", text: acc.text });
    this.afterEdit(); // popup already closed; emits change
  }

  private closePopup(reason: PopupCloseReason): void {
    if (!this.popup.isOpen) return;
    this.popup.close();
    this.emit({ type: "popup", phase: "close", reason });
  }

  /** Cursor motion outside the popup flow invalidates the replace span. */
  private closePopupOnCursorMove(): void {
    this.closePopup("edit");
  }

  /**
   * Cursor-only motion: close the popup, and emit a change ONLY when the
   * cursor actually moved. A motion key that paints nothing is the bug this
   * fixes: the bridge repaints on "change" and repaint places the physical
   * cursor block (commit.ts placeCursor), so a silent cursor move left the
   * on-screen cursor parked at the old cell while the virtual cursor moved.
   * No-move keys (arrow at buffer edge) stay silent -- no gratuitous repaint.
   */
  private moveCursor(move: () => void): void {
    this.closePopupOnCursorMove();
    const before = this.editor.cursorOffset;
    move();
    if (this.editor.cursorOffset !== before) {
      this.lastOpWasKill = false;
      this.emit({ type: "change" });
    }
  }

  private kill(killed: string, backward: boolean): void {
    if (killed === "") return;
    if (this.lastOpWasKill && this.killRing.length > 0) {
      // consecutive kills accumulate into one yank unit (readline behavior)
      const top = this.killRing[this.killRing.length - 1]!;
      this.killRing[this.killRing.length - 1] = backward ? killed + top : top + killed;
    } else {
      this.killRing.push(killed);
      if (this.killRing.length > KILL_RING_MAX) this.killRing.shift();
    }
    this.lastOpWasKill = true;
    this.afterEdit();
  }

  private yank(): void {
    const top = this.killRing[this.killRing.length - 1];
    if (!top) return;
    this.editor.insert(top);
    this.lastOpWasKill = false;
    this.afterEdit();
  }

  /** Buffer mutated: re-filter an open popup, then tell the bridge. */
  private afterEdit(): void {
    if (this.popup.isOpen) {
      const cursor = this.editor.cursorOffset;
      if (cursor < this.popup.from) this.closePopup("edit");
      else {
        this.popup.setFilter(this.editor.buffer.slice(this.popup.from, cursor));
        if (this.popup.exhausted) this.closePopup("no-match");
      }
    }
    this.emit({ type: "change" });
  }

  private emit(e: EditorEvent): void {
    for (const cb of [...this.subs]) cb(e);
  }
}

/**
 * Paste/dictation hygiene: CRLF and bare CR normalize to \n (submitting is
 * Enter's ONLY job -- a pasted CR must not submit, and inside bracketed paste
 * framing the byte reached us as literal text); other C0/C1 controls and DEL
 * are dropped; U+FFFD is dropped. Paste-marker semantics ([Paste #N]) are a
 * 3b policy layered on top of this buffer text, per §4.
 */
export function sanitizePaste(s: string): string {
  const normalized = s.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  let out = "";
  for (const ch of normalized) {
    const cc = ch.codePointAt(0)!;
    if (cc === 0x09 || cc === 0x0a) {
      out += ch;
      continue;
    }
    if (cc < 0x20 || (cc >= 0x7f && cc <= 0x9f) || cc === 0xfffd) continue;
    out += ch;
  }
  return out;
}
