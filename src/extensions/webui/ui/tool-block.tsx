/// <reference lib="dom" />
// One mounted tool-call block: semantic header, collapsible body with the
// pretty/raw args JSON (or a rendered diff for edit calls), the result text,
// and result images. Each block is its own mount tree: message-list appends
// a host div and mounts into it, so high-frequency updates elsewhere in the
// chat never diff tool blocks, and a block only re-renders on its own
// toggles or when its result arrives.

import { mount, type DomNode, type Mounted } from "@utils/jsx";

/** Image payload on the wire (see wireImages in @extensions/websocket/protocol.ts). */
export interface ToolImageWire {
  mimeType: string;
  data?: string;
  skipped?: boolean;
  note?: string;
}

export interface ToolResultData {
  output?: string;
  error?: string;
  images?: ToolImageWire[];
}

export interface ToolBlockState {
  name: string;
  args: string;
  /**
   * Server-computed hint-driven fold (ToolMetadata.argDisplay, shared with
   * the terminal). The local argsSummary heuristic covers older servers
   * that send neither.
   */
  argsSummary?: string;
  result?: ToolResultData;
  expanded: boolean;
  /** Args shown as the raw wire string instead of pretty-printed JSON. */
  raw: boolean;
  /** Result preview replaced by the full text. */
  fullResult: boolean;
}

/** Beyond this many chars the result shows a preview + "show full" button. */
export const RESULT_PREVIEW_CHARS = 2000;
/** Per-side cap on rendered diff lines (huge edits fall back to "…" rows). */
export const MAX_DIFF_LINES = 300;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

/**
 * Fallback header when the server sent no argsSummary: a compact one-liner
 * built from well-known arg keys (path basename, command/pattern text, then
 * any string value). NEVER a raw JSON line.
 */
export function argsSummary(args: string): string {
  let parsed: Record<string, unknown> | null = null;
  try {
    const p: unknown = JSON.parse(args);
    if (p && typeof p === "object" && !Array.isArray(p)) parsed = p as Record<string, unknown>;
  } catch {
    // Not JSON: the string itself (first line, truncated) is the summary.
  }
  if (parsed === null) return oneLine(args, 80);

  const str = (k: string): string | null => {
    const v = parsed![k];
    return typeof v === "string" && v.trim() ? v : null;
  };
  const path = str("path") ?? str("file_path");
  if (path) return basename(path);
  for (const key of ["command", "cmd", "pattern", "query", "url", "skill", "task_id"]) {
    const v = str(key);
    if (v) return oneLine(v, 80);
  }
  for (const v of Object.values(parsed)) {
    if (typeof v === "string" && v.trim()) return oneLine(v, 80);
  }
  const keys = Object.keys(parsed);
  return keys.length > 0 ? `{${keys.slice(0, 3).join(", ")}}` : "";
}

/** Pretty args for the collapsed body; unparseable strings pass through. */
export function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
}

/**
 * Diff lines for an edit call's oldString/newString: common prefix/suffix
 * trimmed, the changed middles rendered as del-then-add with one context
 * line on each side. Local to the UI (the core generateDiff stays as-is);
 * far kinder than a positional line-pairing diff for insertions.
 */
export function computeDiffLines(oldText: string, newText: string, maxLines = MAX_DIFF_LINES): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }
  const removed = oldLines.slice(start, endOld);
  const added = newLines.slice(start, endNew);

  const lines: DiffLine[] = [];
  if (start > 0) lines.push({ kind: "ctx", text: oldLines[start - 1]! });
  removed.forEach((text, i) => {
    if (i === maxLines) lines.push({ kind: "ctx", text: `… ${removed.length - maxLines} more removed` });
    else if (i < maxLines) lines.push({ kind: "del", text });
  });
  added.forEach((text, i) => {
    if (i === maxLines) lines.push({ kind: "ctx", text: `… ${added.length - maxLines} more added` });
    else if (i < maxLines) lines.push({ kind: "add", text });
  });
  if (endOld < oldLines.length) lines.push({ kind: "ctx", text: oldLines[endOld]! });
  return lines;
}

/** Diff body for edit-family calls only: name + both string sides present. */
export function editDiff(name: string, args: string): DiffLine[] | null {
  if (name !== "edit" && name !== "str_replace" && name !== "apply_patch") return null;
  try {
    const parsed: unknown = JSON.parse(args);
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.oldString === "string" && typeof o.newString === "string") {
      return computeDiffLines(o.oldString, o.newString);
    }
  } catch {
    // Fall through: not an edit we can render.
  }
  return null;
}

function statusOf(state: ToolBlockState): "pending" | "ok" | "error" {
  if (!state.result) return "pending";
  return state.result.error ? "error" : "ok";
}

const STATUS_GLYPH = { pending: "…", ok: "✓", error: "✗" } as const;

/** One thumbnail; click toggles full size. Ref-captured rather than
 * currentTarget-based (currentTarget is null once dispatch completes). */
function Thumb({ img }: { img: ToolImageWire }) {
  let el: HTMLElement | null = null;
  return (
    <img
      className="message-image"
      loading="lazy"
      src={`data:${img.mimeType};base64,${img.data}`}
      ref={(node) => {
        el = node as unknown as HTMLElement | null;
      }}
      onClick={() => el?.classList.toggle("fullsize")}
    />
  );
}

function ImagesView({ images }: { images: ToolImageWire[] }) {
  if (images.length === 0) return null;
  return (
    <div className="message-images">
      {images.map((img, i) =>
        img.skipped || !img.data ? (
          <div key={i} className="image-skipped">
            {img.note || "image not displayed"}
          </div>
        ) : !img.mimeType.startsWith("image/") ? (
          <div key={i} className="image-skipped">
            {`unsupported image type: ${img.mimeType}`}
          </div>
        ) : (
          <Thumb key={i} img={img} />
        ),
      )}
    </div>
  );
}

interface BlockProps {
  state: ToolBlockState;
  onToggle: () => void;
  onToggleRaw: () => void;
  onShowFull: () => void;
}

export function ToolBlock({ state, onToggle, onToggleRaw, onShowFull }: BlockProps) {
  const status = statusOf(state);
  const header = state.argsSummary ?? argsSummary(state.args);
  const diff = editDiff(state.name, state.args);
  const result = state.result;
  const resultText = result ? result.error ? `Error: ${result.error}` : result.output ?? "" : "";
  const truncated = !state.fullResult && resultText.length > RESULT_PREVIEW_CHARS;

  return (
    <div className={`tool-call-block status-${status}`}>
      <div className="tool-call-header" onClick={onToggle} title={state.name}>
        <span className="tool-call-name">🛠 {state.name}</span>
        <span className="tool-call-display">{header}</span>
        <span className={`tool-call-status status-${status}`}>{STATUS_GLYPH[status]}</span>
      </div>
      <div className={"tool-call-body" + (state.expanded ? "" : " hidden")}>
        {diff ? (
          <div className="tool-diff">
            {diff.map((line, i) => (
              <div key={i} className={`diff-line diff-${line.kind}`}>
                {`${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`}
              </div>
            ))}
          </div>
        ) : (
          <pre className="tool-args">{state.raw ? state.args : prettyArgs(state.args)}</pre>
        )}
        <button type="button" className="tool-raw-toggle" onClick={onToggleRaw}>
          {state.raw ? "pretty json" : "raw json"}
        </button>
        {result ? (
          <div className={"tool-result-section" + (status === "error" ? " tool-result-error" : "")}>
            <pre className="tool-result-pre">
              {truncated
                ? resultText.slice(0, RESULT_PREVIEW_CHARS) +
                  `\n\n… ${resultText.length - RESULT_PREVIEW_CHARS} more chars`
                : resultText}
            </pre>
            {truncated ? (
              <button type="button" className="tool-raw-toggle" onClick={onShowFull}>
                show full result
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {result?.images && result.images.length > 0 ? <ImagesView images={result.images} /> : null}
    </div>
  );
}

/**
 * Imperative handle message-list drives: create with the call, setResult
 * when the matching result arrives, destroy on clear. All state lives in
 * the handle; the component is pure.
 */
export class ToolBlockController {
  #state: ToolBlockState;
  #mounted: Mounted;

  constructor(host: DomNode, init: { name: string; args: string; argsSummary?: string }) {
    this.#state = { ...init, expanded: false, raw: false, fullResult: false };
    this.#mounted = mount(this.#el(), host);
  }

  #el() {
    return (
      <ToolBlock
        state={this.#state}
        onToggle={this.#toggle}
        onToggleRaw={this.#toggleRaw}
        onShowFull={this.#showFull}
      />
    );
  }

  #toggle = (): void => {
    this.#state = { ...this.#state, expanded: !this.#state.expanded };
    this.#mounted.render(this.#el());
  };

  #toggleRaw = (): void => {
    this.#state = { ...this.#state, raw: !this.#state.raw };
    this.#mounted.render(this.#el());
  };

  #showFull = (): void => {
    this.#state = { ...this.#state, fullResult: true };
    this.#mounted.render(this.#el());
  };

  setResult(result: ToolResultData): void {
    this.#state = { ...this.#state, result };
    this.#mounted.render(this.#el());
  }

  get hasResult(): boolean {
    return this.#state.result !== undefined;
  }

  destroy(): void {
    this.#mounted.unmount();
  }
}
