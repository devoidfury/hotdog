// Wire protocol for the tool execution plane.
//
// Plain data only -- frames must cross the supervisor/broker/runner process
// boundary unchanged, so nothing here carries classes, symbols, Maps, or
// closures. Transport is line-delimited JSON over child-process stdio;
// `LineDecoder` reassembles frames across arbitrary read boundaries.
//
// Error frames carry {message, stack, expected, name?, hint?} so
// formatError() classification (AGENTS.md error rule) survives the boundary:
// `reviveWireError` rebuilds the classes the executor's catch branches on
// (TransientError retry, AssistantRetryableError hint).

import {
  isExpectedError,
  ToolError,
  AssistantRetryableError,
  TransientError,
} from "./error.ts";
import { ToolResult, TOOL_STOP_LOOP } from "./extensions/tool-utils.ts";

/** Capability class of a pool entry. v1 ships `rw`; `net` lands with the MCP relay. */
export type ExecClass = "rw" | "net";

// ── Per-call context ─────────────────────────────────────────────────────────

export interface WireWorkspace {
  roots: string[];
  /** null = unset, the runner falls back to DEFAULT_DENY_PATTERNS; [] disables the denylist. */
  deny: readonly string[] | null;
}

/**
 * Tool config scalars the runner needs to construct tool classes without
 * booting the config stack (no model fetch, no MCP). Keys mirror the merged
 * core config blocks the extensions themselves read.
 */
export interface WireToolConfig {
  bashTool?: Record<string, unknown>;
  coreTools?: Record<string, unknown>;
  envScrubbing?: boolean;
  envScrubExtra?: string[];
}

export interface WireToolCtx {
  session: string;
  workspace: WireWorkspace;
  toolConfig: WireToolConfig;
}

// ── Serialized results ───────────────────────────────────────────────────────

/**
 * A ToolResult flattened to plain data, or a plain return value kept as-is.
 * The `kind` discriminator keeps a plain object return from being mistaken
 * for a serialized ToolResult.
 */
export type WireToolResult =
  | {
      kind: "tool-result";
      output: string;
      error: string | null;
      success: boolean;
      hint: string | null;
      metadata: [string, string][];
      images: unknown[] | null;
      stopLoop: boolean;
    }
  | { kind: "value"; value: unknown };

export interface WireError {
  message: string;
  stack?: string;
  expected: boolean;
  name?: string;
  hint?: string;
}

/** Error frame payload for a pool entry that died mid-call (increment 2 wires this kind). */
export interface ExecutorDiedError {
  kind: "executor-died";
  poolKey: string;
}

// ── Fence ────────────────────────────────────────────────────────────────────

/**
 * A computed jail plan handed to the broker as argv ("isolation is
 * argv"). The SUPERVISOR builds it (`createFencePlanner`); the broker child
 * prepends it verbatim at pool-entry spawn and compares ids for reuse. A
 * fence-less entry carries the empty id, so "no fence" is one comparison away
 * from "fence changed", which is the whole respawn rule.
 */
export interface WireFence {
  /** Stable identity of the exact prefix; mismatch replaces the entry. */
  id: string;
  /** Full spawn argv, bwrap flags AND the wrapped command (isolation is argv). */
  prefix: string[];
}

// ── Frames ───────────────────────────────────────────────────────────────────

// Supervisor -> broker -> runner.
export interface InvokeFrame {
  id: string;
  op: "invoke";
  session: string;
  class?: ExecClass;
  /** Fence for a fresh entry under this key; absent/empty id = plain spawn. */
  fence?: WireFence;
  tool: string;
  args: string | Record<string, unknown>;
  ctx: WireToolCtx;
}
export interface CancelFrame {
  id: string;
  op: "cancel";
}
export interface WarmFrame {
  op: "warm";
  session: string;
  class: ExecClass;
  /** Fence for a fresh entry; without `workspace` the warm cannot plan -- the first invoke corrects it. */
  fence?: WireFence;
  /** Roots the fence is planned against (optional: a fence-less warm needs none). */
  workspace?: WireWorkspace;
}
export interface ReapFrame {
  op: "reap";
  session?: string;
  class?: ExecClass;
}
export type OutboundFrame = InvokeFrame | CancelFrame | WarmFrame | ReapFrame;

// Runner -> broker -> supervisor.
export interface OkFrame {
  id: string;
  ok: true;
  result: WireToolResult;
}
export interface FailFrame {
  id: string;
  ok: false;
  error: WireError | ExecutorDiedError;
}
export interface ReadyFrame {
  op: "ready";
}
export interface LogFrame {
  op: "log";
  level: "debug" | "info" | "warn" | "error";
  msg: string;
}
export type InboundFrame = OkFrame | FailFrame | ReadyFrame | LogFrame;

/**
 * The supervisor-side view of the plane. The executor forks to this seam;
 * `ToolExecBroker` is the real link, tests hand in fakes.
 *
 * `cancel` and `warm` are optional because they are fire-and-forget posture:
 * a fake link (or a host that cannot interrupt) simply omits them, and the
 * supervisor never awaits their effect.
 */
export interface ToolExecLink {
  /** `id` correlates a later cancel frame; hosts that omit it get one minted. */
  invoke(req: {
    id?: string;
    session: string;
    tool: string;
    args: string | Record<string, unknown>;
    ctx: WireToolCtx;
  }): Promise<WireToolResult>;
  /** Interrupt the call with this id. Never awaited: the caller settles. */
  cancel?(id: string): void;
  /** Pre-spawn a pool entry; must never reject into a run. */
  warm?(session: string, cls: ExecClass, workspace?: WireWorkspace): void;
  /** Drop pool entries (idle teardown, session delete). */
  reap?(session?: string, cls?: ExecClass): void;
  close(): Promise<void>;
}

// ── Line-delimited JSON codec ────────────────────────────────────────────────

/** Encode one frame. JSON.stringify escapes newlines, so a frame is always one line. */
export function encodeFrame(frame: unknown): string {
  return JSON.stringify(frame);
}

/**
 * Reassembles newline-delimited records across arbitrary chunk boundaries
 * (the child-process stdio reality). CRLF-terminated lines are accepted.
 */
export class LineDecoder {
  #buf = "";

  push(chunk: string): string[] {
    this.#buf += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.#buf.indexOf("\n")) !== -1) {
      let line = this.#buf.slice(0, idx);
      this.#buf = this.#buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) lines.push(line);
    }
    return lines;
  }

  /** Flush a trailing unterminated line at EOF (no separator follows it). */
  end(): string[] {
    const rest = this.#buf;
    this.#buf = "";
    return rest.length > 0 ? [rest] : [];
  }
}

// ── Error / result serialization ─────────────────────────────────────────────

export function serializeWireError(e: unknown): WireError {
  if (!(e instanceof Error)) return { message: String(e), expected: false };
  const err = e as Error & { hint?: unknown };
  const w: WireError = { message: err.message, expected: isExpectedError(e) };
  if (err.stack) w.stack = err.stack;
  // constructor.name, not err.name: the AppError family does not rebrand
  // `name`, and the revive side keys on this to rebuild retryable classes.
  const ctorName = (e as { constructor?: { name?: string } }).constructor?.name;
  if (ctorName && ctorName !== "Error") w.name = ctorName;
  if (typeof err.hint === "string") w.hint = err.hint;
  return w;
}

/**
 * Rebuild an error whose identity the executor's catch branches on:
 * TransientError keeps retry semantics, an AssistantRetryableError (or any
 * framed hint) keeps the model-facing hint, other expected errors come back
 * as ToolError so formatError() stays message-only. Unexpected errors keep
 * the original stack text for the log.
 */
export function reviveWireError(w: WireError): Error {
  let e: Error;
  if (w.name === "TransientError") {
    e = new TransientError(w.message);
  } else if (w.hint) {
    e = new AssistantRetryableError(w.message, w.hint);
  } else if (w.expected) {
    e = new ToolError(w.message);
  } else {
    e = new Error(w.message);
  }
  if (w.stack) e.stack = w.stack;
  return e;
}

/** Flatten a tool's raw return: ToolResult-shaped values keep their fields. */
export function serializeToolResult(result: unknown): WireToolResult {
  const r = result as {
    toApiContent?: unknown;
    output?: unknown;
    error?: unknown;
    success?: unknown;
    hint?: unknown;
    metadata?: unknown;
    images?: unknown;
  } | null;
  if (r && typeof r === "object" && typeof r.toApiContent === "function") {
    const meta =
      r.metadata instanceof Map
        ? [...(r.metadata as Map<string, string>)]
        : Array.isArray(r.metadata)
          ? (r.metadata as [string, string][])
          : [];
    return {
      kind: "tool-result",
      output: typeof r.output === "string" ? r.output : String(r.output ?? ""),
      error: typeof r.error === "string" ? r.error : null,
      success: r.success !== false,
      hint: typeof r.hint === "string" ? r.hint : null,
      metadata: meta.map(([k, v]) => [String(k), String(v)]),
      images: Array.isArray(r.images) ? r.images : null,
      stopLoop:
        (result as Record<symbol, unknown>)[TOOL_STOP_LOOP] === true,
    };
  }
  return { kind: "value", value: jsonSafe(result) };
}

export function reviveToolResult(w: WireToolResult): unknown {
  if (w.kind === "tool-result") {
    const tr = new ToolResult({
      output: w.output,
      error: w.error,
      metadata: w.metadata.length > 0 ? new Map(w.metadata) : null,
      success: w.success,
      images: w.images,
      hint: w.hint,
    });
    if (w.stopLoop) tr[TOOL_STOP_LOOP] = true;
    return tr;
  }
  return w.value;
}

/** Keep what survives the JSONL transport; stringify what would not (cycles, functions). */
function jsonSafe(v: unknown): unknown {
  if (v === undefined || typeof v === "function" || typeof v === "symbol") {
    return String(v);
  }
  if (typeof v !== "object" || v === null) return v;
  try {
    JSON.stringify(v);
    return v;
  } catch {
    return String(v);
  }
}
