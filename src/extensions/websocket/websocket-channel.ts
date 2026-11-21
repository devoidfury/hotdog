// Maps OutputEvent → S2C wire protocol and sends JSON over WS.
// The wire shape itself lives in wire-messages.ts, shared with history replay.

import { Channel, ChannelSessionManager } from "@core/channel.ts";
import { OUTPUT_EVENT, OutputEvent } from "@core/context/output.ts";
import type { ArgDisplay, ToolDisplaySpec } from "@core/extensions/tool-registry.ts";
import { toS2CMessage } from "./wire-messages.ts";
import { StreamBatcher } from "./stream-batcher.ts";
import type { HotdogServerSocket } from "./socket.ts";

export interface WebSocketChannelOptions {
  sessionManager: ChannelSessionManager;
  ws: HotdogServerSocket<unknown>;
  sessionId: string;
  broadcastCallback?: (msg: Record<string, unknown>) => void;
  /**
   * Resolves a tool's per-parameter display hints (its metadata's
   * argDisplay); the TOOL_CALL wire message carries the SAME args summary
   * the terminal prints (ANSI-free): hint-driven folding when declared,
   * the default fold otherwise. Omitting the resolver just means every
   * tool gets the default fold.
   */
  argDisplay?: (toolName: string) => Record<string, ArgDisplay> | undefined;
  /**
   * Resolves a tool's title-bar keys (its metadata's headerKeys); a declaring
   * tool's TOOL_CALL frame carries the labeled key-fold instead of the shared
   * argsSummary, riding even when empty (an explicit "no summary" that also
   * suppresses the client's fallback header). Omitting the resolver leaves
   * every tool on the shared fold.
   */
  headerKeys?: (toolName: string) => readonly string[] | undefined;
  /**
   * Resolves a tool's call-level display parts (its metadata's `display`);
   * the TOOL_CALL wire message forwards the declared spec (see
   * ToolDisplayWire) when the tool declares any. Omitting the resolver just
   * means every call renders generically.
   */
  display?: (toolName: string) => ToolDisplaySpec[] | undefined;
  /**
   * Live reader for the stream-batch window (webui.streamBatchMs), consulted
   * per frame: a panel edit lands on the NEXT frame, no restart. Omitted =
   * always 0 (off, byte-identical passthrough) -- raw embedders and unit
   * doubles keep today's exact wire behavior unless the server wires a reader.
   */
  streamBatchMs?: () => number;
  /** Injectable timer for deterministic tests (default setTimeout). */
  streamBatchTimer?: (cb: () => void, ms: number) => () => void;
}

export class WebSocketChannel extends Channel {
  #ws: HotdogServerSocket<unknown>;
  #sessionId: string;
  #ready: boolean;
  #broadcastCallback: ((msg: Record<string, unknown>) => void) | undefined;
  #argDisplay: ((toolName: string) => Record<string, ArgDisplay> | undefined) | undefined;
  #headerKeys: ((toolName: string) => readonly string[] | undefined) | undefined;
  #display: ((toolName: string) => ToolDisplaySpec[] | undefined) | undefined;
  #batcher: StreamBatcher;

  constructor(options: WebSocketChannelOptions) {
    super({ sessionManager: options.sessionManager });
    this.#ws = options.ws;
    this.#sessionId = options.sessionId;
    this.#ready = true;
    this.#broadcastCallback = options.broadcastCallback;
    this.#argDisplay = options.argDisplay;
    this.#headerKeys = options.headerKeys;
    this.#display = options.display;
    this.#batcher = new StreamBatcher({
      send: (frame) => this.#sendFrame(frame),
      getBatchMs: options.streamBatchMs ?? (() => 0),
      setTimer: options.streamBatchTimer,
    });
    this.attach(options.sessionId);
  }

  protected write(event: OutputEvent): void {
    if (!this.#ready) return;

    const msg = toS2CMessage(event, this.#sessionId, {
      argDisplay: this.#argDisplay,
      headerKeys: this.#headerKeys,
      display: this.#display,
    });
    if (!msg) return; // frame-only event: stays off the wire

    // Also broadcast session state to all connected clients. The broadcast
    // hits this socket too, so drain this channel's stream batch FIRST: the
    // state frame must never overtake a batched chunk on its own socket.
    if (event.type === OUTPUT_EVENT.SESSION_STATE && this.#broadcastCallback) {
      this.#batcher.flush();
      this.#broadcastCallback(msg);
    }

    // Through the batcher: streaming frames coalesce per webui.streamBatchMs,
    // everything else flushes-before-send (strict per-session ordering). At
    // the default knob this is today's one-frame-per-event passthrough.
    this.#batcher.handle(msg);
  }

  /**
   * Deliver one already-mapped frame through this channel's batching sink
   * (the worker live-tail path, ChannelHub.publish): same window, same flush
   * doctrine as write() -- a busy worker's chunks coalesce, its non-streaming
   * frames land in order.
   */
  deliverFrame(frame: Record<string, unknown>): void {
    if (!this.#ready) return;
    this.#batcher.handle(frame);
  }

  async *read(): AsyncIterable<string> {
    // Placeholder: messages are dispatched via routeMessage, not this iterator.
    yield "";
  }

  /**
   * Detach drains the batch before unsubscribing (the session-switch and
   * socket-close flush points; Channel.close() routes through here for every
   * attached session). Buffered frames are part of the session's transcript:
   * they ship before the channel stops caring about it, never dropped.
   */
  override detach(sessionId: string): void {
    this.#batcher.flush();
    super.detach(sessionId);
  }

  protected _cleanup(): void {
    this.#batcher.flush();
    this.#ready = false;
  }

  sendJson(msg: Record<string, unknown>): void {
    if (!this.#ready) return;
    // Same-socket ordering: a direct send must not overtake a batched chunk.
    this.#batcher.flush();
    this.#sendFrame(msg);
  }

  #sendFrame(msg: Record<string, unknown>): void {
    if (!this.#ready) return;
    try {
      this.#ws.send(JSON.stringify(msg));
    } catch {
      // Socket closed or send failed — stop writing to it
      this.#ready = false;
    }
  }

  /**
   * Drain this channel's stream batch immediately. The hub's raw SESSION_STATE
   * broadcast fans over EVERY connection with sendSafe, bypassing each
   * watcher's batcher -- the bus dispatches per channel in subscription order,
   * so a broadcast from watcher 1 would otherwise land on watcher 2's socket
   * BEFORE watcher 2's own write() drains its buffer (a footer/state frame
   * overtaking a batched chunk across sockets: noteWorking(false) commits the
   * in-flight row, and the trailing chunk would render as a stray post-commit
   * row). The hub therefore flushes every channel of the session first.
   */
  flushPending(): void {
    this.#batcher.flush();
  }

  get ws() {
    return this.#ws;
  }

  get isReady(): boolean {
    return this.#ready;
  }

  get sessionId(): string {
    return this.#sessionId;
  }
}
