// [Paste #N - M lines] markers for the stage-3b EDITOR input path.
//
// The legacy readline path implements these semantics inside
// ./clipboard-paste.ts by swapping readline's raw stdin listener; the editor
// path has no listener chain to hijack, so this small controller hangs off
// the EditorView paste hook instead: a multi-line (or long single-line)
// paste collapses into an inline `[Paste #N - M lines]` token in the buffer
// while the real content waits in an index, and normalize() swaps the
// content back in exactly once when the line is submitted. ClipboardPaste-
// Interceptor stays byte-identical for the legacy path; the marker rules
// here mirror its #finishPaste/normalize/onInterrupt (including the "0 =
// always marker" pasteMarkerMinChars semantics and the surrounding-newline
// exception for short pastes) on top of the buffer text the StdinBuffer's
// bracketed-paste framing delivers.
//
// Deliberate shape choice: the content is normalized with sanitizePaste
// (CRLF/CR to \n, non-text C0/C1/DEL/U+FFFD dropped) rather than the
// legacy's CRLF-only replace, because the editor path already treats every
// other insertion through that same sanitizer and a marker's stored content
// must match what could ever be typed.

import { sanitizePaste } from "@utils/cli/renderer/editor-view.ts";
import { ExtensionError } from "@core/error.ts";

export interface EditorPasteMarkersOptions {
  /**
   * Minimum length for a single-line paste to insert as-is; longer or any
   * multi-line paste gets a marker. 0 = always marker. Validated exactly
   * like ClipboardPasteInterceptor does, so both paths fail loud on the
   * same bad config value.
   */
  pasteMarkerMinChars: number;
  /** Places text at the editor cursor (EditorView.insertText). */
  insert(text: string): void;
}

interface PasteEntry {
  content: string;
  /** true once the content has been rendered into a submitted line */
  seen: boolean;
}

export class EditorPasteMarkers {
  readonly #minChars: number;
  readonly #insert: (text: string) => void;
  /** sequential marker number; incremented per paste, never reset */
  #seq = 0;
  /** marker number -> pasted content */
  #index = new Map<number, PasteEntry>();

  constructor(opts: EditorPasteMarkersOptions) {
    if (typeof opts.pasteMarkerMinChars !== "number" || opts.pasteMarkerMinChars < 0) {
      throw new ExtensionError(
        `paste-markers: pasteMarkerMinChars must be a non-negative number, got ${String(
          opts.pasteMarkerMinChars,
        )}`,
      );
    }
    this.#minChars = opts.pasteMarkerMinChars;
    this.#insert = opts.insert;
  }

  /**
   * One bracketed-paste payload arrived (raw text, before any insertion).
   * Short single-line pastes are indistinguishable from typing and insert
   * as-is (surrounding newlines do not disqualify them); everything else
   * becomes an inline marker token with the content stored for submit.
   */
  handlePaste(raw: string): void {
    const content = sanitizePaste(raw);
    if (content === "") return;

    if (content.length < this.#minChars) {
      const trimmed = content.replace(/^\n+|\n+$/g, "");
      if (!trimmed.includes("\n")) {
        this.#insert(trimmed);
        return;
      }
    }

    const tailTrimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
    const lines = tailTrimmed.length === 0 ? 1 : tailTrimmed.split("\n").length;
    this.#seq += 1;
    this.#index.set(this.#seq, { content, seen: false });
    this.#insert(`[Paste #${this.#seq} - ${lines} line${lines === 1 ? "" : "s"}]`);
  }

  /**
   * Replace paste markers with their real content. Call exactly once per
   * submitted line (main prompt or question answer). Each marker's content
   * is inserted at most once; later occurrences of the same marker stay
   * plain text, and markers edited out of the submitted line are dropped so
   * their content can never be substituted into a later line.
   */
  normalize(line: string): string {
    if (this.#index.size === 0) return line;
    let out = "";
    let last = 0;
    for (const m of line.matchAll(/\[Paste #(\d+) - \d+ lines?\]/g)) {
      const entry = this.#index.get(Number(m[1]));
      if (entry && !entry.seen) {
        out += line.slice(last, m.index) + entry.content;
        entry.seen = true;
        last = m.index + m[0].length;
      }
    }
    out += line.slice(last);
    for (const [num, entry] of this.#index) {
      if (!entry.seen) this.#index.delete(num);
    }
    return out;
  }

  /** Interrupt: the line buffer is gone, so every recorded marker is dropped. */
  onInterrupt(): void {
    this.#index.clear();
  }
}
