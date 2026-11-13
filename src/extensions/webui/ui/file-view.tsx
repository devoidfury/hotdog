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

import { getTokenizer, guessLangForBase, type SyntaxRun } from "@utils/syntax/index.ts";
import { hasFrontmatter, tokenizeMarkdownDoc } from "@utils/syntax/markdown.ts";
import type { ReadFileResultWire } from "@extensions/websocket/protocol.ts";
import { IconReload } from "./icons.tsx";

// ── Language guessing (display only) ────────────────────────────────────────
// The registry owns the name metadata: every SyntaxDef names its own
// extensions and basenames (see index.ts), including the guess-only langs
// (rust, go) that have no tokenizer. Registry contract: getTokenizer
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

/** Reload: drop the accumulated page(s) and re-read from the top. */
export function reloadFileView(
  s: FileViewsState,
  path: string,
): { state: FileViewsState; fetch: FileFetch } {
  return mintAndFetch(s, path, { status: "loading", lines: [], truncated: false });
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
      return { ...s, pending, views: { ...s.views, [path]: { status: "error", lines: [], truncated: false, error: result.error } } };
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
      [path]: { status: "ready", lines, truncated: result.truncated === true },
    },
  };
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
}

function LineRow({ n, text, runs }: { n: number; text: string; runs: SyntaxRun[] }) {
  return (
    <div className="file-line" data-line={n}>
      <span className="file-ln" aria-hidden="true">{n}</span>
      <code className="file-code">
        {runs.map((run, i) => (
          <span key={i} className={`tk tk-${run.type}`}>{run.text}</span>
        ))}
        {text === "" ? "\u00a0" : null}
      </code>
    </div>
  );
}

export function FileView(p: FileViewProps) {
  const view = p.view;
  const lang = guessLang(p.path);
  // Tokenized once per render pass, in line order: markdown carries
  // cross-line state (see tokenizeFileLines); everything else is the same
  // per-line registry path, just hoisted out of the row map.
  const rows = view ? tokenizeFileLines(view.lines, lang) : [];
  const name = p.path.split(/[/\\]/).pop() || p.path;
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
      <div className="file-view-header">
        <span className="file-view-name" title={p.path}>{name}</span>
        <span className="file-view-status" role="status">{statusLine}</span>
        <button
          type="button"
          className="file-reload-btn"
          title="Re-read the file from the top"
          aria-label="Reload"
          onClick={() => p.onReload(p.path)}
        >
          <IconReload className="file-reload-glyph" />
        </button>
      </div>
      {loading ? <div className="file-view-note">Reading file...</div> : null}
      {failedHard ? (
        // The server's honest one-liner, verbatim (binary, escape, denied,
        // not found, ...). No content bytes exist client-side either.
        <div className="file-view-note file-view-error" role="alert">{view?.error}</div>
      ) : null}
      {!loading && !failedHard && view && view.lines.length === 0 ? (
        <div className="file-view-note">(empty file)</div>
      ) : null}
      {!failedHard && view ? (
        <div className="file-view-rows">
          {view.lines.map((line, i) => (
            <LineRow key={i + 1} n={i + 1} text={line} runs={rows[i]!} />
          ))}
        </div>
      ) : null}
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
      {view?.error && !failedHard ? (
        <div className="file-view-note file-view-error" role="status">{view.error}</div>
      ) : null}
    </div>
  );
}
