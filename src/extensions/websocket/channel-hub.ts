// Pure transport, split out of session-registry.ts (B1): the registered
// connections, the pending-auth map + reaper, the per-session channel sets,
// and the broadcast scoping. A hub entry attaches to ANY AgentSessions row;
// the replay cursor stays per-socket (socket.ts), never here. Broadcast
// semantics are unchanged: `broadcastScoped` reaches sockets whose
// activeSessionId matches, task traffic never crosses sessions.

import { WebSocketChannel } from "./websocket-channel.ts";
import type { Agent } from "@core/agent.ts";
import type { SessionManager, AgentLike } from "@core/session/index.ts";
import type { HotdogServerSocket } from "./socket.ts";
import type { SessionMetadata } from "./agent-sessions.ts";
import { PENDING_AUTH_TIMEOUT_MS } from "./constants.ts";

export interface ChannelHubOptions {
  /** Row lookup into the session book (AgentSessions.get). */
  getSession(
    sessionId: string,
  ): { agent: AgentLike; metadata: SessionMetadata } | null;
  /** Raw row lookup INCLUDING worker rows (AgentSessions.getRow): the
   *  agent-agnostic metadata presence, exactly what HEAD's #metadata.get
   *  meant in the removeChannel decrement. */
  getRow(sessionId: string): SessionMetadata | null;
  /** The private SessionManager the WebSocketChannel subscribes through. */
  getSessionManager(): SessionManager;
}

export class ChannelHub {
  #allConnections = new Set<HotdogServerSocket<unknown>>();
  // Sockets that opened without a validated token and are waiting on the
  // protocol AUTH handshake (webui upgrades arrive unauthenticated). The
  // cleanup loop reaps these: without it a client could hold an anonymous
  // socket open forever.
  #pendingAuth = new Map<HotdogServerSocket<unknown>, number>();
  #channels: Map<string, Set<WebSocketChannel>>;
  #options: ChannelHubOptions;

  constructor(options: ChannelHubOptions) {
    this.#options = options;
    this.#channels = new Map();
  }

  registerConnection(ws: HotdogServerSocket<unknown>): void {
    this.#allConnections.add(ws);
  }

  unregisterConnection(ws: HotdogServerSocket<unknown>): void {
    this.#allConnections.delete(ws);
  }

  addPendingAuth(ws: HotdogServerSocket<unknown>): void {
    this.#pendingAuth.set(ws, Date.now());
  }

  removePendingAuth(ws: HotdogServerSocket<unknown>): void {
    this.#pendingAuth.delete(ws);
  }

  broadcast(msg: Record<string, unknown>): void {
    for (const ws of this.#allConnections) {
      ChannelHub.sendSafe(ws, msg);
    }
  }

  /**
   * Broadcast to every registered connection except one. The exclusion is
   * for the adopting socket, which already refreshed its sidebar.
   */
  broadcastExcept(except: HotdogServerSocket<unknown>, msg: Record<string, unknown>): void {
    for (const ws of this.#allConnections) {
      if (ws === except) continue;
      ChannelHub.sendSafe(ws, msg);
    }
  }

  /** Send to sockets whose active session is `sessionId`: task traffic never crosses sessions. */
  broadcastScoped(sessionId: string, msg: Record<string, unknown>): void {
    if (!sessionId) return;
    for (const ws of this.#allConnections) {
      if (ws.activeSessionId === sessionId) ChannelHub.sendSafe(ws, msg);
    }
  }

  static sendSafe(ws: HotdogServerSocket<unknown>, msg: Record<string, unknown>): void {
    try {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
      }
    } catch {}
  }

  /** Close and forget every channel of one session (the delete path). */
  closeChannels(sessionId: string): void {
    const channels = this.#channels.get(sessionId);
    if (channels) {
      for (const ch of channels) {
        ch.close();
      }
      this.#channels.delete(sessionId);
    }
  }

  createChannel(
    sessionId: string,
    ws: HotdogServerSocket<unknown>,
  ): WebSocketChannel | undefined {
    // B3: a hub entry attaches to ANY row. Interactive rows still ride the
    // live-agent oracle (no agent = no attach, byte-identical). Worker rows
    // never enter the private SessionManager, so their channel is pure
    // attach bookkeeping + socket handle: the Channel's event-bus
    // subscription stays inert (no emitToChannels producer exists for a
    // worker sid; frames arrive through publish below). The display-hint
    // resolvers read the row agent through its ACCESSOR, null-tolerant
    // after release: resolvers answer undefined.
    const row = this.#options.getRow(sessionId);
    if (!row) return undefined;
    let agent: AgentLike | null;
    if (row.kind === "worker") {
      agent = row.getAgent?.() ?? null;
    } else {
      const session = this.#options.getSession(sessionId);
      if (!session) return undefined;
      agent = session.agent;
    }

    // One lookup expression for the session agent's tool registry metadata;
    // every display-hint resolver below reads a key off it.
    const metaOf = (toolName: string) =>
      (agent as Partial<Pick<Agent, "toolRegistry">> | null)?.toolRegistry?.getMetadata?.(toolName);

    const channel = new WebSocketChannel({
      sessionManager: this.#options.getSessionManager(),
      ws,
      sessionId,
      broadcastCallback: (msg: Record<string, unknown>) => this.broadcast(msg),
      // Live TOOL_CALL args summaries and display parts read the tool's
      // display hints off the session agent's registry (same metadata the
      // terminal sink consults); the wire carries only the resolved result.
      argDisplay: (toolName) => metaOf(toolName)?.argDisplay,
      headerKeys: (toolName) => metaOf(toolName)?.headerKeys,
      display: (toolName) => metaOf(toolName)?.display,
    });

    if (!this.#channels.has(sessionId)) {
      this.#channels.set(sessionId, new Set());
    }
    this.#channels.get(sessionId)!.add(channel);

    // connectedClients rides the RAW ROW (B1's metadata-only semantics:
    // getRow covers worker rows, get() would refuse them).
    row.connectedClients += 1;
    row.lastActivityAt = Date.now();

    return channel;
  }

  removeChannel(sessionId: string, channel: WebSocketChannel): void {
    channel.detach(sessionId);

    const channels = this.#channels.get(sessionId);
    if (!channels) return;
    channels.delete(channel);

    const meta = this.#options.getRow(sessionId);
    if (meta) {
      meta.connectedClients = Math.max(0, meta.connectedClients - 1);
    }
  }

  /** True if the session has at least one connected channel. */
  hasChannels(sessionId: string): boolean {
    return (this.#channels.get(sessionId)?.size ?? 0) > 0;
  }

  /** Watcher count for one session (ONE map lookup). The live-tail
   *  producer's zero-watcher gate (B3): zero means map nothing, allocate
   *  nothing -- R2's "zero watchers pays nothing". */
  channelCount(sessionId: string): number {
    return this.#channels.get(sessionId)?.size ?? 0;
  }

  /**
   * Deliver one frame to the sockets attached to `sessionId` (sendSafe over
   * the row's channel set -- the same activeSessionId-scope semantics
   * broadcastScoped gives, since a channel exists exactly for the session
   * its socket is on). B3's worker live-tail delivery path; interactive
   * rows keep flowing through the event-bus subscription.
   */
  publish(sessionId: string, frame: Record<string, unknown>): void {
    const channels = this.#channels.get(sessionId);
    if (!channels) return;
    for (const ch of channels) {
      ChannelHub.sendSafe(ch.ws, frame);
    }
  }

  // Close sockets that never completed the AUTH handshake. A validated
  // token lands in ws.authToken (routeMessage), so authenticated sockets
  // just leave the map without being touched. Run from the sweep ticker
  // (facade wires it into AgentSessions' cleanup loop).
  reapPendingAuth(): void {
    const now = Date.now();
    for (const [ws, since] of this.#pendingAuth) {
      if (ws.authToken) {
        this.#pendingAuth.delete(ws);
      } else if (now - since > PENDING_AUTH_TIMEOUT_MS) {
        this.#pendingAuth.delete(ws);
        try {
          ws.close(4001, "Authentication timeout");
        } catch {}
      }
    }
  }

  /** @internal */
  get _test_pendingAuth(): Map<HotdogServerSocket<unknown>, number> {
    return this.#pendingAuth;
  }
}
