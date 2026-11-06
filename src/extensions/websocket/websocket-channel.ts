// Maps OutputEvent → S2C wire protocol and sends JSON over WS.
// The wire shape itself lives in wire-messages.ts, shared with history replay.

import { Channel, ChannelSessionManager } from "@core/channel.ts";
import { OUTPUT_EVENT, OutputEvent } from "@core/context/output.ts";
import type { ArgDisplay, ToolDisplaySpec } from "@core/extensions/tool-registry.ts";
import { toS2CMessage } from "./wire-messages.ts";
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
}

export class WebSocketChannel extends Channel {
  #ws: HotdogServerSocket<unknown>;
  #sessionId: string;
  #ready: boolean;
  #broadcastCallback: ((msg: Record<string, unknown>) => void) | undefined;
  #argDisplay: ((toolName: string) => Record<string, ArgDisplay> | undefined) | undefined;
  #headerKeys: ((toolName: string) => readonly string[] | undefined) | undefined;
  #display: ((toolName: string) => ToolDisplaySpec[] | undefined) | undefined;

  constructor(options: WebSocketChannelOptions) {
    super({ sessionManager: options.sessionManager });
    this.#ws = options.ws;
    this.#sessionId = options.sessionId;
    this.#ready = true;
    this.#broadcastCallback = options.broadcastCallback;
    this.#argDisplay = options.argDisplay;
    this.#headerKeys = options.headerKeys;
    this.#display = options.display;
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

    // Also broadcast session state to all connected clients
    if (event.type === OUTPUT_EVENT.SESSION_STATE && this.#broadcastCallback) {
      this.#broadcastCallback(msg);
    }

    try {
      this.#ws.send(JSON.stringify(msg));
    } catch {
      // Socket closed or send failed — stop writing to it
      this.#ready = false;
    }
  }

  async *read(): AsyncIterable<string> {
    // Placeholder: messages are dispatched via routeMessage, not this iterator.
    yield "";
  }

  protected _cleanup(): void {
    this.#ready = false;
  }

  sendJson(msg: Record<string, unknown>): void {
    if (!this.#ready) return;
    try {
      this.#ws.send(JSON.stringify(msg));
    } catch {
      this.#ready = false;
    }
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
