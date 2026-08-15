// WebSocket server — session management and WS message routing.
// Provides createWsServer() factory and SessionRegistry class.

import crypto from "node:crypto";
import { HOOKS, createHooks } from "../../core/hooks.ts";
import { SessionManager, type AgentLike } from "../../core/session/index.ts";
import type { SwitchProfile } from "../../core/config/profiles.ts";
import { WebSocketChannel } from "./websocket-channel.ts";
import { C2S, S2C, C2SMessage } from "./protocol.ts";
import {
  LlmClient,
  type ProviderConfig,
} from "../../core/llm-client/client.ts";
import { MarkerMangler } from "../../core/marker-mangler.ts";
import type { CoreContext } from "../../core/extensions/types.ts";
import type { AuthMiddleware } from "./auth.ts";
import { Agent } from "../../core/agent.ts";
import type { ModelConfig } from "../../core/config/providers.ts";
import {
  readSessionEntries,
  replayEntriesIntoContext,
  listSessionLogs,
  deleteSessionLog,
} from "../../core/session/session-log.ts";
import { AgentError } from "../../core/error.ts";
import { logger } from "../../core/logger.ts";

// ── Types ───────────────────────────────────────────────────────────────────

interface SessionMetadata {
  profile: string;
  model: string;
  createdAt: number;
  lastActivityAt: number;
  connectedClients: number;
  questionStrategy: string;
  questionTimeoutSecs: number;
  userMessageCount: number; // Track user input messages for confirmation dialog
}

interface CreateSessionOptions {
  profile?: string;
  model?: string;
  questionStrategy?: string;
  questionTimeoutSecs?: number;
}

interface SwitchProfileOptions {
  sessionId: string;
  profileName: string;
  force?: boolean; // Skip confirmation check
}

interface SessionRegistryOptions {
  buildAgent: (config: {
    model?: string;
    sessionId?: string;
    profileName?: string;
  }) => Promise<AgentLike>;
  llmClient?: LlmClient;
  questionTimeoutSecs?: number;
  questionStrategy?: string;
  sessionTimeoutMin?: number;
  profiles?: Record<string, SwitchProfile>;
}

interface CreateWsServerOptions {
  buildAgent?: (config: {
    model?: string;
    sessionId?: string;
    profileName?: string;
  }) => Promise<AgentLike>;
  sessionTimeoutMin?: number;
  questionTimeoutSecs?: number;
  questionStrategy?: string;
  auth?: AuthMiddleware;
  profiles?: Record<string, SwitchProfile>;
}

export interface WsServer {
  sessionRegistry: SessionRegistry;
  onUpgrade: (
    req: { url: string; headers?: Record<string, string> },
    ws: HotdogServerSocket<unknown>,
  ) => void;
  onMessage: (ws: HotdogServerSocket<unknown>, raw: string | Buffer) => void;
  onClose: (ws: HotdogServerSocket<unknown>) => void;
  startCleanupLoop: () => void;
  stopCleanupLoop: () => void;
}

export type HotdogServerSocket<T = undefined> = Bun.ServerWebSocket<T> & {
  activeSessionId?: string;
  activeChannel?: WebSocketChannel;
  authToken?: string;
};

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
  #buildAgent: (config: {
    model?: string;
    sessionId?: string;
    profileName?: string;
  }) => Promise<AgentLike>;
  #questionTimeoutSecs: number;
  #questionStrategy: string;
  #cleanupTimer: ReturnType<typeof setInterval> | null = null;
  #timeoutMin: number;
  // All active WebSocket connections — used for broadcasting events to all clients.
  #allConnections = new Set<HotdogServerSocket<unknown>>();
  // Per-session metadata
  #metadata: Map<string, SessionMetadata>;
  // Per-session WebSocketChannel instances
  #channels: Map<string, Set<WebSocketChannel>>;
  // Available profiles
  #profiles: Record<string, SwitchProfile>;

  constructor({
    buildAgent,
    llmClient,
    questionTimeoutSecs = 300,
    questionStrategy = "wait",
    sessionTimeoutMin = 30,
    profiles = {},
  }: SessionRegistryOptions) {
    this.#buildAgent = buildAgent;
    this.#questionTimeoutSecs = questionTimeoutSecs;
    this.#questionStrategy = questionStrategy;
    this.#timeoutMin = sessionTimeoutMin;
    this.#metadata = new Map();
    this.#channels = new Map();
    this.#profiles = profiles;

    // Create SessionManager — passes llmClient through buildAgent config
    this.#sessionManager = new SessionManager({
      hooks: createHooks(), // No-op hooks for now
      extensions: null,
      buildAgent: buildAgent as (
        config: Record<string, unknown>,
      ) => Promise<AgentLike>,
      llmClient: llmClient,
    });
  }

  /**
   * Register a WebSocket connection for broadcast purposes.
   */
  registerConnection(ws: HotdogServerSocket<unknown>): void {
    this.#allConnections.add(ws);
  }

  /**
   * Unregister a WebSocket connection.
   */
  unregisterConnection(ws: HotdogServerSocket<unknown>): void {
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
        if (ws.readyState === 1) {
          // WebSocket.OPEN
          ws.send(payload);
        }
      } catch {
        // Connection error — connection will be cleaned up on close
      }
    }
  }

  /**
   * Safely send a message to a WebSocket, ignoring errors if closed.
   */
  static sendSafe(ws: HotdogServerSocket<unknown>, msg: Record<string, unknown>): void {
    try {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
      }
    } catch {
      // Connection closed or erroring — ignore
    }
  }

  /**
   * Create a new session with its own agent.
   * The SessionManager creates the internal MessageBus automatically.
   */
  async create({
    profile,
    model,
    questionStrategy,
    questionTimeoutSecs,
  }: CreateSessionOptions = {}): Promise<{
    sessionId: string;
    agent: AgentLike;
  }> {
    const proposedSessionId = crypto.randomUUID();

    // Build the agent — pass proposed sessionId but use the agent's actual sessionId
    const agent = await this.#buildAgent({
      model,
      sessionId: proposedSessionId,
      profileName: profile,
    });
    const actualSessionId = agent.sessionId || proposedSessionId;

    // Store metadata under the agent's actual sessionId
    this.#metadata.set(actualSessionId, {
      profile: profile || "default",
      model: agent.model || "",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      connectedClients: 0,
      questionStrategy: questionStrategy || this.#questionStrategy,
      questionTimeoutSecs: questionTimeoutSecs || this.#questionTimeoutSecs,
      userMessageCount: 0,
    });

    // Register with SessionManager — this creates the MessageBus and wires the sink
    this.#sessionManager.registerAgent(agent, {
      profile: profile || "default",
      model,
    });

    return { sessionId: actualSessionId, agent };
  }

  /**
   * Get a session by ID.
   */
  get(
    sessionId: string,
  ): { agent: AgentLike; metadata: SessionMetadata } | null {
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
  list(): Array<{
    id: string;
    profile: string;
    model: string;
    createdAt: number;
    lastActivityAt: number;
    connectedClients: number;
    userMessageCount: number;
  }> {
    const result: Array<{
      id: string;
      profile: string;
      model: string;
      createdAt: number;
      lastActivityAt: number;
      connectedClients: number;
      userMessageCount: number;
    }> = [];
    for (const [id, meta] of this.#metadata) {
      const agent = this.#sessionManager.getAgentBySessionId(id);
      result.push({
        id,
        profile: meta.profile,
        model: agent?.model || meta.model,
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        connectedClients: meta.connectedClients,
        userMessageCount: meta.userMessageCount,
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
   * List available profiles.
   */
  listProfiles(): Record<string, SwitchProfile> {
    return { ...this.#profiles };
  }

  /**
   * Switch profile for a session.
   * Returns requiresConfirmation: true if session has user messages and force is not set.
   */
  async switchProfile({
    sessionId,
    profileName,
    force = false,
  }: SwitchProfileOptions): Promise<{
    success: boolean;
    requiresConfirmation: boolean;
    error?: string;
  }> {
    const meta = this.#metadata.get(sessionId);
    if (!meta) {
      return {
        success: false,
        requiresConfirmation: false,
        error: "Session not found",
      };
    }

    // Check if profile exists
    const profile = this.#profiles[profileName];
    if (!profile) {
      return {
        success: false,
        requiresConfirmation: false,
        error: `Profile "${profileName}" not found`,
      };
    }

    // Check if confirmation is needed
    if (!force && meta.userMessageCount >= 1) {
      return { success: false, requiresConfirmation: true };
    }

    // Perform the switch
    const agent = this.#sessionManager.getAgentBySessionId(sessionId);
    if (agent) {
      agent.profileName = profileName;
      // Update tool whitelist from new profile
      agent.toolWhitelist = profile.whitelistTools;
      // Update profile body and role for system prompt
      agent.profileBody = profile.body || undefined;
      agent.role = profile.role || undefined;
      // Clear context (messages + system prompt) -- UI confirms this will happen
      await agent.clearContext();
    }
    meta.profile = profileName;
    meta.userMessageCount = 0;
    meta.lastActivityAt = Date.now();

    return { success: true, requiresConfirmation: false };
  }

  /**
   * Increment user message count for a session.
   */
  incrementUserMessageCount(sessionId: string): void {
    const meta = this.#metadata.get(sessionId);
    if (meta) {
      meta.userMessageCount += 1;
    }
  }

  /**
   * Create a WebSocketChannel for a session and attach it.
   */
  createChannel(
    sessionId: string,
    ws: HotdogServerSocket<unknown>,
  ): WebSocketChannel | undefined {
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
      if (
        now - meta.lastActivityAt > timeoutMs &&
        meta.connectedClients === 0
      ) {
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
  get _test_metadata(): Map<string, SessionMetadata> {
    return this.#metadata;
  }

  /** @internal Exposed for testing. */
  get _test_timeoutMin(): number {
    return this.#timeoutMin;
  }
  set _test_timeoutMin(v: number) {
    this.#timeoutMin = v;
  }

  /** @internal Exposed for testing. */
  _test_cleanupIdleSessions(): void {
    this.#cleanupIdleSessions();
  }
}

// ── Cold Session Log Helpers ────────────────────────────────────────────────

/**
 * Load a session log into a new session.
 * Creates a new session and replays the log entries into its context.
 */
async function loadLogIntoNewSession(
  logId: string,
  registry: SessionRegistry,
): Promise<{ sessionId: string; agent: AgentLike }> {
  const entries = await readSessionEntries(logId);
  if (entries.length === 0) {
    throw new AgentError(`No entries found for session ${logId}`);
  }

  // Create a new session
  const newSession = await registry.create({});

  // Replay the log entries into the new agent's context
  replayEntriesIntoContext(newSession.agent, entries);

  return { sessionId: newSession.sessionId, agent: newSession.agent };
}

// ── Session History Replay ──────────────────────────────────────────────────

/**
 * Replay a session's message history to a WebSocket client.
 * Iterates through the agent's context and emits the appropriate
 * OUTPUT_EVENT-derived messages so the frontend can reconstruct the chat.
 */
function replaySessionHistory(
  sessionId: string,
  agent: AgentLike,
  ws: HotdogServerSocket<unknown>,
): void {
  if (!agent.log) return;

  try {
    const agentInstance = agent;
    // Collect tool calls from the most recent assistant message to match
    // tool results by toolCallId.
    let pendingToolCalls: Array<{
      id: string;
      function?: { name?: string; arguments?: string };
    }> = [];

    for (const msg of agentInstance.log) {
      switch (msg.role) {
        case "user": {
          ws.send(
            JSON.stringify({
              type: S2C.USER_MESSAGE,
              sessionId,
              content:
                typeof msg.getTextContent === "function"
                  ? msg.getTextContent()
                  : msg.content || "",
            }),
          );
          break;
        }

        case "assistant": {
          // Emit reasoning/thinking content first (if any)
          if (msg.reasoningContent) {
            ws.send(
              JSON.stringify({
                type: S2C.THINKING,
                sessionId,
                content: msg.reasoningContent,
              }),
            );
          }

          // Emit tool calls next
          const toolCalls = msg.toolCalls as
            | Array<{
                id: string;
                function?: { name?: string; arguments?: string };
              }>
            | undefined;
          if (toolCalls && toolCalls.length > 0) {
            pendingToolCalls = toolCalls;
            for (const tc of toolCalls) {
              ws.send(
                JSON.stringify({
                  type: S2C.TOOL_CALL,
                  sessionId,
                  name: tc.function?.name || "unknown",
                  args: tc.function?.arguments || "{}",
                }),
              );
            }
          }
          // Then emit the assistant message text
          const textContent =
            typeof msg.getTextContent === "function"
              ? msg.getTextContent()
              : msg.content || "";
          if (textContent) {
            ws.send(
              JSON.stringify({
                type: S2C.ASSISTANT_MESSAGE,
                sessionId,
                content: textContent,
              }),
            );
          }
          break;
        }

        case "tool": {
          const matchedCall = pendingToolCalls.find(
            (tc) => tc.id === msg.toolCallId,
          );
          ws.send(
            JSON.stringify({
              type: S2C.TOOL_RESULT,
              sessionId,
              name: matchedCall?.function?.name || "unknown",
              output: msg.content || "",
            }),
          );
          break;
        }

        default:
          break;
      }
    }

    // Replay partial streaming content that was emitted before this client
    // connected but hasn't been added to the message log yet (stream still in
    // progress).
    const agentImpl = agent as Agent;
    const partialReasoning = agentImpl.currentStreamingReasoning;
    const partialContent = agentImpl.currentStreamingContent;
    if (partialReasoning) {
      ws.send(
        JSON.stringify({
          type: S2C.STREAMING_REASONING_CHUNK,
          sessionId,
          content: partialReasoning,
        }),
      );
    }
    if (partialContent) {
      ws.send(
        JSON.stringify({
          type: S2C.STREAMING_CHUNK,
          sessionId,
          content: partialContent,
        }),
      );
    }
  } catch {
    // Connection dropped during replay — ignore
  }
}

// ── WS Message Routing ──────────────────────────────────────────────────────

/**
 * Route incoming WS messages to the right session handler.
 */
async function routeMessage(
  ws: HotdogServerSocket<unknown>,
  msg: C2SMessage,
  registry: SessionRegistry,
  authMiddleware: AuthMiddleware | undefined,
): Promise<void> {
  const sessionManager = registry.getSessionManager();

  switch (msg.type) {
    case C2S.AUTH: {
      if (authMiddleware && msg.token) {
        const valid = authMiddleware.validateToken(msg.token as string);
        if (valid) {
          ws.authToken = msg.token as string;
          ws.send(JSON.stringify({ type: "authOk" }));
          if (!ws.activeSessionId) {
            if (registry.size > 0) {
              attachToMostRecentSession(ws, registry);
            } else {
              createAndAttachSession(ws, registry);
            }
          }
        } else {
          ws.send(
            JSON.stringify({ type: "authError", message: "Invalid token" }),
          );
        }
      }
      break;
    }

    case C2S.CREATE_SESSION: {
      // Detach from old session first
      if (ws.activeSessionId && ws.activeChannel) {
        registry.removeChannel(ws.activeSessionId, ws.activeChannel);
      }
      registry
        .create({
          profile: msg.profile as string | undefined,
          model: msg.model as string | undefined,
          questionStrategy: msg.questionStrategy as string | undefined,
          questionTimeoutSecs: msg.questionTimeoutSecs as number | undefined,
        })
        .then(({ sessionId, agent }) => {
          // Create WebSocketChannel for this session
          const channel = registry.createChannel(sessionId, ws);
          ws.activeSessionId = sessionId;
          ws.activeChannel = channel;

          const sessionCreatedMsg = {
            type: "sessionCreated",
            sessionId,
            profile: agent.profileName || "default",
            currentModel: agent.model,
            models: Object.keys(agent.modelRegistry || {}),
          };
          SessionRegistry.sendSafe(ws, sessionCreatedMsg);
          registry.broadcast(sessionCreatedMsg);
        })
        .catch((err: unknown) => {
          SessionRegistry.sendSafe(ws, {
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        });
      break;
    }

    case C2S.DELETE_SESSION: {
      if (msg.sessionId) {
        registry.delete(msg.sessionId as string);
        const sessionDeletedMsg = {
          type: "sessionDeleted",
          sessionId: msg.sessionId,
        };
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

    case C2S.LIST_PROFILES: {
      const profiles = registry.listProfiles();
      ws.send(JSON.stringify({ type: S2C.PROFILES, profiles }));
      break;
    }

    case C2S.SWITCH_PROFILE: {
      if (msg.sessionId && msg.profileName) {
        const result = await registry.switchProfile({
          sessionId: msg.sessionId as string,
          profileName: msg.profileName as string,
          force: msg.force as boolean | undefined,
        });
        if (result.success) {
          ws.send(
            JSON.stringify({
              type: S2C.PROFILE_SWITCHED,
              sessionId: msg.sessionId,
              profile: msg.profileName,
              success: true,
            }),
          );
        } else if (result.requiresConfirmation) {
          ws.send(
            JSON.stringify({
              type: S2C.PROFILE_SWITCHED,
              sessionId: msg.sessionId,
              requiresConfirmation: true,
            }),
          );
        } else {
          ws.send(
            JSON.stringify({
              type: "error",
              message: result.error || "Profile switch failed",
            }),
          );
        }
      }
      break;
    }

    case C2S.SWITCH_SESSION: {
      if (msg.sessionId) {
        const session = registry.get(msg.sessionId as string);
        if (session) {
          // Detach from old session
          if (ws.activeSessionId && ws.activeChannel) {
            registry.removeChannel(ws.activeSessionId, ws.activeChannel);
          }
          // Attach to new session
          const channel = registry.createChannel(msg.sessionId as string, ws);
          ws.activeSessionId = msg.sessionId as string;
          ws.activeChannel = channel;

          // Send session metadata
          const agent = session.agent as Agent;
          ws.send(
            JSON.stringify({
              type: S2C.SESSION_STATE,
              sessionId: msg.sessionId,
              key: "model",
              value: agent?.model || session.metadata.model || "?",
            }),
          );
          ws.send(
            JSON.stringify({
              type: S2C.SESSION_STATE,
              sessionId: msg.sessionId,
              key: "models",
              value: Object.keys(agent?.modelRegistry || {}),
            }),
          );
          ws.send(
            JSON.stringify({
              type: S2C.SESSION_STATE,
              sessionId: msg.sessionId,
              key: "profile",
              value:
                agent?.profileName || session.metadata.profile || "default",
            }),
          );
          // Replay session history
          replaySessionHistory(msg.sessionId as string, session.agent, ws);
          // Send current working state
          const isRunning = registry
            .getSessionManager()
            .isSessionRunning(msg.sessionId as string);
          ws.send(
            JSON.stringify({
              type: S2C.SESSION_STATE,
              sessionId: msg.sessionId,
              key: "working",
              value: isRunning,
            }),
          );
        }
      }
      break;
    }

    case C2S.SEND: {
      if (msg.sessionId && msg.content) {
        registry.touch(msg.sessionId as string);
        registry.incrementUserMessageCount(msg.sessionId as string);
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
        logger.warn(
          "questionAnswer received — question tool integration pending",
        );
      }
      break;
    }

    case C2S.COMMAND: {
      if (msg.sessionId && msg.command) {
        registry.touch(msg.sessionId as string);
        let cmdText = msg.command as string;
        if (cmdText.startsWith("/")) {
          cmdText = cmdText.slice(1).trim();
        }
        sessionManager.executeCommand(msg.sessionId as string, cmdText);
      }
      break;
    }

    case C2S.LIST_LOGS: {
      listSessionLogs()
        .then((logs) => {
          // Filter out sessions that are currently active in the registry
          const activeIds = new Set(registry.list().map((s) => s.id));
          const coldLogs = logs.filter((log) => !activeIds.has(log.id));
          SessionRegistry.sendSafe(ws, {
            type: S2C.LOGS_LISTED,
            logs: coldLogs,
          });
        })
        .catch((err: unknown) => {
          SessionRegistry.sendSafe(ws, {
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        });
      break;
    }

    case C2S.LOAD_LOG: {
      if (msg.logId) {
        // Detach from old session first
        if (ws.activeSessionId && ws.activeChannel) {
          registry.removeChannel(ws.activeSessionId, ws.activeChannel);
        }

        loadLogIntoNewSession(msg.logId as string, registry)
          .then(({ sessionId, agent }) => {
            // Create WebSocketChannel for the new session
            const channel = registry.createChannel(sessionId, ws);
            ws.activeSessionId = sessionId;
            ws.activeChannel = channel;

            const sessionCreatedMsg = {
              type: "sessionCreated",
              sessionId,
              profile: agent.profileName || "default",
              currentModel: agent.model,
              models: Object.keys(agent.modelRegistry || {}),
            };
            SessionRegistry.sendSafe(ws, sessionCreatedMsg);
            registry.broadcast(sessionCreatedMsg);

            // Replay the session history to the client
            replaySessionHistory(sessionId, agent, ws);
          })
          .catch((err: unknown) => {
            SessionRegistry.sendSafe(ws, {
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            });
          });
      }
      break;
    }

    case C2S.VIEW_LOG: {
      if (msg.logId) {
        readSessionEntries(msg.logId as string)
          .then((entries) => {
            // Send entries for read-only viewing without creating a session
            SessionRegistry.sendSafe(ws, {
              type: S2C.LOG_VIEWED,
              logId: msg.logId,
              entries,
            });
          })
          .catch((err: unknown) => {
            SessionRegistry.sendSafe(ws, {
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            });
          });
      }
      break;
    }

    case C2S.DELETE_LOG: {
      if (msg.logId) {
        deleteSessionLog(msg.logId as string)
          .then((deleted) => {
            if (deleted) {
              SessionRegistry.sendSafe(ws, {
                type: "logDeleted",
                logId: msg.logId,
              });
              registry.broadcast({ type: "logDeleted", logId: msg.logId });
            } else {
              SessionRegistry.sendSafe(ws, {
                type: "error",
                message: `Log ${msg.logId} not found`,
              });
            }
          })
          .catch((err: unknown) => {
            SessionRegistry.sendSafe(ws, {
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            });
          });
      }
      break;
    }

    default: {
      ws.send(
        JSON.stringify({
          type: "error",
          message: `Unknown message type: ${(msg as Record<string, unknown>).type}`,
        }),
      );
      break;
    }
  }
}

// ── Helper functions ────────────────────────────────────────────────────────

function attachToMostRecentSession(
  ws: HotdogServerSocket<unknown>,
  registry: SessionRegistry,
): void {
  const sessions = registry.list();
  let mostRecent: {
    id: string;
    lastActivityAt: number;
    profile: string;
    model: string;
  } | null = null;
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
  ws.activeSessionId = sessionId;
  ws.activeChannel = channel;

  // Send sessionCreated
  const agent = session.agent as Agent;
  SessionRegistry.sendSafe(ws, {
    type: "sessionCreated",
    sessionId,
    profile: agent?.profileName || mostRecent.profile || "default",
    currentModel: agent?.model || mostRecent.model || "?",
    models: Object.keys(agent?.modelRegistry || {}),
  });

  // Replay session history
  replaySessionHistory(sessionId, session.agent, ws);

  // Send current working state so the UI restores the cancel button if agent is running
  const isRunning = registry.getSessionManager().isSessionRunning(sessionId);
  SessionRegistry.sendSafe(ws, {
    type: S2C.SESSION_STATE,
    sessionId,
    key: "working",
    value: isRunning,
  });
}

function createAndAttachSession(
  ws: HotdogServerSocket<unknown>,
  registry: SessionRegistry,
): void {
  registry
    .create({})
    .then(({ sessionId, agent }) => {
      const channel = registry.createChannel(sessionId, ws);
      ws.activeSessionId = sessionId;
      ws.activeChannel = channel;

      SessionRegistry.sendSafe(ws, {
        type: "sessionCreated",
        sessionId,
        profile: agent.profileName || "default",
        currentModel: agent.model,
        models: Object.keys(agent.modelRegistry || {}),
      });
    })
    .catch((err: unknown) => {
      SessionRegistry.sendSafe(ws, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      try {
        ws.close(4003, "Failed to create session");
      } catch {
        // Already closed
      }
    });
}

// ── createWsServer Factory ───────────────────────────────────────────────────

/**
 * Create a WebSocket server handler object.
 * Provides the onUpgrade handler for Bun.serve() and session registry.
 */
export function createWsServer(
  core: CoreContext,
  options: CreateWsServerOptions = {},
): WsServer {
  const {
    buildAgent: customBuildAgent,
    sessionTimeoutMin = 30,
    questionTimeoutSecs = 300,
    questionStrategy = "wait",
    auth,
    profiles,
  } = options;

  // Single LLM client shared across all sessions
  const sharedLlmClient = new LlmClient({
    baseUrl: core.resolved?.baseUrl,
    apiKey: core.resolved?.apiKey,
    stream: core.resolved?.stream !== false,
    chatTimeoutSecs: core.resolved?.chatTimeout || 30,
    // Resolved by buildConfig in the real app; retry.ts throws
    // ConfigError.MissingConfig if it is missing at retry time.
    maxRetries: core.resolved?.maxRetries as number,
    providers: core.config?.providers as ProviderConfig[] | undefined,
    markerMangler: new MarkerMangler(),
  });

  // Default agent builder — uses shared LlmClient from config (injected by SessionManager)
  const buildAgent: (config: {
    model?: string;
    sessionId?: string;
    profileName?: string;
  }) => Promise<AgentLike> =
    customBuildAgent ??
    (async (agentConfig) => {
      const sessionId = agentConfig.sessionId || crypto.randomUUID();
      const profileName =
        agentConfig.profileName ||
        (core.resolved?.profileName as string) ||
        "default";
      // Read profile config for tool restrictions, role, and body
      const profile = profiles?.[profileName] || null;
      const agent = new Agent({
        hooks: core.hooks,
        toolRegistry: core.toolRegistry,
        llmClient:
          ((agentConfig as Record<string, unknown>).llmClient as LlmClient) ||
          sharedLlmClient,
        model:
          (agentConfig as { model?: string }).model ||
          (core.resolved?.model as string) ||
          "",
        maxIterations: (core.resolved?.maxIterations as number) || 100,
        contextLimit: 128000,
        hideTools:
          (agentConfig as { hideTools?: boolean }).hideTools ??
          (core.resolved?.hideTools as boolean) ??
          false,
        hideThinking:
          (agentConfig as { hideThinking?: boolean }).hideThinking ??
          (core.resolved?.hideThinking as boolean) ??
          true,
        showTokenUse:
          (agentConfig as { showTokenUse?: boolean }).showTokenUse ??
          (core.resolved?.showTokenUse as boolean) ??
          true,
        sink: null, // Sink is managed by WebSocketChannel
        modelRegistry: core.resolved?.modelRegistry,
        profileName,
        profileBody: profile?.body || undefined,
        role: profile?.role || undefined,
        config: {
          ...core.config,
          // Agent requires these resolved values — no fallbacks in the Agent.
          maxToolCallsPerIteration: core.resolved?.maxToolCallsPerIteration as number,
          maxRetries: core.resolved?.maxRetries as number,
          toolRetryDelay: core.resolved?.toolRetryDelay as number,
        },
        sessionId,
        abortSignal: null,
        toolWhitelist: profile?.whitelistTools || null,
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
    profiles,
  });

  /**
   * WS upgrade handler — called when a WebSocket connection opens.
   */
  function onUpgrade(
    req: { url: string; headers?: Record<string, string> },
    ws: HotdogServerSocket<unknown>,
  ): void {
    registry.registerConnection(ws);

    const url = new URL(req.url, `http://${req.headers?.host || "localhost"}`);
    const token = url.searchParams.get("token");

    if (auth && token) {
      if (!auth.validateToken(token)) {
        ws.send(
          JSON.stringify({
            type: "authError",
            message: "Invalid or expired token",
          }),
        );
        ws.close(4001, "Invalid token");
        return;
      }
      ws.authToken = token;
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
  async function onMessage(
    ws: HotdogServerSocket<unknown>,
    raw: string | Buffer,
  ): Promise<void> {
    let msg: C2SMessage;
    try {
      msg = JSON.parse(
        typeof raw === "string" ? raw : raw.toString(),
      ) as C2SMessage;
    } catch {
      try {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      } catch {
        // Connection already closed
      }
      return;
    }

    if (!msg.type) {
      try {
        ws.send(
          JSON.stringify({ type: "error", message: "Message type required" }),
        );
      } catch {
        // Connection already closed
      }
      return;
    }

    try {
      await routeMessage(ws, msg, registry, auth);
    } catch (err: unknown) {
      // Log but don't crash — connection may have dropped mid-processing
      const typedErr = err as Error;
      if (
        typedErr.message !== "WebSocket is not open: readyState 2 (CLOSING)" &&
        typedErr.message !== "WebSocket is not open: readyState 3 (CLOSED)"
      ) {
        console.error(`[websocket] message handling error:`, typedErr);
      }
    }
  }

  /**
   * Handle WS close — remove channel from session.
   */
  function onClose(ws: HotdogServerSocket<unknown>): void {
    if (ws.activeSessionId && ws.activeChannel) {
      registry.removeChannel(ws.activeSessionId, ws.activeChannel);
      ws.activeChannel.close();
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
