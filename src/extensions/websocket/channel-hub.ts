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
  /** Live stream-batch window reader handed to every created channel
   *  (webui.streamBatchMs, per-frame read; omitted = off). */
  streamBatchMs?: () => number;
  /** Injectable stream-batch timer for deterministic tests. */
  streamBatchTimer?: (cb: () => void, ms: number) => () => void;
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
    // The raw fan-out (sendSafe over every connection) bypasses each
    // watcher's stream batcher, so ANY same-session frame broadcast here --
    // SESSION_STATE, QUESTION (resume.ts re-presents a held question),
    // QUESTION_ANSWERED (answer echo / dismiss) -- would otherwise land on a
    // watcher's socket BEFORE its own still-buffered chunk (the bus
    // dispatches per channel; a raw frame from anyone's path overtakes
    // everyone else's window). Drain every channel of the frame's session
    // first: per-session order holds on EVERY socket, not just the writer's.
    const sid = typeof msg.sessionId === "string" ? msg.sessionId : null;
    if (sid) this.flushSession(sid);
    for (const ws of this.#allConnections) {
      ChannelHub.sendSafe(ws, msg);
    }
  }

  /**
   * Drain the stream batch of every channel of one session (the raw fan-out
   * seam, see broadcast()). A no-op when the session has no watchers or an
   * empty buffer.
   */
  flushSession(sessionId: string): void {
    const channels = this.#channels.get(sessionId);
    if (!channels) return;
    for (const ch of channels) ch.flushPending();
  }

  /**
   * Drain the stream batches of every channel of ONE SOCKET (the direct-send
   * seam). A raw `ws.send(...)` from a handler is neither a hub method nor a
   * channel sink, so it lands on the socket instantly while that socket's
   * batch window is open -- an S2C.ERROR frame (whose client handler commits
   * the in-flight row: message-list handleError -> finalizeAssistant) would
   * otherwise overtake the requester's own still-buffered tail, and the
   * flushed continuation would render as a stray post-commit row. Same
   * doctrine as flushSession, keyed on the destination socket instead of the
   * session. Synchronous; a no-op when the socket has no channels or empty
   * buffers; knob 0 already ships everything, so flushing changes nothing;
   * other sockets' channels are untouched.
   */
  flushSocket(ws: HotdogServerSocket<unknown>): void {
    for (const channels of this.#channels.values()) {
      for (const ch of channels) {
        if (ch.ws === ws) ch.flushPending();
      }
    }
  }

  /**
   * Broadcast to every registered connection except one. The exclusion is
   * for the adopting socket, which already refreshed its sidebar.
   */
  broadcastExcept(except: HotdogServerSocket<unknown>, msg: Record<string, unknown>): void {
    const sid = typeof msg.sessionId === "string" ? msg.sessionId : null;
    if (sid) this.flushSession(sid);
    for (const ws of this.#allConnections) {
      if (ws === except) continue;
      ChannelHub.sendSafe(ws, msg);
    }
  }

  /** Send to sockets whose active session is `sessionId`: task traffic never crosses sessions. */
  broadcastScoped(sessionId: string, msg: Record<string, unknown>): void {
    if (!sessionId) return;
    // Same raw-fan-out seam as broadcast(): the target sockets' channels for
    // this session drain first, so a scoped frame (TASK_UPDATE rows ticking
    // while the session streams) never overtakes that session's buffered
    // chunk on any of them.
    this.flushSession(sessionId);
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
      // The drain for the raw fan-out lives in broadcast() itself (keyed by
      // the frame's sessionId), so every raw same-session frame -- this
      // SESSION_STATE path AND the resume/handlers question broadcasts --
      // flushes the watchers' batches first.
      broadcastCallback: (msg: Record<string, unknown>) => this.broadcast(msg),
      // Live TOOL_CALL args summaries and display parts read the tool's
      // display hints off the session agent's registry (same metadata the
      // terminal sink consults); the wire carries only the resolved result.
      argDisplay: (toolName) => metaOf(toolName)?.argDisplay,
      headerKeys: (toolName) => metaOf(toolName)?.headerKeys,
      display: (toolName) => metaOf(toolName)?.display,
      streamBatchMs: this.#options.streamBatchMs,
      streamBatchTimer: this.#options.streamBatchTimer,
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
   * rows keep flowing through the event-bus subscription. Each channel's
   * OWN stream batcher coalesces (per-watcher buffers: one busy worker never
   * delays another session), and non-streaming frames flush-before-send in
   * each channel just like the interactive write() path.
   */
  publish(sessionId: string, frame: Record<string, unknown>): void {
    const channels = this.#channels.get(sessionId);
    if (!channels) return;
    for (const ch of channels) {
      ch.deliverFrame(frame);
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
