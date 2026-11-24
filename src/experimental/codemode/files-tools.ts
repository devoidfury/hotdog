// head + tail: the only two utilities. Real read-only tools registered
// alongside `codemode` (TOOLS_REGISTER in index.ts), execution LOCAL (a
// bounded read does not need the pooled-runner plane), metadata mirroring
// read's posture (sideEffects false, difficulty 1,
// no display DSL -- read has none). While the shadow layer is on they are
// never declared: invisible to the model, fully callable from scripts, and
// gate/digest/journal cover them like any dispatched tool.
//
// The size posture is the point: `read` slurps files <= 1 MiB whole and
// streams above (core-tools/read.ts STREAM_READ_THRESHOLD); a naive tail on
// a 2 GiB log would slurp it. So both tools share ONE bounded-window helper:
// fstat size, 64 KiB positioned reads growing x4 (BACKWARDS from EOF for
// tail, forwards for head), stopping at the Nth newline / the file boundary,
// with the total scan capped at 8 MiB. A newline-starved file (single-line
// bundle, \r-only log) therefore degrades with a
// "window capped at B bytes; ... bytes not scanned" note instead of
// materializing the whole file in host memory. Peak materialization:
// window + one chunk. A stream-semantics TextDecoder keeps a window from
// ever splitting a codepoint at a chunk seam.
//
// Path safety is the seam, not a reimplementation: resolveToolPath ->
// Workspace.resolveSafe (roots + the workspace.deny denylist on both the
// lexical and the realpath form) -- the same posture read/grep/bash use.
// Image extensions (read's list) and NUL bytes in the window are refused
// with errors pointing at `read`, which handles them properly.

import { open } from "node:fs/promises";
import {
  param,
  parseToolInput,
  resolveToolPath,
  ToolResult,
  toolDef,
} from "@core/extensions/tool-utils.ts";
import type { Tool, ToolDef, ToolMetadata } from "@core/extensions/tool-registry.ts";
import type { ToolContext } from "@core/extensions/tool-context.ts";
import type { Workspace } from "@utils/workspace.ts";
import { WINDOW_CHUNK_BYTES, WINDOW_SCAN_CAP_BYTES } from "./options.ts";

export const HEAD_TOOL_NAME = "head";
export const TAIL_TOOL_NAME = "tail";

/** read's own limit ceiling (core-tools/read.ts toToolDef): one default plus
 *  a per-call parameter, the readToolLimit posture without cloning read's
 *  config block. */
const DEFAULT_LINES = 200;
const MAX_LINES = 10_000;

/** Mirror of core-tools/read.ts IMAGE_EXTENSIONS: we REFUSE these and point
 *  at read (which handles images properly) instead of inventing a second
 *  image path. */
const IMAGE_EXTENSIONS: readonly string[] = [".jpg", ".jpeg", ".png", ".webp", ".base64"];

/** The fs surface boundedWindow needs; node:fs/promises FileHandle satisfies
 *  it, and tests wrap it to count bytes read: the no-whole-read guarantee is
 *  a test, not a comment. */
export interface WindowReader {
  stat(): Promise<{ size: number }>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface BoundedWindow {
  /** Decoded window text. For a window that does not reach byte 0, the
   *  leading partial line is already dropped. */
  text: string;
  /** Absolute byte offset where `text` begins. */
  windowStart: number;
  /** Bytes actually read during the scan (<= cap + one short read). */
  scannedBytes: number;
  /** Window reaches byte 0. */
  atStart: boolean;
  /** Window reaches EOF. */
  atEnd: boolean;
  /** Stopped by the scan cap short of the target, boundaries unmet. */
  capped: boolean;
}

/**
 * The shared bounded-window scan. `from` picks the direction:
 * "end" (tail: seek-from-EOF chunks backwards) or "start" (head: forward
 * twin). Stops at `lines` newlines, the far boundary, or the scan cap.
 * Decode happens in file order with stream-semantics TextDecoder so chunk
 * seams never split a codepoint; a window starting mid-line drops the
 * partial line in BYTE space (before decode, so the reported
 * `windowStart` is exact).
 */
export async function boundedWindow(
  reader: WindowReader,
  opts: { from: "start" | "end"; lines: number; chunkBytes?: number; capBytes?: number },
): Promise<BoundedWindow> {
  const size = (await reader.stat()).size;
  let chunk = opts.chunkBytes ?? WINDOW_CHUNK_BYTES;
  const cap = opts.capBytes ?? WINDOW_SCAN_CAP_BYTES;
  const parts: Buffer[] = []; // stored tail-first
  let pos = opts.from === "start" ? 0 : size; // edge of the still-unscanned side
  let scanned = 0;
  let newlines = 0;

  while (scanned < cap) {
    const remaining = opts.from === "start" ? size - pos : pos;
    if (remaining <= 0) break;
    const len = Math.min(chunk, remaining, cap - scanned);
    const buf = Buffer.allocUnsafe(len);
    const at = opts.from === "start" ? pos : pos - len;
    const { bytesRead } = await reader.read(buf, 0, len, at);
    if (bytesRead <= 0) break; // raced truncation: answer with what exists
    const data = bytesRead < len ? buf.subarray(0, bytesRead) : buf;
    if (opts.from === "start") pos += bytesRead;
    else pos -= bytesRead;
    scanned += bytesRead;
    for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) newlines += 1;
    parts.push(data);
    if (newlines >= opts.lines) break;
    chunk *= 4;
  }

  const atStart = opts.from === "start" || pos <= 0;
  const atEnd = opts.from === "end" || pos >= size;
  // Capped = the budget ran out with unscanned bytes REMAINING in the scan
  // direction (and the target unmet). In the tail direction the window always
  // touches EOF, so atEnd alone says nothing: compare against the scan edge.
  const remaining = opts.from === "start" ? size - pos : pos;
  const capped = newlines < opts.lines && remaining > 0;
  let windowStart = opts.from === "start" ? 0 : pos;

  // Drop the leading partial line in byte space (a \n never lives inside a
  // multibyte sequence, so the seam stays codepoint-aligned).
  if (opts.from === "end" && !atStart && parts.length > 0) {
    let skipped = 0;
    let found = -1;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const idx = parts[i]!.indexOf(0x0a);
      if (idx >= 0) {
        found = skipped + idx + 1;
        break;
      }
      skipped += parts[i]!.length;
    }
    if (found < 0) parts.length = 0;
    else {
      windowStart += found;
      let toDrop = found;
      while (toDrop > 0 && parts.length > 0) {
        const front = parts.length - 1;
        if (parts[front]!.length <= toDrop) {
          toDrop -= parts[front]!.length;
          parts.pop();
        } else {
          parts[front] = parts[front]!.subarray(toDrop);
          toDrop = 0;
        }
      }
    }
  }

  const decoder = new TextDecoder("utf-8");
  const pieces: string[] = [];
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    pieces.push(decoder.decode(parts[i]!, { stream: i > 0 }));
  }
  return { text: pieces.join(""), windowStart, scannedBytes: scanned, atStart, atEnd, capped };
}

// ── display posture (mirroring read) ────────────────────────────────────────
// Plain line output, meta entries `path` + `showing`. head:
// "1-N (of T total)" when the window reached EOF, "1-N (more exists)"
// otherwise (read's split("\n") line semantics, trailing partial counted).
// tail: "last N lines (window starts at byte B)", B = 0 meaning the whole
// file was shown; NO total_lines -- the only way to get it is a whole-file
// pass, and this tool exists to not make one.

export function renderHeadWindow(win: BoundedWindow, lines: number): { out: string; showing: string } {
  const pieces = win.text.split("\n");
  let showing: string;
  let shown: string[];
  if (win.atEnd) {
    const total = pieces.length; // split semantics: trailing piece is a line
    shown = pieces.slice(0, lines);
    showing = `1-${shown.length} (of ${total} total)`;
  } else {
    shown = pieces.slice(0, lines);
    showing = `1-${shown.length} (more exists)`;
    if (win.capped) showing += `; window capped at ${win.scannedBytes} bytes; later bytes not scanned`;
  }
  return { out: shown.join("\n"), showing };
}

export function renderTailWindow(win: BoundedWindow, lines: number): { out: string; showing: string } {
  // Drop the newline artifact (read's split would count the empty tail as a
  // line; tail's job is the last REAL lines).
  const body = win.text.endsWith("\n") ? win.text.slice(0, -1) : win.text;
  const pieces = body === "" ? [] : body.split("\n");
  const shown = pieces.slice(-lines);
  let b: number;
  if (shown.length === 0) {
    b = win.windowStart;
  } else {
    const shownText = shown.join("\n");
    // body = prefix + shownText (contiguous tail of the window): the prefix
    // is what sits before the first shown line.
    b = win.windowStart + Buffer.byteLength(body.slice(0, body.length - shownText.length), "utf8");
  }
  let showing = `last ${shown.length} lines (window starts at byte ${b})`;
  if (win.capped) showing += `; window capped at ${win.scannedBytes} bytes; earlier bytes not scanned`;
  return { out: shown.join("\n"), showing };
}

// ── the tools ────────────────────────────────────────────────────────────────

type WindowDirection = "start" | "end";

function parseWindowArgs(
  name: string,
  input: string | Record<string, unknown> | null,
): { path: string; lines: number } | { error: string } {
  const json = parseToolInput(input);
  if (!json || Array.isArray(json) || typeof json.path !== "string" || json.path === "") {
    return {
      error: `Error parsing arguments: ${name} expects a JSON object with a required 'path' string (optional: lines)`,
    };
  }
  const raw = json.lines;
  if (raw === undefined) return { path: json.path, lines: DEFAULT_LINES };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_LINES) {
    return {
      error: `${name}: \`lines\` must be an integer between 1 and ${MAX_LINES} (got ${JSON.stringify(raw) ?? String(raw)})`,
    };
  }
  return { path: json.path, lines: raw };
}

function imageExtension(resolved: string): string | null {
  const lower = resolved.toLowerCase();
  for (const ext of IMAGE_EXTENSIONS) if (lower.endsWith(ext)) return ext;
  return null;
}

class WindowTool implements Tool {
  #name: string;
  #from: WindowDirection;
  #description: string;

  constructor(name: string, from: WindowDirection, description: string) {
    this.#name = name;
    this.#from = from;
    this.#description = description;
  }

  metadata: ToolMetadata = { sideEffects: false, difficulty: 1, tags: ["files", "utility"] };

  toToolDef(): ToolDef {
    return toolDef(this.#name, this.#description, {
      properties: {
        path: param(
          "string",
          "Path to the file. Relative to the workspace root, or an absolute path inside a configured workspace root.",
        ),
        lines: param("integer", "Number of lines to show", {
          minimum: 1,
          maximum: MAX_LINES,
          default: DEFAULT_LINES,
        }),
      },
      required: ["path"],
    });
  }

  async execute(
    input: string | Record<string, unknown> | null,
    ctx?: ToolContext,
  ): Promise<ToolResult> {
    const args = parseWindowArgs(this.#name, input);
    if ("error" in args) return ToolResult.err(args.error);

    const workspace = ctx?.get("workspace") as Workspace | undefined;
    if (!workspace) {
      return ToolResult.err(`${this.#name}: no workspace mounted on this tool context`);
    }
    // The boundary FIRST: a denylist-shaped path (`.ssh/...`) gets the
    // boundary's shaped error with zero bytes opened.
    const target = resolveToolPath(args.path, workspace);
    if (!target.ok) return target.err;
    const resolved = target.path;

    const ext = imageExtension(resolved);
    if (ext) {
      return ToolResult.err(
        `${this.#name}: ${args.path} is an image file (${ext}); use read, which handles images.`,
      );
    }

    let reader: WindowReader;
    try {
      reader = await open(resolved, "r");
    } catch (e) {
      return ToolResult.err(`Failed to open ${args.path}: ${(e as Error).message}`);
    }
    try {
      const win = await boundedWindow(reader, { from: this.#from, lines: args.lines });
      if (win.text.includes("\u0000")) {
        return ToolResult.err(
          `${this.#name}: ${args.path} contains NUL bytes (binary); use read, which handles binary and image files.`,
        );
      }
      const { out, showing } =
        this.#from === "start" ? renderHeadWindow(win, args.lines) : renderTailWindow(win, args.lines);
      return ToolResult.ok(out).withEntries({ path: resolved, showing });
    } catch (e) {
      return ToolResult.err(`Failed to read file: ${(e as Error).message}`);
    } finally {
      await reader.close().catch(() => {});
    }
  }
}

export function createHeadTool(): Tool {
  return new WindowTool(
    HEAD_TOOL_NAME,
    "start",
    "Show the first lines of a text file (default 200, max 10000). The scan stops at the Nth newline: cheap on huge files, no whole-file read. Text only -- image and binary files are refused; use read for those.",
  );
}

export function createTailTool(): Tool {
  return new WindowTool(
    TAIL_TOOL_NAME,
    "end",
    "Show the last lines of a text file (default 200, max 10000). Reads backwards from EOF in bounded chunks -- safe on multi-GB logs; no total line count by design (that would need a whole-file pass). Text only -- image and binary files are refused; use read for those.",
  );
}
