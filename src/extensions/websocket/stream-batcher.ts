// Per-channel coalescer for the websocket S2C sink (webui.streamBatchMs).
// Streaming frames are the only chatty traffic on a session channel: text and
// reasoning chunks are true deltas (one frame per provider delta) and the
// tool-call preview re-sends the CUMULATIVE partial every delta, so a 500-token
// answer costs 500 frames of wire. The batcher keeps first paint untouched and
// folds the burst that follows:
//
// - FIRST frame of a burst ships IMMEDIATELY (zero added latency on the first
//   token); the window arms at that send.
// - STREAMING_CHUNK / STREAMING_REASONING_CHUNK arriving inside the window
//   CONCATENATE into one frame per kind (byte-equal to the unbatched stream:
//   frames are {type, sessionId, content}, concatenation only grows `content`).
// - STREAMING_TOOL_CALL collapses LATEST-WINS per in-flight call `index`: the
//   partial is cumulative, so every older frame is dead weight the client has
//   already replaced. No wire change, no sequence numbers.
// - ANY other frame flushes the buffer BEFORE it is sent (strict per-session
//   ordering: an assistant response / tool start/result / system message /
//   question / stream-reset / footer-state frame is never overtaken by a
//   batched chunk). Window expiry flushes too. Nothing is ever dropped.
// - Knob OFF (0) is byte-identical passthrough: every frame goes straight to
//   the sink, untouched, in order.
//
// Buffering is per batcher instance = per channel = per (socket, session): a
// busy session never holds another session's frames. The window length is read
// through getBatchMs PER FRAME (the live-config doctrine of the question
// getPolicy seam): a panel edit to webui.streamBatchMs lands on the next
// frame, no restart. Flush ordering across kinds follows FIRST-ARRIVAL order
// of the slots (deterministic; text and reasoning render on different client
// surfaces, so their relative order is cosmetic).

import { S2C } from "./protocol.ts";

/** Fallback window when the config carries no usable number (mock cores,
 *  embedders, hand-built hosts). Mirrors the webui schema default. */
export const DEFAULT_STREAM_BATCH_MS = 100;

/** The knob from a live config bag: webui.streamBatchMs, min 0 (0 = off).
 *  Non-number / non-finite falls back to the default, negatives clamp to 0. */
export function resolveStreamBatchMs(config: unknown): number {
  const webui = (config as Record<string, unknown> | undefined)?.webui;
  const v =
    webui && typeof webui === "object"
      ? (webui as Record<string, unknown>).streamBatchMs
      : undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_STREAM_BATCH_MS;
  return Math.max(0, v);
}

export interface StreamBatcherOptions {
  /** The transport sink: one already-serialized-ready frame per call. */
  send: (frame: Record<string, unknown>) => void;
  /** Live window reader, consulted on every frame (ms). <= 0 disables. */
  getBatchMs: () => number;
  /** Injectable timer for deterministic tests; returns the cancel. */
  setTimer?: (cb: () => void, ms: number) => () => void;
}

export class StreamBatcher {
  #send: (frame: Record<string, unknown>) => void;
  #getBatchMs: () => number;
  #setTimer: (cb: () => void, ms: number) => () => void;
  /** Buffered slots in first-arrival order: text kinds key by type (one
   *  accumulation slot each), tool-call previews by `tool:<index>`. */
  #pending = new Map<string, Record<string, unknown>>();
  #cancelTimer: (() => void) | null = null;

  constructor(options: StreamBatcherOptions) {
    this.#send = options.send;
    this.#getBatchMs = options.getBatchMs;
    this.#setTimer =
      options.setTimer ??
      ((cb, ms) => {
        const t = setTimeout(cb, ms);
        return () => clearTimeout(t);
      });
  }

  /** One outbound S2C frame entering the sink. */
  handle(frame: Record<string, unknown>): void {
    const batchMs = this.#getBatchMs();
    const key = batchMs > 0 ? batchKey(frame) : null;
    if (key === null) {
      // Non-streaming frame (or the knob reads off): strict order first.
      this.flush();
      this.#send(frame);
      return;
    }
    if (this.#cancelTimer !== null) {
      this.#merge(key, frame);
      return;
    }
    this.#send(frame);
    this.#cancelTimer = this.#setTimer(() => {
      this.#cancelTimer = null;
      this.flush();
    }, batchMs);
  }

  /** Ship whatever is buffered (no-op when empty), clear the window. */
  flush(): void {
    if (this.#cancelTimer !== null) {
      this.#cancelTimer();
      this.#cancelTimer = null;
    }
    if (this.#pending.size === 0) return;
    for (const frame of this.#pending.values()) this.#send(frame);
    this.#pending.clear();
  }

  #merge(key: string, frame: Record<string, unknown>): void {
    if (key.startsWith("tool:")) {
      // Cumulative partial: the newest frame per call index is all the client
      // renders. Map.set on an existing key keeps its first-arrival position.
      this.#pending.set(key, frame);
      return;
    }
    const existing = this.#pending.get(key);
    if (existing) {
      existing.content = `${existing.content as string}${frame.content as string}`;
    } else {
      // Copy: the flush mutates `content`, and the same frame object may fan
      // out to sibling channels' batchers through ChannelHub.publish.
      this.#pending.set(key, { ...frame });
    }
  }
}

/** The batch slot a frame belongs to, or null when the frame must not wait. */
function batchKey(frame: Record<string, unknown>): string | null {
  switch (frame.type) {
    case S2C.STREAMING_CHUNK:
    case S2C.STREAMING_REASONING_CHUNK:
      // A frame without string content is not batchable text: it ships raw
      // like any other frame (concat would stringify "undefined").
      // Unreachable via the typed core; honest guard.
      return typeof frame.content === "string" ? (frame.type as string) : null;
    case S2C.STREAMING_TOOL_CALL:
      return `tool:${frame.index as number}`;
    default:
      return null;
  }
}
