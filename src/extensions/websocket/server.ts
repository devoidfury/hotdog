// WebSocket server — session management and WS message routing.
// Provides createWsServer() factory and SessionRegistry class.

import crypto from "node:crypto";
import { HOOKS } from "../../core/hooks.ts";
import { SessionManager } from "../../core/session/index.ts";
import { WebSocketChannel } from "./websocket-channel.ts";
import { C2S, S2C, C2SMessage } from "./protocol.ts";
import { LlmClient, type ProviderConfig } from "../../core/llm-client/client.ts";
import { MarkerMangler } from "../../core/marker-mangler.ts";
import type { CoreContext } from "../../core/extensions/types.ts";
import type { AuthMiddleware } from "./auth.ts";
import { Agent } from "../../core/agent.ts";
import { readSessionEntries, replayEntriesIntoContext, listSessionLogs, deleteSessionLog } from "../../core/session/session-log.ts";

// ── Types ───────────────────────────────────────────────────────────────────

interface SessionMetadata {
  profile: string;
  model: string;
  createdAt: number;
  lastActivityAt: number;
  connectedClients: number;
  questionStrategy: string;
  questionTimeoutSecs: number;
}

interface CreateSessionOptions {
  profile?: string;
  model?: string;
  questionStrategy?: string;
  questionTimeoutSecs?: number;
}

interface SessionRegistryOptions {
  buildAgent: (config: { model?: string; sessionId?: string }) => Promise<unknown>;
  llmClient?: unknown;
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
 * Registry of agent sessions backed by SessionManager.
 * Each session has an agent, a message bus (owned by SessionManager),
 * and WebSocketChannel instances for connected clients.
 *
 * Sessions persist even when no clients are connected. Idle sessions
 * are cleaned up after a configurable timeout.
 */
export class SessionRegistry {
  #sessionManager: SessionManager;
  #buildAgent: (config: { model?: string; sessionId?: string }) => Promise<unknown>;
  #questionTimeoutSecs: number;
  #questionStrategy: string;
  #cleanupTimer: ReturnType<typeof setInterval> | null = null;
  #timeoutMin: number;
  // All active WebSocket connections — used for broadcasting events to all clients.
  #allConnections = new Set<WebSocket>();
  // Per-session metadata
  #metadata: Map<string, SessionMetadata>;
  // Per-session WebSocketChannel instances
  #channels: Map<string, Set<WebSocketChannel>>;

  constructor({ buildAgent, llmClient, questionTimeoutSecs = 300, questionStrategy = "wait", sessionTimeoutMin = 30 }: SessionRegistryOptions) {
    this.#buildAgent = buildAgent;
    this.#questionTimeoutSecs = questionTimeoutSecs;
    this.#questionStrategy = questionStrategy;
    this.#timeoutMin = sessionTimeoutMin;
    this.#metadata = new Map();
    this.#channels = new Map();

    // Create SessionManager — passes llmClient through buildAgent config
    this.#sessionManager = new SessionManager({
      hooks: { notifyHooks: () => {} }, // No-op hooks for now
      extensions: null,
      buildAgent: buildAgent as (config: Record<string, unknown>) => Promise<import("../../core/session/index.ts").AgentLike>,
      llmClient,
    });
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
   * Create a new session with its own agent.
   * The SessionManager creates the internal MessageBus automatically.
   */
  async create({ profile, model, questionStrategy, questionTimeoutSecs }: CreateSessionOptions = {}): Promise<{ sessionId: string; agent: unknown }> {
    const proposedSessionId = crypto.randomUUID();

    // Build the agent — pass proposed sessionId but use the agent's actual sessionId
    const agent = await this.#buildAgent({ model, sessionId: proposedSessionId });
    const actualSessionId = (agent as Agent)?.sessionId || proposedSessionId;

    // Store metadata under the agent's actual sessionId
    this.#metadata.set(actualSessionId, {
      profile: profile || "default",
      model: (agent as Agent)?.model || "",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      connectedClients: 0,
      questionStrategy: questionStrategy || this.#questionStrategy,
      questionTimeoutSecs: questionTimeoutSecs || this.#questionTimeoutSecs,
    });

    // Register with SessionManager — this creates the MessageBus and wires the sink
    this.#sessionManager.registerAgent(agent as unknown as import("../../core/session/index.ts").AgentLike, {
      profile: profile || "default",
      model,
    });

    return { sessionId: actualSessionId, agent };
  }

  /**
   * Get a session by ID.
   */
  get(sessionId: string): { agent: unknown; metadata: SessionMetadata } | null {
    const metadata = this.#metadata.get(sessionId);
    if (!metadata) return null;
    // Look up agent from the store — try by sessionId first, then from SessionStore
    const agent = this.#sessionManager.getAgentBySessionId(sessionId);
    if (!agent) return null;
    return { agent, metadata };
  }

  /**
   * List all sessions with metadata.
   */
  list(): Array<{ id: string; profile: string; model: string; createdAt: number; lastActivityAt: number; connectedClients: number }> {
    const result: Array<{ id: string; profile: string; model: string; createdAt: number; lastActivityAt: number; connectedClients: number }> = [];
    for (const [id, meta] of this.#metadata) {
      const agent = this.#sessionManager.getAgentBySessionId(id);
      result.push({
        id,
        profile: meta.profile,
        model: (agent as Agent)?.model || meta.model,
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        connectedClients: meta.connectedClients,
      });
    }
    return result;
  }

  /**
   * Delete a session — cancels the bus, cleans up metadata.
   */
  delete(sessionId: string): boolean {
    const meta = this.#metadata.get(sessionId);
    if (!meta) return false;

    // Clean up channels
    const channels = this.#channels.get(sessionId);
    if (channels) {
      for (const ch of channels) {
        ch.close();
      }
      this.#channels.delete(sessionId);
    }

    // Delete session — cancels bus, removes event handlers, removes from store
    this.#sessionManager.deleteSession(sessionId);
    this.#metadata.delete(sessionId);
    return true;
  }

  /**
   * Rename a session (update its profile label).
   */
  rename(sessionId: string, newName: string): boolean {
    const meta = this.#metadata.get(sessionId);
    if (!meta) return false;
    meta.profile = newName;
    return true;
  }

  /**
   * Create a WebSocketChannel for a session and attach it.
   */
  createChannel(sessionId: string, ws: WebSocket): WebSocketChannel | undefined {
    const session = this.get(sessionId);
    if (!session) return undefined;

    const channel = new WebSocketChannel({
      sessionManager: this.#sessionManager,
      ws,
      sessionId,
      broadcastCallback: (msg: Record<string, unknown>) => this.broadcast(msg),
    });

    // Track the channel
    if (!this.#channels.has(sessionId)) {
      this.#channels.set(sessionId, new Set());
    }
    this.#channels.get(sessionId)!.add(channel);

    // Update metadata
    session.metadata.connectedClients += 1;
    session.metadata.lastActivityAt = Date.now();

    return channel;
  }

  /**
   * Remove a WebSocketChannel from a session.
   * Detaches the channel first to clean up its event subscription.
   */
  removeChannel(sessionId: string, channel: WebSocketChannel): void {
    // Detach from the session to unsubscribe event handlers
    channel.detach(sessionId);

    const channels = this.#channels.get(sessionId);
    if (!channels) return;
    channels.delete(channel);

    const meta = this.#metadata.get(sessionId);
    if (meta) {
      meta.connectedClients = Math.max(0, meta.connectedClients - 1);
    }
  }

  /**
   * Touch session (update lastActivityAt) to prevent idle cleanup.
   */
  touch(sessionId: string): void {
    const meta = this.#metadata.get(sessionId);
    if (meta) {
      meta.lastActivityAt = Date.now();
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
    for (const [id, meta] of this.#metadata) {
      if (now - meta.lastActivityAt > timeoutMs && meta.connectedClients === 0) {
        this.delete(id);
      }
    }
  }

  /** Number of active sessions. */
  get size(): number {
    return this.#metadata.size;
  }

  /**
   * Get the SessionManager for direct access.
   * @internal
   */
  getSessionManager(): SessionManager {
    return this.#sessionManager;
  }

  // ── Test-only accessors ─────────────────────────────────────────────────

  /** @internal Exposed for testing. */
  get _test_metadata(): Map<string, SessionMetadata> { return this.#metadata; }

  /** @internal Exposed for testing. */
  get _test_timeoutMin(): number { return this.#timeoutMin; }
  set _test_timeoutMin(v: number) { this.#timeoutMin = v; }

  /** @internal Exposed for testing. */
  _test_cleanupIdleSessions(): void { this.#cleanupIdleSessions(); }
}

// ── Cold Session Log Helpers ────────────────────────────────────────────────

/**
 * Load a session log into a new session.
 * Creates a new session and replays the log entries into its context.
 */
async function loadLogIntoNewSession(
  logId: string,
  registry: SessionRegistry,
): Promise<{ sessionId: string; agent: unknown }> {
  const entries = await readSessionEntries(logId);
  if (entries.length === 0) {
    throw new Error(`No entries found for session ${logId}`);
  }

  // Create a new session
  const newSession = await registry.create({});
  const agent = newSession.agent as Agent;

  // Replay the log entries into the new agent's context
  replayEntriesIntoContext(agent, entries);

  return { sessionId: newSession.sessionId, agent };
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
function replaySessionHistory(sessionId: string, agent: unknown, ws: WebSocket): void {
  if (!agent || !(agent as Agent).log) return;

  const agentInstance = agent as Agent;
  // Collect tool calls from the most recent assistant message to match
  // tool results by toolCallId.
  let pendingToolCalls: Array<{ id: string; function?: { name?: string; arguments?: string } }> = [];

  for (const msg of agentInstance.log) {
    switch (msg.role) {
      case "user": {
        ws.send(JSON.stringify({
          type: S2C.USER_MESSAGE,
          sessionId,
          content: typeof msg.getTextContent === "function" ? msg.getTextContent() : (msg.content || ""),
        }));
        break;
      }

      case "assistant": {
        // Emit reasoning/thinking content first (if any)
        if (msg.reasoningContent) {
          ws.send(JSON.stringify({
            type: S2C.THINKING,
            sessionId,
            content: msg.reasoningContent,
          }));
        }

        // Emit tool calls next
        const toolCalls = msg.toolCalls as Array<{ id: string; function?: { name?: string; arguments?: string } }> | undefined;
        if (toolCalls && toolCalls.length > 0) {
          pendingToolCalls = toolCalls;
          for (const tc of toolCalls) {
            ws.send(JSON.stringify({
              type: S2C.TOOL_CALL,
              sessionId,
              name: tc.function?.name || "unknown",
              args: tc.function?.arguments || "{}",
            }));
          }
        }
        // Then emit the assistant message text
        const textContent = typeof msg.getTextContent === "function" ? msg.getTextContent() : (msg.content || "");
        if (textContent) {
          ws.send(JSON.stringify({
            type: S2C.ASSISTANT_MESSAGE,
            sessionId,
            content: textContent,
          }));
        }
        break;
      }

      case "tool": {
        const matchedCall = pendingToolCalls.find(
          (tc) => tc.id === msg.toolCallId,
        );
        ws.send(JSON.stringify({
          type: S2C.TOOL_RESULT,
          sessionId,
          name: matchedCall?.function?.name || "unknown",
          output: msg.content || "",
        }));
        break;
      }

      default:
        break;
    }
  }

  // Replay partial streaming content that was emitted before this client
  // connected but hasn't been added to the message log yet (stream still in
  // progress).
  const partialReasoning = agentInstance.currentStreamingReasoning;
  const partialContent = agentInstance.currentStreamingContent;
  if (partialReasoning) {
    ws.send(JSON.stringify({
      type: S2C.STREAMING_REASONING_CHUNK,
      sessionId,
      content: partialReasoning,
    }));
  }
  if (partialContent) {
    ws.send(JSON.stringify({
      type: S2C.STREAMING_CHUNK,
      sessionId,
      content: partialContent,
    }));
  }
}

// ── WS Message Routing ──────────────────────────────────────────────────────

/**
 * Route incoming WS messages to the right session handler.
 */
function routeMessage(ws: WebSocket, msg: C2SMessage, registry: SessionRegistry, authMiddleware: AuthMiddleware | undefined): void {
  const sessionManager = registry.getSessionManager();

  switch (msg.type) {
    case C2S.AUTH: {
      if (authMiddleware && msg.token) {
        const valid = authMiddleware.validateToken(msg.token as string);
        if (valid) {
          (ws as WebSocket & { authToken?: string }).authToken = msg.token as string;
          ws.send(JSON.stringify({ type: "authOk" }));
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
      // Detach from old session first
      const typedWs = ws as WebSocket & { activeSessionId?: string; activeChannel?: WebSocketChannel };
      if (typedWs.activeSessionId && typedWs.activeChannel) {
        registry.removeChannel(typedWs.activeSessionId, typedWs.activeChannel);
      }
      registry.create({
        profile: msg.profile as string | undefined,
        model: msg.model as string | undefined,
        questionStrategy: msg.questionStrategy as string | undefined,
        questionTimeoutSecs: msg.questionTimeoutSecs as number | undefined,
      }).then(({ sessionId, agent }) => {
        // Create WebSocketChannel for this session
        const channel = registry.createChannel(sessionId, ws);
        typedWs.activeSessionId = sessionId;
        typedWs.activeChannel = channel;

        const sessionCreatedMsg = {
          type: "sessionCreated",
          sessionId,
          profile: (agent as Agent)?.profileName || "default",
          currentModel: (agent as Agent)?.model,
          models: Object.keys((agent as Agent)?.modelRegistry || {}),
        };
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
          const typedWs = ws as WebSocket & { activeSessionId?: string; activeChannel?: WebSocketChannel };
          if (typedWs.activeSessionId && typedWs.activeChannel) {
            registry.removeChannel(typedWs.activeSessionId, typedWs.activeChannel);
          }
          // Attach to new session
          const channel = registry.createChannel(msg.sessionId as string, ws);
          typedWs.activeSessionId = msg.sessionId as string;
          typedWs.activeChannel = channel;

          // Send session metadata
          const agent = session.agent as Agent;
          ws.send(JSON.stringify({
            type: S2C.SESSION_STATE,
            sessionId: msg.sessionId,
            key: "model",
            value: agent?.model || session.metadata.model || "?",
          }));
          ws.send(JSON.stringify({
            type: S2C.SESSION_STATE,
            sessionId: msg.sessionId,
            key: "models",
            value: Object.keys(agent?.modelRegistry || {}),
          }));
          ws.send(JSON.stringify({
            type: S2C.SESSION_STATE,
            sessionId: msg.sessionId,
            key: "profile",
            value: agent?.profileName || session.metadata.profile || "default",
          }));
          // Replay session history
          replaySessionHistory(msg.sessionId as string, session.agent, ws);
          // Send current working state
          const isRunning = registry.getSessionManager().isSessionRunning(msg.sessionId as string);
          ws.send(JSON.stringify({
            type: S2C.SESSION_STATE,
            sessionId: msg.sessionId,
            key: "working",
            value: isRunning,
          }));
        }
      }
      break;
    }

    case C2S.SEND: {
      if (msg.sessionId && msg.content) {
        registry.touch(msg.sessionId as string);
        sessionManager.enqueue(msg.sessionId as string, msg.content as string);
      }
      break;
    }

    case C2S.CANCEL: {
      if (msg.sessionId) {
        // Use interrupt() instead of cancel() — interrupt stops the current
        // agent processing but keeps the message bus alive so the user can
        // send new messages afterward. cancel() aborts the bus entirely,
        // making it impossible to trigger another LLM request.
        sessionManager.interrupt(msg.sessionId as string);
      }
      break;
    }

    case C2S.QUESTION_ANSWER: {
      if (msg.sessionId && msg.answers) {
        console.warn("[ws] questionAnswer received — question tool integration pending");
      }
      break;
    }

    case C2S.COMMAND: {
      if (msg.sessionId && msg.command) {
        registry.touch(msg.sessionId as string);
        let cmdText = msg.command as string;
        if (cmdText.startsWith("/")) {
          cmdText = cmdText.slice(1).trim().toLowerCase();
        }
        sessionManager.executeCommand(msg.sessionId as string, cmdText);
      }
      break;
    }

    case C2S.LIST_LOGS: {
      listSessionLogs().then((logs) => {
        // Filter out sessions that are currently active in the registry
        const activeIds = new Set(registry.list().map((s) => s.id));
        const coldLogs = logs.filter((log) => !activeIds.has(log.id));
        ws.send(JSON.stringify({ type: S2C.LOGS_LISTED, logs: coldLogs }));
      }).catch((err: unknown) => {
        ws.send(JSON.stringify({ type: "error", message: (err as Error).message }));
      });
      break;
    }

    case C2S.LOAD_LOG: {
      if (msg.logId) {
        // Detach from old session first
        const typedWs = ws as WebSocket & { activeSessionId?: string; activeChannel?: WebSocketChannel };
        if (typedWs.activeSessionId && typedWs.activeChannel) {
          registry.removeChannel(typedWs.activeSessionId, typedWs.activeChannel);
        }

        loadLogIntoNewSession(msg.logId as string, registry).then(({ sessionId, agent }) => {
          // Create WebSocketChannel for the new session
          const channel = registry.createChannel(sessionId, ws);
          typedWs.activeSessionId = sessionId;
          typedWs.activeChannel = channel;

          const sessionCreatedMsg = {
            type: "sessionCreated",
            sessionId,
            profile: (agent as Agent)?.profileName || "default",
            currentModel: (agent as Agent)?.model,
            models: Object.keys((agent as Agent)?.modelRegistry || {}),
          };
          ws.send(JSON.stringify(sessionCreatedMsg));
          registry.broadcast(sessionCreatedMsg);

          // Replay the session history to the client
          replaySessionHistory(sessionId, agent, ws);
        }).catch((err: unknown) => {
          ws.send(JSON.stringify({ type: "error", message: (err as Error).message }));
        });
      }
      break;
    }

    case C2S.VIEW_LOG: {
      if (msg.logId) {
        readSessionEntries(msg.logId as string).then((entries) => {
          // Send entries for read-only viewing without creating a session
          ws.send(JSON.stringify({ type: S2C.LOG_VIEWED, logId: msg.logId, entries }));
        }).catch((err: unknown) => {
          ws.send(JSON.stringify({ type: "error", message: (err as Error).message }));
        });
      }
      break;
    }

    case C2S.DELETE_LOG: {
      if (msg.logId) {
        deleteSessionLog(msg.logId as string).then((deleted) => {
          if (deleted) {
            ws.send(JSON.stringify({ type: "logDeleted", logId: msg.logId }));
            registry.broadcast({ type: "logDeleted", logId: msg.logId });
          } else {
            ws.send(JSON.stringify({ type: "error", message: `Log ${msg.logId} not found` }));
          }
        }).catch((err: unknown) => {
          ws.send(JSON.stringify({ type: "error", message: (err as Error).message }));
        });
      }
      break;
    }

    default: {
      ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${(msg as Record<string, unknown>).type}` }));
      break;
    }
  }
}

// ── Helper functions ────────────────────────────────────────────────────────

function attachToMostRecentSession(ws: WebSocket, registry: SessionRegistry): void {
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
    createAndAttachSession(ws, registry);
    return;
  }

  const sessionId = mostRecent.id;
  const session = registry.get(sessionId);
  if (!session || !session.agent) {
    createAndAttachSession(ws, registry);
    return;
  }

  // Create WebSocketChannel for the existing session
  const channel = registry.createChannel(sessionId, ws);
  const typedWs = ws as WebSocket & { activeSessionId?: string; activeChannel?: WebSocketChannel };
  typedWs.activeSessionId = sessionId;
  typedWs.activeChannel = channel;

  // Send sessionCreated
  const agent = session.agent as Agent;
  ws.send(JSON.stringify({
    type: "sessionCreated",
    sessionId,
    profile: agent?.profileName || mostRecent.profile || "default",
    currentModel: agent?.model || mostRecent.model || "?",
    models: Object.keys(agent?.modelRegistry || {}),
  }));

  // Replay session history
  replaySessionHistory(sessionId, session.agent, ws);

  // Send current working state so the UI restores the cancel button if agent is running
  const isRunning = registry.getSessionManager().isSessionRunning(sessionId);
  ws.send(JSON.stringify({
    type: S2C.SESSION_STATE,
    sessionId,
    key: "working",
    value: isRunning,
  }));
}

function createAndAttachSession(ws: WebSocket, registry: SessionRegistry): void {
  registry.create({}).then(({ sessionId, agent }) => {
    const channel = registry.createChannel(sessionId, ws);
    const typedWs = ws as WebSocket & { activeSessionId?: string; activeChannel?: WebSocketChannel };
    typedWs.activeSessionId = sessionId;
    typedWs.activeChannel = channel;

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

  // Single LLM client shared across all sessions
  const sharedLlmClient = new LlmClient({
    baseUrl: core.resolved?.baseUrl as string | undefined,
    apiKey: core.resolved?.apiKey as string | undefined,
    stream: core.resolved?.stream !== false,
    chatTimeoutSecs: (core.resolved?.chatTimeout as number) || 30,
    maxRetries: (core.resolved?.maxRetries as number) || 3,
    providers: core.config?.providers as ProviderConfig[] | undefined,
    markerMangler: new MarkerMangler(),
  });

  // Default agent builder — uses shared LlmClient from config (injected by SessionManager)
  const buildAgent = customBuildAgent || (async (agentConfig: { model?: string; sessionId?: string }) => {
    const sessionId = agentConfig.sessionId || crypto.randomUUID();
    const agent = new Agent({
      hooks: core.hooks,
      toolRegistry: core.toolRegistry,
      llmClient: ((agentConfig as Record<string, unknown>).llmClient as LlmClient) || sharedLlmClient,
      model: (agentConfig as { model?: string }).model || (core.resolved?.model as string) || "",
      maxIterations: (core.resolved?.maxIterations as number) || 100,
      contextLimit: 128000,
      hideTools: (agentConfig as { hideTools?: boolean }).hideTools ?? (core.resolved?.hideTools as boolean) ?? false,
      hideThinking: (agentConfig as { hideThinking?: boolean }).hideThinking ?? (core.resolved?.hideThinking as boolean) ?? true,
      showTokenUse: (agentConfig as { showTokenUse?: boolean }).showTokenUse ?? (core.resolved?.showTokenUse as boolean) ?? true,
      sink: null, // Sink is managed by WebSocketChannel
      modelRegistry: core.resolved?.modelRegistry as { [key: string]: { contextLimit?: number; reasoningEffort?: string; [key: string]: unknown } } | undefined,
      profileName: (agentConfig as { profileName?: string }).profileName || (core.resolved?.profileName as string) || "default",
      config: core.config || {},
      sessionId,
      abortSignal: null,
      toolWhitelist: null,
    });

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
    llmClient: sharedLlmClient,
    questionTimeoutSecs,
    questionStrategy,
    sessionTimeoutMin,
  });

  /**
   * WS upgrade handler — called when a WebSocket connection opens.
   */
  function onUpgrade(req: { url: string; headers?: Record<string, string> }, ws: WebSocket): void {
    registry.registerConnection(ws);

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
      ws.send(JSON.stringify({ type: "authRequired" }));
      return;
    }

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
   * Handle WS close — remove channel from session.
   */
  function onClose(ws: WebSocket): void {
    const typedWs = ws as WebSocket & { activeSessionId?: string; activeChannel?: WebSocketChannel };
    if (typedWs.activeSessionId && typedWs.activeChannel) {
      registry.removeChannel(typedWs.activeSessionId, typedWs.activeChannel);
      typedWs.activeChannel.close();
    }
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
