// WebSocket server — session management and WS message routing.
// Provides createWsServer() factory and SessionRegistry class.

import crypto from "node:crypto";
import { OUTPUT_EVENT } from "../../core/context/output.js";
import { HOOKS } from "../../core/hooks.js";
import { MessageBus } from "../../core/session/message-bus.js";
import { FanoutSink, WebSocketOutputSink, BackgroundSink } from "./sinks.js";
import { C2S, S2C } from "./protocol.js";
import { logger } from "../../core/logger.js";

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
  #sessions = new Map(); // sessionId → Session
  #buildAgent;           // async ({ model, sessionId }) => Agent
  #questionTimeoutSecs;  // default question timeout
  #questionStrategy;     // default question strategy ("wait", "default", "cancel")
  #cleanupTimer = null;
  #timeoutMin;

  /**
   * @param {Object} options
   * @param {Function} options.buildAgent - Async function({ model, sessionId }) => Agent
   * @param {Object} options.hooks - HookSystem instance (shared)
   * @param {number} [options.questionTimeoutSecs=300]
   * @param {string} [options.questionStrategy="wait"]
   * @param {number} [options.sessionTimeoutMin=30] - Idle session cleanup timeout
   */
  constructor({ buildAgent, questionTimeoutSecs = 300, questionStrategy = "wait", sessionTimeoutMin = 30 }) {
    this.#buildAgent = buildAgent;
    this.#questionTimeoutSecs = questionTimeoutSecs;
    this.#questionStrategy = questionStrategy;
    this.#timeoutMin = sessionTimeoutMin;
  }

  /**
   * Create a new session with its own agent and message bus.
   * The bus run loop starts immediately.
   *
   * @param {Object} options
   * @param {string} [options.profile]
   * @param {string} [options.model]
   * @param {string} [options.questionStrategy] - Per-session override
   * @param {number} [options.questionTimeoutSecs] - Per-session override
   * @returns {Promise<{ sessionId: string, agent: Object, bus: MessageBus }>}
   */
  async create({ profile, model, questionStrategy, questionTimeoutSecs } = {}) {
    const sessionId = crypto.randomUUID();

    // Build the agent
    const agent = await this.#buildAgent({ model, sessionId });

    // Create a minimal session-manager-like wrapper so the bus can access the agent
    const sessionManager = {
      getAgent: () => agent,
      sessionId: () => agent.sessionId,
    };

    // Build fanout sink with background sink
    const fanout = new FanoutSink();
    const bgSink = new BackgroundSink();
    fanout.add(bgSink);

    // Create the message bus
    const bus = new MessageBus({
      sessionManager,
      sink: fanout,
    });

    // Wire agent's sink to the fanout so agent emits events to fanout
    agent.setSink(fanout);

    // Start the bus run loop (non-blocking — it awaits messages as they arrive)
    const runLoop = bus.run().catch(err => {
      logger.error(`[session ${sessionId}] bus error:`, err);
    });

    const session = {
      id: sessionId,
      agent,
      bus,
      busRunLoop: runLoop,
      fanoutSink: fanout,
      bgSink,
      metadata: {
        profile: profile || "default",
        model: agent.model,
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
  get(sessionId) {
    return this.#sessions.get(sessionId) || null;
  }

  /**
   * List all sessions with metadata.
   */
  list() {
    const result = [];
    for (const [id, s] of this.#sessions) {
      result.push({
        id,
        profile: s.metadata.profile,
        model: s.agent?.model || s.metadata.model,
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
  delete(sessionId) {
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
   * Attach a WebSocket output sink to a session.
   * @param {string} sessionId
   * @param {WebSocket} ws
   * @returns {WebSocketOutputSink|null}
   */
  attachSink(sessionId, ws) {
    const s = this.#sessions.get(sessionId);
    if (!s) return null;

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
  detachSink(sessionId, wsSink) {
    const s = this.#sessions.get(sessionId);
    if (!s) return;
    s.fanoutSink.remove(wsSink);
    s.metadata.connectedClients = Math.max(0, s.metadata.connectedClients - 1);
  }

  /**
   * Touch session (update lastActivityAt) to prevent idle cleanup.
   */
  touch(sessionId) {
    const s = this.#sessions.get(sessionId);
    if (s) {
      s.metadata.lastActivityAt = Date.now();
    }
  }

  /**
   * Start idle session cleanup loop.
   * @param {number} timeoutMin - Idle timeout in minutes
   */
  startCleanupLoop(timeoutMin) {
    this.#timeoutMin = timeoutMin;
    if (this.#cleanupTimer) return;
    this.#cleanupTimer = setInterval(() => {
      this.#cleanupIdleSessions();
    }, 60_000);
  }

  /**
   * Stop idle session cleanup loop.
   */
  stopCleanupLoop() {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
  }

  #cleanupIdleSessions() {
    const now = Date.now();
    const timeoutMs = this.#timeoutMin * 60 * 1000;
    for (const [id, s] of this.#sessions) {
      if (now - s.metadata.lastActivityAt > timeoutMs && s.metadata.connectedClients === 0) {
        this.delete(id);
      }
    }
  }

  /** Number of active sessions. */
  get size() {
    return this.#sessions.size;
  }
}

// ── Session History Replay ──────────────────────────────────────────────────

/**
 * Replay a session's message history to a WebSocket client.
 * Iterates through the agent's context and emits the appropriate
 * OUTPUT_EVENT-derived messages so the frontend can reconstruct the chat.
 *
 * @param {Object} session - Session from the registry
 * @param {WebSocket} ws - Bun WebSocket instance to send to
 */
function replaySessionHistory(session, ws) {
  const agent = session.agent;
  if (!agent || !agent.log) return;

  // Collect tool calls from the most recent assistant message to match
  // tool results by toolCallId.
  let pendingToolCalls = [];

  for (const msg of agent.log) {
    switch (msg.role) {
      case "user": {
        ws.send(JSON.stringify({
          type: S2C.USER_MESSAGE,
          sessionId: session.id,
          content: msg.getTextContent(),
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
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          pendingToolCalls = msg.toolCalls;
          for (const tc of msg.toolCalls) {
            ws.send(JSON.stringify({
              type: S2C.TOOL_CALL,
              sessionId: session.id,
              name: tc.function?.name || "unknown",
              args: tc.function?.arguments || "{}",
            }));
          }
        }
        // Then emit the assistant message text (only if there is any)
        const textContent = msg.getTextContent();
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
          tc => tc.id === msg.toolCallId,
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
function routeMessage(ws, msg, registry, authMiddleware) {
  switch (msg.type) {
    case C2S.AUTH: {
      // Authenticate via in-band message (alternative to query param)
      if (authMiddleware && msg.token) {
        const valid = authMiddleware.validateToken(msg.token);
        if (valid) {
          ws.authToken = msg.token;
          ws.send(JSON.stringify({ type: "authOk" }));
          // If no session exists yet, attach to existing or create new
          if (!ws.activeSessionId) {
            if (registry.size > 0) {
              attachToMostRecentSession(ws);
            } else {
              createAndAttachSession(ws);
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
      if (ws.activeSessionId && ws.activeSink) {
        registry.detachSink(ws.activeSessionId, ws.activeSink);
      }
      registry.create({
        profile: msg.profile,
        model: msg.model,
        questionStrategy: msg.questionStrategy,
        questionTimeoutSecs: msg.questionTimeoutSecs,
      }).then(({ sessionId, agent }) => {
        // Attach this WS to the new session
        const wsSink = registry.attachSink(sessionId, ws);
        ws.activeSessionId = sessionId;
        ws.activeSink = wsSink;

        ws.send(JSON.stringify({
          type: "sessionCreated",
          sessionId,
          profile: agent.profileName || "default",
          currentModel: agent.model,
          models: Object.keys(agent._modelRegistry || {}),
        }));
      }).catch(err => {
        ws.send(JSON.stringify({ type: "error", message: err.message }));
      });
      break;
    }

    case C2S.DELETE_SESSION: {
      if (msg.sessionId) {
        registry.delete(msg.sessionId);
        ws.send(JSON.stringify({ type: "sessionDeleted", sessionId: msg.sessionId }));
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
        const session = registry.get(msg.sessionId);
        if (session) {
          // Detach from old session
          if (ws.activeSessionId && ws.activeSink) {
            registry.detachSink(ws.activeSessionId, ws.activeSink);
          }
          // Attach to new session
          const wsSink = registry.attachSink(msg.sessionId, ws);
          ws.activeSessionId = msg.sessionId;
          ws.activeSink = wsSink;
          // Send session metadata so the frontend can update reactively
          const agent = session.agent;
          ws.send(JSON.stringify({
            type: S2C.SESSION_STATE,
            key: "model",
            value: agent.model || session.metadata.model || "?",
          }));
          ws.send(JSON.stringify({
            type: S2C.SESSION_STATE,
            key: "models",
            value: Object.keys(agent._modelRegistry || {}),
          }));
          ws.send(JSON.stringify({
            type: S2C.SESSION_STATE,
            key: "profile",
            value: agent.profileName || session.metadata.profile || "default",
          }));
          // Replay session history so the client sees the full conversation
          replaySessionHistory(session, ws);
        }
      }
      break;
    }

    case C2S.SEND: {
      if (msg.sessionId && msg.content) {
        registry.touch(msg.sessionId);
        const session = registry.get(msg.sessionId);
        if (session) {
          session.bus.enqueue(msg.content);
        }
      }
      break;
    }

    case C2S.CANCEL: {
      if (msg.sessionId) {
        const session = registry.get(msg.sessionId);
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
        registry.touch(msg.sessionId);
        const session = registry.get(msg.sessionId);
        if (session) {
          // Strip leading `/` and lowercase, matching the CLI behavior
          let cmdText = msg.command;
          if (cmdText.startsWith("/")) {
            cmdText = cmdText.slice(1).trim().toLowerCase();
          }
          session.bus.executeCommand(cmdText);
        }
      }
      break;
    }

    default: {
      ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` }));
      break;
    }
  }
}

// ── createWsServer Factory ───────────────────────────────────────────────────

/**
 * Create a WebSocket server handler object.
 * Provides the onUpgrade handler for Bun.serve() and session registry.
 *
 * @param {Object} core - The core object (hooks, toolRegistry, config)
 * @param {Object} options
 * @param {Function} [options.buildAgent] - Override default agent builder
 * @param {number} [options.sessionTimeoutMin=30]
 * @param {number} [options.questionTimeoutSecs=300]
 * @param {string} [options.questionStrategy="wait"]
 * @param {Object} [options.auth] - Auth middleware (from createAuthMiddleware)
 * @returns {Object} { sessionRegistry, onUpgrade, onMessage, onClose }
 */
export function createWsServer(core, options = {}) {
  const {
    buildAgent: customBuildAgent,
    sessionTimeoutMin = 30,
    questionTimeoutSecs = 300,
    questionStrategy = "wait",
    auth,
  } = options;

  // Default agent builder — creates a basic agent using core infrastructure
  const buildAgent = customBuildAgent || (async (agentConfig) => {
    const { LlmClient } = await import("../../core/llm-client/client.js");
    const { MarkerMangler } = await import("../../core/marker-mangler.js");
    const { Agent } = await import("../../core/agent.js");

    const llmClient = new LlmClient({
      baseUrl: core.resolved?.baseUrl || "",
      apiKey: core.resolved?.apiKey || "",
      stream: core.resolved?.stream !== false,
      chatTimeoutSecs: core.resolved?.chatTimeout,
      maxRetries: core.resolved?.maxRetries,
      providers: core.config?.providers || [],
      markerMangler: new MarkerMangler(),
    });

    const sessionId = agentConfig.sessionId || crypto.randomUUID();
    const agent = new Agent({
      hooks: core.hooks,
      toolRegistry: core.toolRegistry,
      llmClient,
      model: agentConfig.model || core.resolved?.model,
      maxIterations: core.resolved?.maxIterations,
      maxTokens: core.resolved?.maxTokens,
      hideTools: agentConfig.hideTools ?? core.resolved?.hideTools ?? false,
      hideThinking: agentConfig.hideThinking ?? core.resolved?.hideThinking ?? true,
      showTokenUse: agentConfig.showTokenUse ?? core.resolved?.showTokenUse ?? true,
      sink: agentConfig.sink || null,
      modelRegistry: core.resolved?.modelRegistry || {},
      profileName: agentConfig.profileName || core.resolved?.profileName || "default",
      config: core.config || {},
      sessionId,
      abortSignal: null,
      toolWhitelist: null,
    });

    await agent.ensureSystemPrompt();

    // Emit COMMANDS_REGISTER so extensions can register commands
    if (core.hooks) {
      core.hooks.notifyHooks(HOOKS.COMMANDS_REGISTER, {
        registry: agent.getCommandRegistry(),
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
   *
   * @param {Object} req - Minimal request object (has url property)
   * @param {WebSocket} ws - The WebSocket instance
   */
  function onUpgrade(req, ws) {
    // Auth: validate token from query param
    const url = new URL(req.url, `http://${req.headers?.host || "localhost"}`);
    const token = url.searchParams.get("token");

    if (auth && token) {
      if (!auth.validateToken(token)) {
        ws.send(JSON.stringify({ type: "authError", message: "Invalid or expired token" }));
        ws.close(4001, "Invalid token");
        return;
      }
      ws.authToken = token;
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
      attachToMostRecentSession(ws);
    } else {
      createAndAttachSession(ws);
    }
  }

  /**
   * Attach the WebSocket to the most recently active existing session.
   * Sends sessionCreated so the client sets up its UI, then replays history.
   */
  function attachToMostRecentSession(ws) {
    // Find the session with the most recent lastActivityAt
    const sessions = registry.list();
    let mostRecent = null;
    let mostRecentTime = 0;
    for (const s of sessions) {
      if (s.lastActivityAt > mostRecentTime) {
        mostRecent = s;
        mostRecentTime = s.lastActivityAt;
      }
    }

    if (!mostRecent) {
      // Fallback — create a new session
      createAndAttachSession(ws);
      return;
    }

    const sessionId = mostRecent.id;
    const session = registry.get(sessionId);
    if (!session || !session.agent) {
      createAndAttachSession(ws);
      return;
    }

    // Attach the WebSocket sink to the existing session
    const wsSink = registry.attachSink(sessionId, ws);
    ws.activeSessionId = sessionId;
    ws.activeSink = wsSink;

    // Send sessionCreated so the client sets up its UI for this session
    const agent = session.agent;
    ws.send(JSON.stringify({
      type: "sessionCreated",
      sessionId,
      profile: agent.profileName || mostRecent.profile || "default",
      currentModel: agent.model || mostRecent.model || "?",
      models: Object.keys(agent._modelRegistry || {}),
    }));

    // Replay session history so the client sees the full conversation
    replaySessionHistory(session, ws);
  }

  /**
   * Create a new session and attach the WebSocket sink.
   */
  function createAndAttachSession(ws) {
    registry.create({}).then(({ sessionId, agent }) => {
      const wsSink = registry.attachSink(sessionId, ws);
      ws.activeSessionId = sessionId;
      ws.activeSink = wsSink;

      ws.send(JSON.stringify({
        type: "sessionCreated",
        sessionId,
        profile: agent.profileName || "default",
        currentModel: agent.model,
        models: Object.keys(agent._modelRegistry || {}),
      }));
    }).catch(err => {
      ws.send(JSON.stringify({ type: "error", message: err.message }));
      ws.close(4003, "Failed to create session");
    });
  }

  /**
   * Handle incoming WS messages.
   */
  function onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
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
  function onClose(ws) {
    if (ws.activeSessionId && ws.activeSink) {
      registry.detachSink(ws.activeSessionId, ws.activeSink);
    }
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
