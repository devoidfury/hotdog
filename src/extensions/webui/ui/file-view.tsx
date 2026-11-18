/// <reference lib="dom" />
// READ-ONLY file VIEWER: the workbench's "file" tab body (tab id = path, so
// reopening the same path reuses the tab). Pages come from C2S readFile
// (see ../websocket/handlers-files.ts): TEXT ONLY, line-addressed, with the
// server's honest one-line rejections rendered VERBATIM.
//
// State doctrine mirrors file-tree.tsx: pure (state, args) -> { state,
// fetch }; the app dispatches fetches and feeds replies back through
// applyReadFile, which drops unknown/superseded request ids.
//
// ── THE LINE-ADDRESSING SEAM (Phase 7 consumes this; spec) ─────────────────
// - Every rendered line row carries data-line="<N>" with N 1-BASED (editor
//   convention; the wire's offset is 0-based lines-to-skip, so wire
//   offset = N - 1 and the next unread wire offset is always
//   entry.lines.length).
// - The rows live inside the container `.file-view-rows`; revealLine(root, N)
//   (exported below) resolves `[data-line="N"]` within the mounted viewer
//   and scrolls it into view, returning whether the row exists.
// - A line past the loaded window does NOT exist in the DOM yet: a jump to
//   line N must first request the page containing it (readFile with
//   offset = N - 1), apply the reply, then revealLine. Concatenation is
//   line-boundary exact server-side, so loaded lines and jumped-to lines
//   never disagree.
// - Reveal targets that were never read (truncated pager not reached)
//   legitimately resolve to nothing until their page lands; revealLine
//   returns false rather than guessing.

import { getTokenizer, guessLangForBase, listRenderableLangs, type SyntaxRun } from "@utils/syntax/index.ts";
import { hasFrontmatter, tokenizeMarkdownDoc } from "@utils/syntax/markdown.ts";
import type { ReadFileResultWire } from "@extensions/websocket/protocol.ts";
import { IconReload, IconWhitespace } from "./icons.tsx";
import { codeSpans } from "./ws-render.tsx";

// ── Language guessing (display only) ────────────────────────────────────────
// The registry owns the name metadata: every SyntaxDef names its own
// extensions and basenames (see index.ts). Registry contract: getTokenizer
// returns undefined for an unknown or scannerless lang and the viewer
// renders PLAIN TEXT -- a def that guesses honestly without a scanner is
// exactly that posture, table entries and plain render agreeing.

/** Guess the tokenizer lang from the path's basename; undefined = plain. */
export function guessLang(path: string): string | undefined {
  return guessLangForBase(path.split(/[/\\]/).pop() ?? "");
}

/** Tokenize one line; unknown/absent lang (or a tokenizer-less line) means
 *  one plain run -- the registry contract, never a failure. */
export function tokenizeLine(line: string, lang: string | undefined): SyntaxRun[] {
  const tokenizer = lang !== undefined ? getTokenizer(lang) : undefined;
  if (!tokenizer) return [{ type: "default", text: line }];
  try {
    return tokenizer(line);
  } catch {
    return [{ type: "default", text: line }];
  }
}

/**
 * Tokenize the whole loaded window for rendering. Markdown is the one lang
 * with line-crossing state (fences, YAML frontmatter) and is deliberately
 * NOT in the stateless registry, so it drives `tokenizeMarkdownDoc` across
 * the loaded lines instead; frontmatter opens only behind the `hasFrontmatter`
 * prescan (opener on line 1 AND a visible closer), so a leading hr pair
 * never paints as yaml and profile-style files light up. The pager honest
 * limit: a frontmatter whose closer sits on an unread page reads plain
 * until that page lands. Every other lang keeps the per-line registry
 * path exactly as before.
 */
export function tokenizeFileLines(lines: string[], lang: string | undefined): SyntaxRun[][] {
  if (lang === "markdown") return tokenizeMarkdownDoc(lines, hasFrontmatter(lines));
  return lines.map((line) => tokenizeLine(line, lang));
}

// ── Pure state ───────────────────────────────────────────────────────────────

export interface FileViewEntry {
  status: "loading" | "ready" | "error";
  /** Accumulated lines WITHOUT terminators, in file order. data-line on a
   *  row is this index + 1; the next unread wire offset is this length. */
  lines: string[];
  /** The server said more lines exist past what we hold. */
  truncated: boolean;
  /** Honest one-line rejection, verbatim. A pager failure keeps the loaded
   *  lines on screen and stops the pager (refresh is the reload affordance). */
  error?: string;
  /** The foot bar's PAINT override (owner request 2026-11-14): a registry
   *  lang name -- "plain" forces the uncolored sheet -- or absent for the
   *  auto-guess. It is how the user asked to LOOK at the file, not part of
   *  the read: reload and paging preserve it, only setFileViewLang moves it. */
  lang?: string;
}

export interface FileViewsState {
  views: Record<string, FileViewEntry>;
  /** Monotonic request sequence (tree and viewer each own a counter). */
  seq: number;
  /** requestId (string-keyed) -> the path it asked for. */
  pending: Record<string, string>;
}

/** A readFile request an op wants the app to dispatch. */
export interface FileFetch {
  requestId: number;
  path: string;
  /** 0-based lines to skip (the core read tool's grammar). */
  offset: number;
}

export function emptyFileViews(): FileViewsState {
  return { views: {}, seq: 0, pending: {} };
}

function mintAndFetch(
  s: FileViewsState,
  path: string,
  entry: FileViewEntry,
): { state: FileViewsState; fetch: FileFetch } {
  const requestId = s.seq + 1;
  const state: FileViewsState = {
    views: { ...s.views, [path]: entry },
    seq: requestId,
    pending: { ...s.pending, [String(requestId)]: path },
  };
  return { state, fetch: { requestId, path, offset: entry.lines.length } };
}

/** Tab opened (or the same tab re-activated): fetch ONLY when the path has
 *  no entry yet -- "reopen must not wipe the state hung off the tab"
 *  (openTab doctrine). Reload is the explicit re-read. */
export function openFileView(
  s: FileViewsState,
  path: string,
): { state: FileViewsState; fetch: FileFetch | null } {
  if (s.views[path]) return { state: s, fetch: null };
  return mintAndFetch(s, path, { status: "loading", lines: [], truncated: false });
}

/** Reload: drop the accumulated page(s) and re-read from the top. The
 * chosen paint rides through: reload re-reads the BYTES, it does not
 * forget how the user asked to see them. */
export function reloadFileView(
  s: FileViewsState,
  path: string,
): { state: FileViewsState; fetch: FileFetch } {
  return mintAndFetch(s, path, {
    status: "loading",
    lines: [],
    truncated: false,
    lang: s.views[path]?.lang,
  });
}

/** Pager: fetch the next page from the first unread line. No-op while a
 *  request for this path is already in flight (pending map), on errored or
 *  exhausted views. */
export function moreFileView(
  s: FileViewsState,
  path: string,
): { state: FileViewsState; fetch: FileFetch | null } {
  const entry = s.views[path];
  if (!entry || entry.status !== "ready" || !entry.truncated || entry.error) {
    return { state: s, fetch: null };
  }
  for (const pendingPath of Object.values(s.pending)) {
    if (pendingPath === path) return { state: s, fetch: null }; // one page in flight
  }
  return mintAndFetch(s, path, entry);
}

/** content -> lines without terminators. Server pages end at line
 *  boundaries, so only a true EOF leaves a dangling final line. */
function splitPage(content: string): string[] {
  if (content === "") return [];
  const parts = content.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Server reply. Unknown/superseded ids drop (same-state return), the
 *  settings-viewer/search-panel precedent. */
export function applyReadFile(
  s: FileViewsState,
  requestId: number | undefined,
  result: ReadFileResultWire,
): FileViewsState {
  const path = requestId !== undefined ? s.pending[String(requestId)] : undefined;
  if (path === undefined) return s; // stale
  const pending = { ...s.pending };
  delete pending[String(requestId)];
  const entry = s.views[path] ?? { status: "loading" as const, lines: [], truncated: false };
  if (result.error) {
    if (entry.lines.length === 0) {
      return { ...s, pending, views: { ...s.views, [path]: { ...entry, status: "error", lines: [], truncated: false, error: result.error } } };
    }
    // Pager failure with content on screen: keep the lines, show the honest
    // text at the pager, stop paging (refresh re-reads from the top).
    return { ...s, pending, views: { ...s.views, [path]: { ...entry, truncated: false, error: result.error } } };
  }
  const lines = [...entry.lines, ...splitPage(result.content ?? "")];
  return {
    ...s,
    pending,
    views: {
      ...s.views,
      [path]: { ...entry, status: "ready", lines, truncated: result.truncated === true },
    },
  };
}

/** The foot bar's paint override: repaint this path's sheet with a chosen
 *  lang ("plain" forces the uncolored sheet), or null to hand it back to
 *  the auto-guess. Views only: a path with no entry has nothing mounted to
 *  recolor, and the same state object answers. */
export function setFileViewLang(
  s: FileViewsState,
  path: string,
  lang: string | null,
): FileViewsState {
  const entry = s.views[path];
  if (!entry) return s;
  const next: FileViewEntry = { ...entry };
  if (lang === null) delete next.lang;
  else next.lang = lang;
  return { ...s, views: { ...s.views, [path]: next } };
}

/** Rename landed: the entry MOVES with the file (tab identity follows the
 *  file, and the viewer's held lines are the same bytes under the new
 *  spelling -- the paint override rides too). In-flight requests for the OLD
 *  path are dropped from the pending map so their reply cannot resurrect a
 *  dead-keyed entry. A free path with no entry changes nothing (a never-
 *  opened file has nothing to carry). */
export function retargetFileView(
  s: FileViewsState,
  from: string,
  to: string,
): FileViewsState {
  const entry = s.views[from];
  if (!entry) return s;
  const views = { ...s.views };
  delete views[from];
  views[to] = entry;
  const pending = { ...s.pending };
  for (const id of Object.keys(pending)) {
    if (pending[id] === from) delete pending[id];
  }
  return { ...s, views, pending };
}

/** Delete (or rename-away) landed: forget the entry for `path` AND every
 *  path under it (a deleted directory takes its open files' views with it),
 *  plus any pending request pointing at a dead path -- the reply would
 *  otherwise resurrect a view whose bytes no longer exist. */
export function forgetFileViews(
  s: FileViewsState,
  path: string,
): FileViewsState {
  const under = (p: string): boolean =>
    p === path || p.startsWith(`${path}/`) || p.startsWith(`${path}\\`);
  let changed = false;
  const views = { ...s.views };
  for (const p of Object.keys(views)) {
    if (under(p)) {
      delete views[p];
      changed = true;
    }
  }
  const pending = { ...s.pending };
  for (const id of Object.keys(pending)) {
    if (under(pending[id]!)) {
      delete pending[id];
      changed = true;
    }
  }
  if (!changed) return s;
  return { ...s, views, pending };
}

// ── The reveal seam (Phase 7) ────────────────────────────────────────────────

/**
 * Reveal one 1-based line inside a mounted viewer body.
 *
 * @param root the mounted FileView root (the `.file-view` element; any
 *        ancestor of the rows works too -- the lookup is a descendant query).
 * @param line 1-based line number (data-line grammar, see header).
 * @returns true when the row was found and scrolled to; false when the line
 *          has not been loaded yet -- the caller must fetch a page containing
 *          it first (readFile offset = line - 1), apply, and retry.
 */
export function revealLine(root: HTMLElement, line: number): boolean {
  const row = root.querySelector(`[data-line="${line}"]`) as HTMLElement | null;
  if (!row) return false;
  row.scrollIntoView({ block: "center" });
  return true;
}

// ── Rendering ────────────────────────────────────────────────────────────────

export interface FileViewProps {
  /** The tab's path (= tab id). */
  path: string;
  /** Current view state; undefined renders as pending (the open op owns the
   *  fetch, this is the dumb projection). */
  view: FileViewEntry | undefined;
  onReload: (path: string) => void;
  /** Pager: fetch the next page (op no-ops while one is in flight). */
  onMore: (path: string) => void;
  /** Foot-bar syntax chooser wiring (see FileViewEntry.lang): the app owns
   *  the state, null answers "back to the auto-guess". Absent = no chooser
   *  rendered -- a select that changes nothing is noise. */
  onLang?: (path: string, lang: string | null) => void;
  /** Whitespace marks (the shared ws-render decoration -- dots, tab arrows,
   *  trailing highlight). A per-browser VIEW pref owned by the app; absent
   *  renders exactly what the viewer always did. */
  showWhitespace?: boolean;
  /** Footer toggle button (the reload button's glyph idiom). Absent = no
   *  button. */
  onToggleWhitespace?: () => void;
  /** One honest muted line under the head (the editor seam uses it for the
   *  "over the edit cap" verdict on read-only fallbacks). */
  note?: string;
}

/** The chooser's language list: what the registry can actually color, plus
 *  markdown (the one stateful sink the registry stays out of), sorted. The
 *  Auto entry and "plain" are rendered around this list, not in it. */
export function fileViewLangChoices(): string[] {
  return [...new Set([...listRenderableLangs(), "markdown"])].sort();
}

/** Popup label for a lang name; names are single words, so the capital
 *  first letter cannot lie about them. */
export function langLabel(lang: string): string {
  return lang.charAt(0).toUpperCase() + lang.slice(1);
}

function LineRow({ n, text, runs, showWs }: { n: number; text: string; runs: SyntaxRun[]; showWs?: boolean }) {
  return (
    <div className="file-line" data-line={n}>
      <span className="file-ln" aria-hidden="true">{n}</span>
      <code className="file-code">
        {codeSpans(runs, showWs === true, text)}
        {text === "" ? "\u00a0" : null}
      </code>
    </div>
  );
}

export function FileView(p: FileViewProps) {
  const view = p.view;
  // PAINT: the foot bar's override wins over the guess (see
  // FileViewEntry.lang). "plain" is no registry lang, so the tokenizer
  // lookup misses it exactly like an unknown name -- one honest path to an
  // uncolored sheet, no special case in the tokenizer plumbing.
  const guessed = guessLang(p.path);
  const override = view?.lang;
  const lang = override ?? guessed;
  // Tokenized once per render pass, in line order: markdown carries
  // cross-line state (see tokenizeFileLines); everything else is the same
  // per-line registry path, just hoisted out of the row map.
  const rows = view ? tokenizeFileLines(view.lines, lang) : [];
  const loading = !view || view.status === "loading";
  const failedHard = view?.status === "error";
  const statusLine = view
    ? view.status === "ready"
      ? `${view.lines.length} line${view.lines.length === 1 ? "" : "s"}${view.truncated ? " so far" : ""}`
      : view.status === "loading"
        ? "reading..."
        : "unread"
    : "reading...";
  return (
    <div className="file-view" data-path={p.path}>
      {/* NO HEAD CHROME (owner ruling 2026-11-14): the tab already names the
          file, so the name row is gone and the sheet starts at the tab
          strip's hairline. The viewer's whole chrome rides the foot bar. */}
      {loading ? <div className="file-view-note">Reading file...</div> : null}
      {failedHard ? (
        // The server's honest one-liner, verbatim (binary, escape, denied,
        // not found, ...). No content bytes exist client-side either.
        <div className="file-view-note file-view-error" role="alert">{view?.error}</div>
      ) : null}
      {p.note ? (
        <div className="file-view-note" role="status">{p.note}</div>
      ) : null}
      {!loading && !failedHard && view && view.lines.length === 0 ? (
        <div className="file-view-note">(empty file)</div>
      ) : null}
      {!failedHard && view ? (
        <div className="file-view-rows">
          {view.lines.map((line, i) => (
            <LineRow key={i + 1} n={i + 1} text={line} runs={rows[i]!} showWs={p.showWhitespace} />
          ))}
        </div>
      ) : null}
      {view?.error && !failedHard ? (
        <div className="file-view-note file-view-error" role="status">{view.error}</div>
      ) : null}
      {/* The foot bar is the viewer's whole chrome: status left, pager and
          the one reload affordance right. Sticky-bottom in the scrolling
          pane (#workbench-body owns the y-scroll) so it holds the foot
          while long files scroll under it -- chrome that never costs a line
          at the head. */}
      <div className="file-view-bar">
        {p.onLang ? (
          // The paint list (owner request 2026-11-14): a NATIVE select --
          // the popup, keyboard and the selected-row highlight arrive free
          // (the composer's #model-select wore this idiom until the
          // 2026-11-15 combobox migration; this chooser stays native, its
          // list is short). `selected`
          // marks the current choice because this runtime has no
          // controlled-value plumbing: the option attribute is true on a
          // fresh mount and the diff patches it on a re-render. The Auto
          // entry leads (its selection IS the absence of an override); the
          // auto-detected name carries the "(auto)" mark wherever it sits,
          // and an override in force rides the accent (.is-overridden).
          <select
            className={
              override !== undefined && override !== guessed
                ? "file-view-lang is-overridden"
                : "file-view-lang"
            }
            aria-label="Syntax highlighting language"
            title={
              override !== undefined && override !== guessed
                ? `Painted as ${langLabel(override)}; auto-detected ${langLabel(guessed ?? "plain text")} (click to change)`
                : `Painted as ${langLabel(guessed ?? "plain text")}, auto-detected (click to change)`
            }
            onChange={(e: Event) => {
              const value = (e.currentTarget as unknown as { value: string }).value;
              p.onLang!(p.path, value === "" ? null : value);
            }}
          >
            <option value="" selected={override === undefined}>
              {`Auto (${langLabel(guessed ?? "plain text")})`}
            </option>
            <option value="plain" selected={override === "plain"}>
              {`Plain text${guessed === undefined ? " (auto)" : ""}`}
            </option>
            {fileViewLangChoices().map((l) => (
              <option key={l} value={l} selected={override === l}>
                {`${langLabel(l)}${l === guessed ? " (auto)" : ""}`}
              </option>
            ))}
          </select>
        ) : null}
        <span className="file-view-status" role="status">{statusLine}</span>
        {!loading && view?.truncated ? (
          <button
            type="button"
            className="file-view-btn file-view-more"
            title={`Read the next page from line ${view.lines.length + 1}`}
            onClick={() => p.onMore(p.path)}
          >
            Load more from line {view.lines.length + 1}
          </button>
        ) : null}
        {p.onToggleWhitespace ? (
          // The same per-browser whitespace mark the editor wears (shared
          // ws-render decoration; the pref lives with the app/editor seam).
          <button
            type="button"
            className={`file-reload-btn file-view-ws${p.showWhitespace ? " is-on" : ""}`}
            title="Toggle visible whitespace"
            aria-label="Toggle visible whitespace"
            aria-pressed={p.showWhitespace ? "true" : "false"}
            onClick={() => p.onToggleWhitespace!()}
          >
            <IconWhitespace />
          </button>
        ) : null}
        <button
          type="button"
          className="file-reload-btn file-bar-reload"
          title="Re-read the file from the top"
          aria-label="Reload"
          onClick={() => p.onReload(p.path)}
        >
          <IconReload className="file-reload-glyph" />
        </button>
      </div>
    </div>
  );
}
