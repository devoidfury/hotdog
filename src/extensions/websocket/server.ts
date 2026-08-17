import crypto from "node:crypto";
import { HOOKS, createHooks } from "../../core/hooks.ts";
import { SessionManager, type AgentLike } from "../../core/session/index.ts";
import type { SwitchProfile } from "../../core/config/profiles.ts";
import { WebSocketChannel } from "./websocket-channel.ts";
import { C2S, S2C, C2SMessage } from "./protocol.ts";
import { LlmClient } from "../../core/llm-client/client.ts";
import { MarkerMangler } from "../../core/marker-mangler.ts";
import type { CoreContext } from "../../core/extensions/types.ts";
import type { AuthMiddleware } from "./auth.ts";
import { Agent } from "../../core/agent.ts";
import type { ProviderDef } from "../../core/config/providers.ts";
import {
  readSessionEntries,
  replayEntriesIntoContext,
  listSessionLogs,
  deleteSessionLog,
} from "../../core/session/session-log.ts";
import { AgentError } from "../../core/error.ts";
import { logger } from "../../core/logger.ts";

interface SessionMetadata {
  profile: string;
  model: string;
  createdAt: number;
  lastActivityAt: number;
  connectedClients: number;
  questionStrategy: string;
  questionTimeoutSecs: number;
  userMessageCount: number;
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
  force?: boolean;
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
  #allConnections = new Set<HotdogServerSocket<unknown>>();
  #metadata: Map<string, SessionMetadata>;
  #channels: Map<string, Set<WebSocketChannel>>;
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

    this.#sessionManager = new SessionManager({
      hooks: createHooks(),
      extensions: null,
      buildAgent: buildAgent as (
        config: Record<string, unknown>,
      ) => Promise<AgentLike>,
      llmClient: llmClient,
    });
  }

  registerConnection(ws: HotdogServerSocket<unknown>): void {
    this.#allConnections.add(ws);
  }

  unregisterConnection(ws: HotdogServerSocket<unknown>): void {
    this.#allConnections.delete(ws);
  }

  broadcast(msg: Record<string, unknown>): void {
    for (const ws of this.#allConnections) {
      SessionRegistry.sendSafe(ws, msg);
    }
  }

  static sendSafe(ws: HotdogServerSocket<unknown>, msg: Record<string, unknown>): void {
    try {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
      }
    } catch {}
  }

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

    const agent = await this.#buildAgent({
      model,
      sessionId: proposedSessionId,
      profileName: profile,
    });
    const actualSessionId = agent.sessionId || proposedSessionId;

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

    this.#sessionManager.registerAgent(agent, {
      profile: profile || "default",
      model,
    });

    return { sessionId: actualSessionId, agent };
  }

  get(
    sessionId: string,
  ): { agent: AgentLike; metadata: SessionMetadata } | null {
    const metadata = this.#metadata.get(sessionId);
    if (!metadata) return null;
    const agent = this.#sessionManager.getAgentBySessionId(sessionId);
    if (!agent) return null;
    return { agent, metadata };
  }

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

  delete(sessionId: string): boolean {
    const meta = this.#metadata.get(sessionId);
    if (!meta) return false;

    const channels = this.#channels.get(sessionId);
    if (channels) {
      for (const ch of channels) {
        ch.close();
      }
      this.#channels.delete(sessionId);
    }

    this.#sessionManager.deleteSession(sessionId);
    this.#metadata.delete(sessionId);
    return true;
  }

  rename(sessionId: string, newName: string): boolean {
    const meta = this.#metadata.get(sessionId);
    if (!meta) return false;
    meta.profile = newName;
    return true;
  }

  listProfiles(): Record<string, SwitchProfile> {
    return { ...this.#profiles };
  }

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

    const profile = this.#profiles[profileName];
    if (!profile) {
      return {
        success: false,
        requiresConfirmation: false,
        error: `Profile "${profileName}" not found`,
      };
    }

    if (!force && meta.userMessageCount >= 1) {
      return { success: false, requiresConfirmation: true };
    }

    const agent = this.#sessionManager.getAgentBySessionId(sessionId);
    if (agent) {
      agent.profileName = profileName;
      agent.toolWhitelist = profile.whitelistTools;
      agent.profileBody = profile.body || undefined;
      agent.role = profile.role || undefined;
      // Wipes messages + system prompt, hence the UI confirmation above.
      await agent.clearContext();
    }
    meta.profile = profileName;
    meta.userMessageCount = 0;
    meta.lastActivityAt = Date.now();

    return { success: true, requiresConfirmation: false };
  }

  incrementUserMessageCount(sessionId: string): void {
    const meta = this.#metadata.get(sessionId);
    if (meta) {
      meta.userMessageCount += 1;
    }
  }

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

    if (!this.#channels.has(sessionId)) {
      this.#channels.set(sessionId, new Set());
    }
    this.#channels.get(sessionId)!.add(channel);

    session.metadata.connectedClients += 1;
    session.metadata.lastActivityAt = Date.now();

    return channel;
  }

  removeChannel(sessionId: string, channel: WebSocketChannel): void {
    channel.detach(sessionId);

    const channels = this.#channels.get(sessionId);
    if (!channels) return;
    channels.delete(channel);

    const meta = this.#metadata.get(sessionId);
    if (meta) {
      meta.connectedClients = Math.max(0, meta.connectedClients - 1);
    }
  }

  // Prevents idle cleanup of the session.
  touch(sessionId: string): void {
    const meta = this.#metadata.get(sessionId);
    if (meta) {
      meta.lastActivityAt = Date.now();
    }
  }

  startCleanupLoop(timeoutMin: number): void {
    this.#timeoutMin = timeoutMin;
    if (this.#cleanupTimer) return;
    this.#cleanupTimer = setInterval(() => {
      this.#cleanupIdleSessions();
    }, 60_000);
  }

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

  get size(): number {
    return this.#metadata.size;
  }

  /** @internal */
  getSessionManager(): SessionManager {
    return this.#sessionManager;
  }

  /** @internal */
  get _test_metadata(): Map<string, SessionMetadata> {
    return this.#metadata;
  }

  /** @internal */
  get _test_timeoutMin(): number {
    return this.#timeoutMin;
  }
  set _test_timeoutMin(v: number) {
    this.#timeoutMin = v;
  }

  /** @internal */
  _test_cleanupIdleSessions(): void {
    this.#cleanupIdleSessions();
  }
}

async function loadLogIntoNewSession(
  logId: string,
  registry: SessionRegistry,
): Promise<{ sessionId: string; agent: AgentLike }> {
  const entries = await readSessionEntries(logId);
  if (entries.length === 0) {
    throw new AgentError(`No entries found for session ${logId}`);
  }

  const newSession = await registry.create({});
  replayEntriesIntoContext(newSession.agent, entries);

  return { sessionId: newSession.sessionId, agent: newSession.agent };
}

// Re-emit a session's history as S2C messages so the frontend can reconstruct the chat.
function replaySessionHistory(
  sessionId: string,
  agent: AgentLike,
  ws: HotdogServerSocket<unknown>,
): void {
  if (!agent.log) return;

  try {
    const agentInstance = agent;
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
          if (msg.reasoningContent) {
            ws.send(
              JSON.stringify({
                type: S2C.THINKING,
                sessionId,
                content: msg.reasoningContent,
              }),
            );
          }

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

    // Flush in-flight chunks that haven't reached the message log yet.
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
    // Connection dropped mid-replay -- nothing to do.
  }
}

async function routeMessage(
  ws: HotdogServerSocket<unknown>,
  msg: C2SMessage,
  registry: SessionRegistry,
  authMiddleware: AuthMiddleware | undefined,
): Promise<void> {
  // Auth gate: when auth is enabled, only the AUTH handshake itself may
  // pass without a validated token. The token is established either at
  // upgrade (URL ?token=) or by a successful AUTH message. This makes the
  // gate hold even for UIs that skip token checks on the HTTP upgrade.
  if (authMiddleware && !ws.authToken && msg.type !== C2S.AUTH) {
    ws.send(JSON.stringify({ type: "authError", message: "Authentication required" }));
    return;
  }

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
          if (ws.activeSessionId && ws.activeChannel) {
            registry.removeChannel(ws.activeSessionId, ws.activeChannel);
          }
          const channel = registry.createChannel(msg.sessionId as string, ws);
          ws.activeSessionId = msg.sessionId as string;
          ws.activeChannel = channel;

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
          replaySessionHistory(msg.sessionId as string, session.agent, ws);
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
        // interrupt() keeps the bus alive for follow-ups; cancel() would abort it.
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
          // Only return cold logs, not sessions that are still live.
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
        if (ws.activeSessionId && ws.activeChannel) {
          registry.removeChannel(ws.activeSessionId, ws.activeChannel);
        }

        loadLogIntoNewSession(msg.logId as string, registry)
          .then(({ sessionId, agent }) => {
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

  const channel = registry.createChannel(sessionId, ws);
  ws.activeSessionId = sessionId;
  ws.activeChannel = channel;

  const agent = session.agent as Agent;
  SessionRegistry.sendSafe(ws, {
    type: "sessionCreated",
    sessionId,
    profile: agent?.profileName || mostRecent.profile || "default",
    currentModel: agent?.model || mostRecent.model || "?",
    models: Object.keys(agent?.modelRegistry || {}),
  });

  replaySessionHistory(sessionId, session.agent, ws);

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
      } catch {}
    });
}

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

  const sharedLlmClient = new LlmClient({
    baseUrl: core.resolved?.baseUrl,
    apiKey: core.resolved?.apiKey,
    stream: core.resolved?.stream !== false,
    chatTimeoutSecs: core.resolved?.chatTimeout || 30,
    maxRetries: core.resolved?.maxRetries as number,
    providers: core.config?.providers as ProviderDef[] | undefined,
    markerMangler: new MarkerMangler(),
  });

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
        sink: null,
        modelRegistry: core.resolved?.modelRegistry,
        profileName,
        profileBody: profile?.body || undefined,
        role: profile?.role || undefined,
        config: {
          ...core.config,
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
      // Socket stays open so the client can still authenticate via a
      // protocol AUTH message; routeMessage() gates everything else.
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
      } catch {}
      return;
    }

    if (!msg.type) {
      try {
        ws.send(
          JSON.stringify({ type: "error", message: "Message type required" }),
        );
      } catch {}
      return;
    }

    try {
      await routeMessage(ws, msg, registry, auth);
    } catch (err: unknown) {
      // Don't let errors from dropped connections kill the server.
      const typedErr = err as Error;
      if (
        typedErr.message !== "WebSocket is not open: readyState 2 (CLOSING)" &&
        typedErr.message !== "WebSocket is not open: readyState 3 (CLOSED)"
      ) {
        console.error(`[websocket] message handling error:`, typedErr);
      }
    }
  }

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
