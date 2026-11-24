// The codemode host<->child wire protocol: NDJSON frames on stdio,
// one JSON object per line, 1 MiB per frame in BOTH directions
// (FRAME_MAX_BYTES -- plain-text JSON, v1 lives entirely in the control tier;
// a quarter of the exec plane's MAX_FRAME_BYTES). An oversize frame is a
// protocol violation: the child is killed and the script fails. The framing
// itself is the plane's LineDecoder, instantiated with the codemode cap.
//
// Real tools never exist inside the child: every capability is a frame
// round-trip to the host, where the pipeline (gate, caps, durability) lives.

import {
  encodeFrame,
  FrameOverflowError,
  LineDecoder,
} from "@core/tool-exec-protocol.ts";
import { FRAME_MAX_BYTES } from "../options.ts";

export { encodeFrame, FrameOverflowError, LineDecoder };

/** The one name that may never enter the callable table: a script
 *  must not invoke codemode through its own `tools`. The bridge filters it
 *  out of every run frame; the runner has nothing to enforce because a
 *  stripped name simply never appears. Mirrors CODEMODE_TOOL_NAME (tool.ts). */
export const NON_CALLABLE = "codemode";

/** Terminal exit code the runner uses when it enforces its own stream caps:
 *  the host maps it to the output-cap failure. A plain SIGKILL would drop
 *  unflushed pipe bytes and arrive as a bare 137 through bwrap,
 *  indistinguishable from a stray OOM; the code says *why* the child died. */
export const RUNNER_CAP_EXIT = 86;

/** A frame decoder at the codemode cap (1 MiB, both directions). */
export function createFrameDecoder(): LineDecoder {
  return new LineDecoder(FRAME_MAX_BYTES);
}

/** Encode one frame as a full NDJSON line. */
export function encodeLine(frame: unknown): string {
  return `${encodeFrame(frame)}\n`;
}

// ── host -> child ─────────────────────────────────────────────────────────────

/** Clamped envelope params, carried verbatim into the run frame. */
export interface RunOptionsFrame {
  timeout_ms: number;
  max_output_chars: number;
}

/**
 * The instruction frame. `names` pre-seeds the callable table: one async fn
 * per name in `tools`, enumerable without a query frame. It NEVER contains
 * `codemode` -- the bridge strips it from every run frame, so the ban is not
 * a runtime option. `calls` is the per-script inner-call cap.
 */
export interface RunFrame {
  t: "run";
  src: string;
  opts: RunOptionsFrame;
  calls: number;
  names: string[];
}

/** The finalized inner-call result (ToolResultPart -> payload). */
export interface ResPayload {
  output: string;
  hint: string | null;
  error: string | null;
  meta: unknown[];
}

export interface ResFrameOk {
  t: "res";
  id: number;
  ok: true;
  payload: ResPayload;
}

export interface ResFrameErr {
  t: "res";
  id: number;
  ok: false;
  error: string;
}

export type ResFrame = ResFrameOk | ResFrameErr;
export type HostFrame = RunFrame | ResFrame;

// ── child -> host ─────────────────────────────────────────────────────────────

/** An inner tool call; `args` is one JSON value passed verbatim to the real
 *  tool's own schema (the child never sees JSON Schema). */
export interface CallFrame {
  t: "call";
  id: number;
  name: string;
  args: unknown;
}

/** In-sandbox discovery: host-side meta ops. Answered from
 *  the run's policy-filtered set; the JSON answer rides the res payload
 *  (searchTools -> [{name, description}]; describeTool -> sample or null). */
export interface MetaSearchFrame {
  t: "meta";
  id: number;
  op: "searchTools";
  query: string;
  limit?: number;
}

export interface MetaDescribeFrame {
  t: "meta";
  id: number;
  op: "describeTool";
  name: string;
}

export type MetaFrame = MetaSearchFrame | MetaDescribeFrame;

/** Text-only bridge: the only item kind is text (images are dropped). */
export type OutItem = { kind: "text"; text: string };

export interface OutFrame {
  t: "out";
  item: OutItem;
}

/**
 * store()/load() round-trips on frames like every other capability: the
 * child holds no data-dir access, the host owns the quotas (256 KiB/value,
 * 1 MiB total, JSON only) and commits writes ONLY when the script succeeds.
 * A store res is the host's promise "queued; will commit iff this script
 * ends ok"; load answers from the committed state overlaid with this run's
 * pending writes (read-your-writes).
 */
export interface StoreFrame {
  t: "store";
  id: number;
  key: string;
  value: unknown;
}

export interface LoadFrame {
  t: "load";
  id: number;
  key: string;
}

/** Terminal frame: `value` is the script's final return / text flush. */
export interface DoneFrameOk {
  t: "done";
  ok: true;
  value?: unknown;
}

export interface DoneFrameErr {
  t: "done";
  ok: false;
  error: string;
}

export type DoneFrame = DoneFrameOk | DoneFrameErr;
export type ChildFrame = CallFrame | MetaFrame | OutFrame | StoreFrame | LoadFrame | DoneFrame;

// ── validation ────────────────────────────────────────────────────────────────
// Both peers validate inbound frames structurally (the cap is the decoder's
// job). A null return is a protocol violation for the caller to act on --
// never noise to swallow: it means the peer's frame stream cannot be trusted.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse + structurally validate one child line. Null = violation. */
export function parseChildFrame(line: string): ChildFrame | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  switch (raw.t) {
    case "call":
      if (typeof raw.id !== "number" || typeof raw.name !== "string") return null;
      return { t: "call", id: raw.id, name: raw.name, args: raw.args };
    case "meta": {
      if (typeof raw.id !== "number") return null;
      if (raw.op === "searchTools" && typeof raw.query === "string") {
        return typeof raw.limit === "number"
          ? { t: "meta", id: raw.id, op: "searchTools", query: raw.query, limit: raw.limit }
          : { t: "meta", id: raw.id, op: "searchTools", query: raw.query };
      }
      if (raw.op === "describeTool" && typeof raw.name === "string") {
        return { t: "meta", id: raw.id, op: "describeTool", name: raw.name };
      }
      return null;
    }
    case "out": {
      const item = raw.item;
      if (!isRecord(item) || item.kind !== "text" || typeof item.text !== "string") return null;
      return { t: "out", item: { kind: "text", text: item.text } };
    }
    case "store":
      // `value` must be present in the JSON object: an undefined value never
      // survives stringification, so a frame without it is malformed, not a
      // store of nothing.
      if (typeof raw.id !== "number" || typeof raw.key !== "string" || !("value" in raw)) {
        return null;
      }
      return { t: "store", id: raw.id, key: raw.key, value: raw.value };
    case "load":
      if (typeof raw.id !== "number" || typeof raw.key !== "string") return null;
      return { t: "load", id: raw.id, key: raw.key };
    case "done":
      if (raw.ok === true) return { t: "done", ok: true, value: raw.value };
      if (raw.ok === false && typeof raw.error === "string") {
        return { t: "done", ok: false, error: raw.error };
      }
      return null;
    default:
      return null;
  }
}

/** Parse + structurally validate one host line (the child's inbound leg). */
export function parseHostFrame(line: string): HostFrame | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  switch (raw.t) {
    case "run": {
      if (typeof raw.src !== "string") return null;
      if (raw.calls !== undefined && typeof raw.calls !== "number") return null;
      if (!isRecord(raw.opts)) return null;
      if (
        typeof raw.opts.timeout_ms !== "number" ||
        typeof raw.opts.max_output_chars !== "number"
      ) {
        return null;
      }
      const names = raw.names;
      if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) return null;
      return {
        t: "run",
        src: raw.src,
        opts: {
          timeout_ms: raw.opts.timeout_ms,
          max_output_chars: raw.opts.max_output_chars,
        },
        calls: typeof raw.calls === "number" ? raw.calls : 0,
        names: names as string[],
      };
    }
    case "res": {
      if (typeof raw.id !== "number" || typeof raw.ok !== "boolean") return null;
      if (raw.ok) {
        if (!isRecord(raw.payload) || typeof raw.payload.output !== "string") return null;
        const payload: ResPayload = {
          output: raw.payload.output,
          hint: typeof raw.payload.hint === "string" ? raw.payload.hint : null,
          error: typeof raw.payload.error === "string" ? raw.payload.error : null,
          meta: Array.isArray(raw.payload.meta) ? raw.payload.meta : [],
        };
        return { t: "res", id: raw.id, ok: true, payload };
      }
      if (typeof raw.error !== "string") return null;
      return { t: "res", id: raw.id, ok: false, error: raw.error };
    }
    default:
      return null;
  }
}
