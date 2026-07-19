// WebSocket server — session management and WS message routing.
// Provides createWsServer() factory and SessionRegistry class.

import crypto from "node:crypto";
import { OUTPUT_EVENT } from "../../core/context/output.ts";
import { HOOKS } from "../../core/hooks.ts";
import { MessageBus } from "../../core/session/message-bus.ts";
import type { ProviderConfig } from "../../core/llm-client/client.ts";
import { FanoutSink, WebSocketOutputSink, BackgroundSink } from "./sinks.ts";
import { C2S, S2C, C2SMessage } from "./protocol.ts";
import { logger } from "../../core/logger.ts";
import { type CommandRegistryLike } from "../../core/commands.ts";
import type { CoreContext } from "../../core/extensions/types.ts";
import type { AuthMiddleware } from "./auth.ts";
import { Agent } from "../../core/agent.ts";


interface SessionMetadata {
  profile: string;
  model: string;
  createdAt: number;
  lastActivityAt: number;
  connectedClients: number;
  questionStrategy: string;
  questionTimeoutSecs: number;
}

interface Session {
  id: string;
  agent: unknown;
  bus: MessageBus;
  busRunLoop: Promise<unknown>;
  fanoutSink: FanoutSink;
  bgSink: BackgroundSink;
  metadata: SessionMetadata;
}

interface CreateSessionOptions {
  profile?: string;
  model?: string;
  questionStrategy?: string;
  questionTimeoutSecs?: number;
}

interface SessionRegistryOptions {
  buildAgent: (config: { model?: string; sessionId?: string }) => Promise<unknown>;
  questionTimeoutSecs?: number;
  questionStrategy?: string;
  sessionTimeoutMin?: number;
}

interface CreateWsServerOptions {
  buildAgent?: (config: { model?: string; sessionId?: string }) => Promise<unknown>;
  sessionTimeoutMin?: number;
  questionTimeoutSecs?: number;
  questionStrategy?: string;
  auth?: AuthMiddleware;
}

export interface WsServer {
  sessionRegistry: SessionRegistry;
  onUpgrade: (req: { url: string; headers?: Record<string, string> }, ws: WebSocket) => void;
  onMessage: (ws: WebSocket, raw: string | Buffer) => void;
  onClose: (ws: WebSocket) => void;
  startCleanupLoop: () => void;
  stopCleanupLoop: () => void;
}

// ── SessionRegistry ─────────────────────────────────────────────────────────

/**
 * Registry of agent sessions.
 * Each session has an agent, a message bus, and a FanoutSink that
 * distributes output to connected WebSocket clients + a background sink.
 *
 * Sessions persist even when no clients are connected. Idle sessions
 * are cleaned up after a configurable timeout.
 */
export class SessionRegistry {
  #sessions = new Map<string, Session>(); // sessionId → Session
  #buildAgent: (config: { model?: string; sessionId?: string }) => Promise<unknown>;
  #questionTimeoutSecs: number;
  #questionStrategy: string;
  #cleanupTimer: ReturnType<typeof setInterval> | null = null;
  #timeoutMin: number;
  // All active WebSocket connections — used for broadcasting events to all clients.
  #allConnections = new Set<WebSocket>();

  constructor({ buildAgent, questionTimeoutSecs = 300, questionStrategy = "wait", sessionTimeoutMin = 30 }: SessionRegistryOptions) {
    this.#buildAgent = buildAgent;
    this.#questionTimeoutSecs = questionTimeoutSecs;
    this.#questionStrategy = questionStrategy;
    this.#timeoutMin = sessionTimeoutMin;
  }

  /**
   * Register a WebSocket connection for broadcast purposes.
   */
  registerConnection(ws: WebSocket): void {
    this.#allConnections.add(ws);
  }

  /**
   * Unregister a WebSocket connection.
   */
  unregisterConnection(ws: WebSocket): void {
    this.#allConnections.delete(ws);
  }

  /**
   * Broadcast a JSON message to all connected WebSocket clients.
   * Silently skips connections that are closed or error.
   */
  broadcast(msg: Record<string, unknown>): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.#allConnections) {
      try {
        if (ws.readyState === 1) { // WebSocket.OPEN
          ws.send(payload);
        }
      } catch {
        // Connection error — connection will be cleaned up on close
      }
    }
  }

  /**
   * Create a new session with its own agent and message bus.
   * The bus run loop starts immediately.
   */
  async create({ profile, model, questionStrategy, questionTimeoutSecs }: CreateSessionOptions = {}): Promise<{ sessionId: string; agent: unknown; bus: MessageBus }> {
    const sessionId = crypto.randomUUID();

    // Build the agent
    const agent = await this.#buildAgent({ model, sessionId });

    // Create a minimal session-manager-like wrapper so the bus can access the agent
    const sessionManager = {
      getAgent: () => agent,
      sessionId: () => (agent as Agent)?.sessionId,
    };

    // Build fanout sink with background sink
    const fanout = new FanoutSink();
    const bgSink = new BackgroundSink();
    fanout.add(bgSink);

    // Create the message bus with a broadcast callback for session state events.
    // This ensures all connected clients receive working state changes,
    // not just clients attached to this session.
    const bus = new MessageBus({
      sessionManager: sessionManager as unknown as { getAgent: () => { hooks: { runHookPipeline: (hookName: string, data: unknown, opts?: { shouldStop?: (result: unknown) => boolean }) => Promise<unknown> }; run: (text: string) => Promise<unknown>; resetCancel: () => void; cancel: () => void; commandRegistry: CommandRegistryLike | undefined; executeCommand: (cmd: unknown) => Promise<unknown> } | undefined },
      sink: fanout,
      broadcastCallback: (msg: Record<string, unknown>) => this.broadcast(msg),
    });

    // Wire agent's sink to the fanout so agent emits events to fanout
    if (agent) (agent as Agent).sink = fanout;

    // Start the bus run loop (non-blocking — it awaits messages as they arrive)
    const runLoop = bus.run().catch((err: unknown) => {
      logger.error(`[session ${sessionId}] bus error:`, err as Record<string, unknown>);
    });

    const session: Session = {
      id: sessionId,
      agent,
      bus,
      busRunLoop: runLoop,
      fanoutSink: fanout,
      bgSink,
      metadata: {
        profile: profile || "default",
        model: (agent as Agent)?.model || "",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        connectedClients: 0,
        questionStrategy: questionStrategy || this.#questionStrategy,
        questionTimeoutSecs: questionTimeoutSecs || this.#questionTimeoutSecs,
      },
    };

    this.#sessions.set(sessionId, session);
    return { sessionId, agent, bus };
  }

  /**
   * Get a session by ID.
   */
  get(sessionId: string): Session | null {
    return this.#sessions.get(sessionId) || null;
  }

  /**
   * List all sessions with metadata.
   */
  list(): Array<{ id: string; profile: string; model: string; createdAt: number; lastActivityAt: number; connectedClients: number }> {
    const result: Array<{ id: string; profile: string; model: string; createdAt: number; lastActivityAt: number; connectedClients: number }> = [];
    for (const [id, s] of this.#sessions) {
      result.push({
        id,
        profile: s.metadata.profile,
        model: (s.agent as Agent)?.model || s.metadata.model,
        createdAt: s.metadata.createdAt,
        lastActivityAt: s.metadata.lastActivityAt,
        connectedClients: s.metadata.connectedClients,
      });
    }
    return result;
  }

  /**
   * Delete a session — stops the bus, cleans up sinks.
   */
  delete(sessionId: string): boolean {
    const s = this.#sessions.get(sessionId);
    if (!s) return false;

    // Cancel the bus so the run loop exits
    s.bus.cancel();

    // Remove sinks from fanout
    s.fanoutSink.remove(s.bgSink);
    this.#sessions.delete(sessionId);
    return true;
  }

  /**
   * Rename a session (update its profile label).
   */
  rename(sessionId: string, newName: string): boolean {
    const s = this.#sessions.get(sessionId);
    if (!s) return false;
    s.metadata.profile = newName;
    return true;
  }

  /**
   * Attach a WebSocket output sink to a session.
   */
  attachSink(sessionId: string, ws: WebSocket): WebSocketOutputSink | undefined {
    const s = this.#sessions.get(sessionId);
    if (!s) return undefined;

    const wsSink = new WebSocketOutputSink(ws, sessionId);
    s.fanoutSink.add(wsSink);
    s.metadata.connectedClients += 1;
    s.metadata.lastActivityAt = Date.now();

    // Drain any pending questions to the new sink
    const pending = s.bgSink.drainPendingQuestions();
    for (const questions of pending) {
      wsSink.emit({
        type: OUTPUT_EVENT.QUESTION,
        questions,
      });
    }

    return wsSink;
  }

  /**
   * Detach a WebSocket output sink from a session.
   */
  detachSink(sessionId: string, wsSink: WebSocketOutputSink): void {
    const s = this.#sessions.get(sessionId);
    if (!s) return;
    s.fanoutSink.remove(wsSink);
    s.metadata.connectedClients = Math.max(0, s.metadata.connectedClients - 1);
  }

  /**
   * Touch session (update lastActivityAt) to prevent idle cleanup.
   */
  touch(sessionId: string): void {
    const s = this.#sessions.get(sessionId);
    if (s) {
      s.metadata.lastActivityAt = Date.now();
    }
  }

  /**
   * Start idle session cleanup loop.
   */
  startCleanupLoop(timeoutMin: number): void {
    this.#timeoutMin = timeoutMin;
    if (this.#cleanupTimer) return;
    this.#cleanupTimer = setInterval(() => {
      this.#cleanupIdleSessions();
    }, 60_000);
  }

  /**
   * Stop idle session cleanup loop.
   */
  stopCleanupLoop(): void {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
  }

  #cleanupIdleSessions(): void {
    const now = Date.now();
    const timeoutMs = this.#timeoutMin * 60 * 1000;
    for (const [id, s] of this.#sessions) {
      if (now - s.metadata.lastActivityAt > timeoutMs && s.metadata.connectedClients === 0) {
        this.delete(id);
      }
    }
  }

  /** Number of active sessions. */
  get size(): number {
    return this.#sessions.size;
  }
}

// ── Session History Replay ──────────────────────────────────────────────────

interface Message {
  role: string;
  content?: string;
  reasoningContent?: string;
  toolCalls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
  toolCallId?: string;
  getTextContent?(): string;
}

/**
 * Replay a session's message history to a WebSocket client.
 * Iterates through the agent's context and emits the appropriate
 * OUTPUT_EVENT-derived messages so the frontend can reconstruct the chat.
 */
function replaySessionHistory(session: Session, ws: WebSocket): void {
  const agent = session.agent as Agent;
  if (!agent || !agent.log) return;

  // Collect tool calls from the most recent assistant message to match
  // tool results by toolCallId.
  let pendingToolCalls: Array<{ id: string; function?: { name?: string; arguments?: string } }> = [];

  for (const msg of agent.log) {
    switch (msg.role) {
      case "user": {
        ws.send(JSON.stringify({
          type: S2C.USER_MESSAGE,
          sessionId: session.id,
          content: typeof msg.getTextContent === "function" ? msg.getTextContent() : (msg.content || ""),
        }));
        break;
      }

      case "assistant": {
        // Emit reasoning/thinking content first (if any) so the UI
        // renders it before the text or tool calls
        if (msg.reasoningContent) {
          ws.send(JSON.stringify({
            type: S2C.THINKING,
            sessionId: session.id,
            content: msg.reasoningContent,
          }));
        }

        // Emit tool calls next (if any) so the UI renders them before the text
        const toolCalls = msg.toolCalls as Array<{ id: string; function?: { name?: string; arguments?: string } }> | undefined;
        if (toolCalls && toolCalls.length > 0) {
          pendingToolCalls = toolCalls;
          for (const tc of toolCalls) {
            ws.send(JSON.stringify({
              type: S2C.TOOL_CALL,
              sessionId: session.id,
              name: tc.function?.name || "unknown",
              args: tc.function?.arguments || "{}",
            }));
          }
        }
        // Then emit the assistant message text (only if there is any)
        const textContent = typeof msg.getTextContent === "function" ? msg.getTextContent() : (msg.content || "");
        if (textContent) {
          ws.send(JSON.stringify({
            type: S2C.ASSISTANT_MESSAGE,
            sessionId: session.id,
            content: textContent,
          }));
        }
        break;
      }

      case "tool": {
        // Match this tool result to the pending tool calls by toolCallId
        const matchedCall = pendingToolCalls.find(
          (tc) => tc.id === msg.toolCallId,
        );
        ws.send(JSON.stringify({
          type: S2C.TOOL_RESULT,
          sessionId: session.id,
          name: matchedCall?.function?.name || "unknown",
          output: msg.content || "",
        }));
        break;
      }

      // system messages are skipped — they are not user-visible
      default:
        break;
    }
  }
}

// ── WS Message Routing ──────────────────────────────────────────────────────

/**
 * Route incoming WS messages to the right session handler.
 */
function routeMessage(ws: WebSocket, msg: C2SMessage, registry: SessionRegistry, authMiddleware: AuthMiddleware | undefined): void {
  switch (msg.type) {
    case C2S.AUTH: {
      // Authenticate via in-band message (alternative to query param)
      if (authMiddleware && msg.token) {
        const valid = authMiddleware.validateToken(msg.token as string);
        if (valid) {
          (ws as WebSocket & { authToken?: string }).authToken = msg.token as string;
          ws.send(JSON.stringify({ type: "authOk" }));
          // If no session exists yet, attach to existing or create new
          if (!(ws as WebSocket & { activeSessionId?: string }).activeSessionId) {
            if (registry.size > 0) {
              attachToMostRecentSession(ws, registry);
            } else {
              createAndAttachSession(ws, registry);
            }
          }
        } else {
          ws.send(JSON.stringify({ type: "authError", message: "Invalid token" }));
        }
      }
      break;
    }

    case C2S.CREATE_SESSION: {
      // Detach from old session first, if any
      const typedWs = ws as WebSocket & { activeSessionId?: string; activeSink?: WebSocketOutputSink };
      if (typedWs.activeSessionId && typedWs.activeSink) {
        registry.detachSink(typedWs.activeSessionId, typedWs.activeSink);
      }
      registry.create({
        profile: msg.profile as string | undefined,
        model: msg.model as string | undefined,
        questionStrategy: msg.questionStrategy as string | undefined,
        questionTimeoutSecs: msg.questionTimeoutSecs as number | undefined,
      }).then(({ sessionId, agent }) => {
        // Attach this WS to the new session
        const wsSink = registry.attachSink(sessionId, ws);
        typedWs.activeSessionId = sessionId;
        typedWs.activeSink = wsSink;

        const sessionCreatedMsg = {
          type: "sessionCreated",
          sessionId,
          profile: (agent as Agent)?.profileName || "default",
          currentModel: (agent as Agent)?.model,
          models: Object.keys((agent as Agent)?.modelRegistry || {}),
        };
        // Send to requesting client and broadcast to all clients
        ws.send(JSON.stringify(sessionCreatedMsg));
        registry.broadcast(sessionCreatedMsg);
      }).catch((err: unknown) => {
        ws.send(JSON.stringify({ type: "error", message: (err as Error).message }));
      });
      break;
    }

    case C2S.DELETE_SESSION: {
      if (msg.sessionId) {
        registry.delete(msg.sessionId as string);
        const sessionDeletedMsg = { type: "sessionDeleted", sessionId: msg.sessionId };
        // Send to requesting client and broadcast to all clients
        ws.send(JSON.stringify(sessionDeletedMsg));
        registry.broadcast(sessionDeletedMsg);
      }
      break;
    }

    case C2S.RENAME_SESSION: {
      if (msg.sessionId && msg.newName) {
        registry.rename(msg.sessionId as string, msg.newName as string);
      }
      break;
    }

    case C2S.LIST_SESSIONS: {
      const sessions = registry.list();
      ws.send(JSON.stringify({ type: "sessions", sessions }));
      break;
    }

    case C2S.SWITCH_SESSION: {
      if (msg.sessionId) {
        const session = registry.get(msg.sessionId as string);
        if (session) {
          // Detach from old session
          const typedWs = ws as WebSocket & { activeSessionId?: string; activeSink?: WebSocketOutputSink };
          if (typedWs.activeSessionId && typedWs.activeSink) {
            registry.detachSink(typedWs.activeSessionId, typedWs.activeSink);
          }
          // Attach to new session
          const wsSink = registry.attachSink(msg.sessionId as string, ws);
          typedWs.activeSessionId = msg.sessionId as string;
          typedWs.activeSink = wsSink;
          // Send session metadata so the frontend can update reactively
          const agent = session.agent as Agent;
          ws.send(JSON.stringify({
            type: S2C.SESSION_STATE,
            key: "model",
            value: agent?.model || session.metadata.model || "?",
          }));
          ws.send(JSON.stringify({
            type: S2C.SESSION_STATE,
            key: "models",
            value: Object.keys(agent?.modelRegistry || {}),
          }));
          ws.send(JSON.stringify({
            type: S2C.SESSION_STATE,
            key: "profile",
            value: agent?.profileName || session.metadata.profile || "default",
          }));
          // Replay session history so the client sees the full conversation
          replaySessionHistory(session, ws);
        }
      }
      break;
    }

    case C2S.SEND: {
      if (msg.sessionId && msg.content) {
        registry.touch(msg.sessionId as string);
        const session = registry.get(msg.sessionId as string);
        if (session) {
          session.bus.enqueue(msg.content as string);
        }
      }
      break;
    }

    case C2S.CANCEL: {
      if (msg.sessionId) {
        const session = registry.get(msg.sessionId as string);
        if (session) {
          session.bus.cancel();
        }
      }
      break;
    }

    case C2S.QUESTION_ANSWER: {
      if (msg.sessionId && msg.answers) {
        // Forward answers to the question tool via the agent
        // This is handled by the Input interface — we need to set up
        // a mechanism for the agent to receive answers.
        // For now, this is a placeholder — the question tool integration
        // will be implemented in Phase 3.
        console.warn("[ws] questionAnswer received — question tool integration pending");
      }
      break;
    }

    case C2S.COMMAND: {
      if (msg.sessionId && msg.command) {
        registry.touch(msg.sessionId as string);
        const session = registry.get(msg.sessionId as string);
        if (session) {
          // Strip leading `/` and lowercase, matching the CLI behavior
          let cmdText = msg.command as string;
          if (cmdText.startsWith("/")) {
            cmdText = cmdText.slice(1).trim().toLowerCase();
          }
          session.bus.executeCommand(cmdText);
        }
      }
      break;
    }

    default: {
      ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${(msg as Record<string, unknown>).type}` }));
      break;
    }
  }
}

// ── Helper functions (used by createWsServer) ────────────────────────────────

function attachToMostRecentSession(ws: WebSocket, registry: SessionRegistry): void {
  // Find the session with the most recent lastActivityAt
  const sessions = registry.list();
  let mostRecent: { id: string; lastActivityAt: number; profile: string; model: string } | null = null;
  let mostRecentTime = 0;
  for (const s of sessions) {
    if (s.lastActivityAt > mostRecentTime) {
      mostRecent = s;
      mostRecentTime = s.lastActivityAt;
    }
  }

  if (!mostRecent) {
    // Fallback — create a new session
    createAndAttachSession(ws, registry);
    return;
  }

  const sessionId = mostRecent.id;
  const session = registry.get(sessionId);
  if (!session || !session.agent) {
    createAndAttachSession(ws, registry);
    return;
  }

  // Attach the WebSocket sink to the existing session
  const wsSink = registry.attachSink(sessionId, ws);
  const typedWs = ws as WebSocket & { activeSessionId?: string; activeSink?: WebSocketOutputSink };
  typedWs.activeSessionId = sessionId;
  typedWs.activeSink = wsSink;

  // Send sessionCreated so the client sets up its UI for this session
  const agent = session.agent as Agent;
  ws.send(JSON.stringify({
    type: "sessionCreated",
    sessionId,
    profile: agent?.profileName || mostRecent.profile || "default",
    currentModel: agent?.model || mostRecent.model || "?",
    models: Object.keys(agent?.modelRegistry || {}),
  }));

  // Replay session history so the client sees the full conversation
  replaySessionHistory(session, ws);
}

function createAndAttachSession(ws: WebSocket, registry: SessionRegistry): void {
  registry.create({}).then(({ sessionId, agent }) => {
    const wsSink = registry.attachSink(sessionId, ws);
    const typedWs = ws as WebSocket & { activeSessionId?: string; activeSink?: WebSocketOutputSink };
    typedWs.activeSessionId = sessionId;
    typedWs.activeSink = wsSink;

    ws.send(JSON.stringify({
      type: "sessionCreated",
      sessionId,
      profile: (agent as Agent)?.profileName || "default",
      currentModel: (agent as Agent)?.model,
      models: Object.keys((agent as Agent)?.modelRegistry || {}),
    }));
  }).catch((err: unknown) => {
    ws.send(JSON.stringify({ type: "error", message: (err as Error).message }));
    ws.close(4003, "Failed to create session");
  });
}

// ── createWsServer Factory ───────────────────────────────────────────────────

/**
 * Create a WebSocket server handler object.
 * Provides the onUpgrade handler for Bun.serve() and session registry.
 */
export function createWsServer(core: CoreContext, options: CreateWsServerOptions = {}): WsServer {
  const {
    buildAgent: customBuildAgent,
    sessionTimeoutMin = 30,
    questionTimeoutSecs = 300,
    questionStrategy = "wait",
    auth,
  } = options;

  // Default agent builder — creates a basic agent using core infrastructure
  const buildAgent = customBuildAgent || (async (agentConfig: { model?: string; sessionId?: string }) => {
    const { LlmClient } = await import("../../core/llm-client/client.ts");
    const { MarkerMangler } = await import("../../core/marker-mangler.ts");
    const { Agent } = await import("../../core/agent.ts");

    const llmClient = new LlmClient({
      baseUrl: core.resolved?.baseUrl as string | undefined,
      apiKey: core.resolved?.apiKey as string | undefined,
      stream: core.resolved?.stream !== false,
      chatTimeoutSecs: (core.resolved?.chatTimeout as number) || 30,
      maxRetries: (core.resolved?.maxRetries as number) || 3,
      providers: core.config?.providers as ProviderConfig[] | undefined,
      markerMangler: new MarkerMangler(),
    });

    const sessionId = agentConfig.sessionId || crypto.randomUUID();
    const agent = new Agent({
      hooks: core.hooks,
      toolRegistry: core.toolRegistry,
      llmClient,
      model: (agentConfig as { model?: string }).model || (core.resolved?.model as string) || "",
      maxIterations: (core.resolved?.maxIterations as number) || 100,
      contextLimit: 128000,
      hideTools: (agentConfig as { hideTools?: boolean }).hideTools ?? (core.resolved?.hideTools as boolean) ?? false,
      hideThinking: (agentConfig as { hideThinking?: boolean }).hideThinking ?? (core.resolved?.hideThinking as boolean) ?? true,
      showTokenUse: (agentConfig as { showTokenUse?: boolean }).showTokenUse ?? (core.resolved?.showTokenUse as boolean) ?? true,
      sink: ((agentConfig as { sink?: { emit: (event: unknown) => void } }).sink as { emit: (event: unknown) => void } | null) || null,
      modelRegistry: core.resolved?.modelRegistry as { [key: string]: { contextLimit?: number; reasoningEffort?: string; [key: string]: unknown } } | undefined,
      profileName: (agentConfig as { profileName?: string }).profileName || (core.resolved?.profileName as string) || "default",
      config: core.config || {},
      sessionId,
      abortSignal: null,
      toolWhitelist: null,
    });

    await agent.ensureSystemPrompt();

    // Emit COMMANDS_REGISTER so extensions can register commands
    if (core.hooks) {
      core.hooks.notifyHooks(HOOKS.COMMANDS_REGISTER, {
        registry: agent?.commandRegistry,
        agent,
      });
    }

    return agent;
  });

  const registry = new SessionRegistry({
    buildAgent,
    questionTimeoutSecs,
    questionStrategy,
    sessionTimeoutMin,
  });

  /**
   * WS upgrade handler — called when a WebSocket connection opens.
   * Validates auth if middleware is configured, then creates a session.
   */
  function onUpgrade(req: { url: string; headers?: Record<string, string> }, ws: WebSocket): void {
    // Register this connection for broadcast purposes
    registry.registerConnection(ws);

    // Auth: validate token from query param
    const url = new URL(req.url, `http://${req.headers?.host || "localhost"}`);
    const token = url.searchParams.get("token");

    if (auth && token) {
      if (!auth.validateToken(token)) {
        ws.send(JSON.stringify({ type: "authError", message: "Invalid or expired token" }));
        ws.close(4001, "Invalid token");
        return;
      }
      (ws as WebSocket & { authToken?: string }).authToken = token;
    } else if (auth && !token) {
      // No token — require auth via first message
      ws.send(JSON.stringify({ type: "authRequired" }));
      // Don't close — client can send auth message later
      // Don't create a session yet — wait for auth message
      return;
    }

    // Auth check passed (or auth disabled) — check for existing sessions
    // If there are existing sessions, attach to the most recently active one
    // instead of creating a new one.
    const existingCount = registry.size;
    if (existingCount > 0) {
      attachToMostRecentSession(ws, registry);
    } else {
      createAndAttachSession(ws, registry);
    }
  }

  /**
   * Handle incoming WS messages.
   */
  function onMessage(ws: WebSocket, raw: string | Buffer): void {
    let msg: C2SMessage;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as C2SMessage;
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (!msg.type) {
      ws.send(JSON.stringify({ type: "error", message: "Message type required" }));
      return;
    }

    routeMessage(ws, msg, registry, auth);
  }

  /**
   * Handle WS close — detach sink from session.
   */
  function onClose(ws: WebSocket): void {
    const typedWs = ws as WebSocket & { activeSessionId?: string; activeSink?: WebSocketOutputSink };
    if (typedWs.activeSessionId && typedWs.activeSink) {
      registry.detachSink(typedWs.activeSessionId, typedWs.activeSink);
    }
    // Unregister from broadcast
    registry.unregisterConnection(ws);
  }

  return {
    sessionRegistry: registry,
    onUpgrade,
    onMessage,
    onClose,
    startCleanupLoop: () => registry.startCleanupLoop(sessionTimeoutMin),
    stopCleanupLoop: () => registry.stopCleanupLoop(),
  };
}
