// SessionManager — manages the session lifecycle.
// Owns sessions, agents, message buses, and event distribution.

import crypto from "node:crypto";
import { HOOKS } from "../hooks.ts";
import { MessageBus } from "./message-bus.ts";
import { TaskManager } from "./task-manager.ts";
import { OUTPUT_EVENT, OutputEvent } from "../context/output.ts";
import { formatError } from "../error.ts";
import { logger } from "../logger.ts";
import type { CommandRegistryLike } from "../commands.ts";

export interface AgentLike {
  sessionId: string;
  serialize(): Record<string, unknown>;
  deserialize(data: Record<string, unknown>): void;
}

export interface Serializer {
  serialize(agent: AgentLike): Record<string, unknown> | null;
}

/**
 * Internal session entry — holds the agent, message bus, and bus run promise.
 */
interface SessionEntry {
  agent: AgentLike;
  bus: MessageBus;
  busRunLoop: Promise<unknown>;
  metadata: Record<string, unknown>;
}

/**
 * Session store — holds agents keyed by session ID.
 */
export class SessionStore {
  #agents: Map<string, AgentLike>;
  #initialSessionId: string | null;

  /**
   * @param options
   * @param options.initialSessionId - Optional initial session ID
   */
  constructor(options: { initialSessionId?: string } = {}) {
    this.#agents = new Map();
    this.#initialSessionId = options.initialSessionId || null;
  }

  /**
   * Add an agent to the store.
   * @param agent - Agent instance.
   * @returns Session ID.
   */
  addAgent(agent: AgentLike): string {
    const sessionId = agent.sessionId || crypto.randomUUID();
    this.#agents.set(sessionId, agent);
    if (!this.#initialSessionId) {
      this.#initialSessionId = sessionId;
    }
    return sessionId;
  }

  /**
   * Get an agent by session ID.
   * @param sessionId - Session ID.
   * @returns Agent instance or undefined.
   */
  getAgent(sessionId: string): AgentLike | undefined {
    return this.#agents.get(sessionId);
  }

  /**
   * Get the initial session ID.
   * @returns Initial session ID or null.
   */
  initialSessionId(): string | null {
    return this.#initialSessionId;
  }

  /**
   * Get the number of agents in the store.
   * @returns Agent count.
   */
  size(): number {
    return this.#agents.size;
  }

  /**
   * Remove an agent from the store.
   * @param sessionId - Session ID.
   * @returns True if agent was removed.
   */
  removeAgent(sessionId: string): boolean {
    if (!this.#agents.has(sessionId)) return false;
    this.#agents.delete(sessionId);
    return true;
  }

  /**
   * Get all agents in the store.
   * @returns Array of agent instances.
   */
  agents(): AgentLike[] {
    return Array.from(this.#agents.values());
  }

  /**
   * Get all session IDs in the store.
   * @returns Array of session IDs.
   */
  sessionIds(): string[] {
    return Array.from(this.#agents.keys());
  }
}

export interface SessionManagerOptions {
  hooks: {
    notifyHooks(hookName: string, data: unknown): void;
  };
  extensions: unknown;
  buildAgent: (config: Record<string, unknown>) => Promise<AgentLike>;
  serializer?: Serializer | null;
  initialConfig?: Record<string, unknown>;
  /** LLM client — when provided, SessionManager owns it and passes it through
   *  buildAgent config. Prevents each entry point from creating its own instance. */
  llmClient?: unknown;
  /** Model registry — passed through buildAgent config and used by TaskManager. */
  modelRegistry?: Record<string, unknown>;
  /** Core config — used by TaskManager. */
  coreConfig?: Record<string, unknown>;
  /** Task configuration — when provided, SessionManager creates and owns a TaskManager internally. */
  taskConfig?: {
    maxIterations: number;
    taskProfile: string;
    taskRole: string;
  } | null;
}

/**
 * Event handler type for session event distribution.
 */
export type SessionEventHandler = (event: OutputEvent) => void;

/**
 * Manages the session lifecycle: owns agents, message buses, and event distribution.
 *
 * SessionManager is the central hub that:
 *  - Creates and manages sessions (agent + message bus)
 *  - Routes I/O to the correct session
 *  - Distributes events from sessions to subscribed channels
 */
export class SessionManager {
  #hooks: SessionManagerOptions["hooks"];
  #extensions: unknown;
  #buildAgent: (config: Record<string, unknown>) => Promise<AgentLike>;
  #serializer: Serializer | null;
  #store: SessionStore;
  #currentSessionId: string | null;
  #sessions: Map<string, SessionEntry>;
  /** Per-session event handlers. Keyed by sessionId. */
  #eventHandlers: Map<string, SessionEventHandler[]>;
  /** Internally owned TaskManager (created when taskConfig is provided). */
  #taskManager: TaskManager | null;
  /** LLM client — owned by SessionManager, passed through buildAgent config. */
  #llmClient: unknown;
  /** Per-session QUESTION event buffer — holds questions emitted while no channels
   *  are connected, so they can be replayed when a channel reconnects. */
  #questionBuffers: Map<string, unknown[][]>;

  /**
   * Create a new SessionManager with an initial agent.
   * @param options
   * @param options.hooks — HookSystem
   * @param options.extensions — ExtensionLoader
   * @param options.buildAgent — Function(config) → Agent
   * @param options.serializer — Optional session serializer
   * @param options.initialConfig — Config for initial agent
   * @returns Session manager instance.
   */
  static async create(options: SessionManagerOptions): Promise<SessionManager> {
    const instance = new SessionManager(options);

    // Build initial agent if a buildAgent function is provided
    if (options.buildAgent) {
      const initialConfig = options.initialConfig || {};
      const agent = await options.buildAgent(initialConfig);
      const sessionId = instance.#store.addAgent(agent);
      instance.#currentSessionId = sessionId;
      // Create internal session entry with message bus
      instance.#createSessionEntry(sessionId, agent, initialConfig);
    }

    return instance;
  }

  constructor(options: SessionManagerOptions) {
    this.#hooks = options.hooks;
    this.#extensions = options.extensions;
    this.#serializer = options.serializer || null;
    this.#store = new SessionStore();
    this.#currentSessionId = null;
    this.#sessions = new Map();
    this.#eventHandlers = new Map();
    this.#taskManager = null;
    this.#llmClient = options.llmClient || null;
    this.#questionBuffers = new Map();

    // Wrap buildAgent to inject llmClient and modelRegistry into config
    const rawBuildAgent = options.buildAgent;
    this.#buildAgent = async (config: Record<string, unknown>) => {
      const enrichedConfig = { ...config };
      if (this.#llmClient) {
        enrichedConfig.llmClient = this.#llmClient;
      }
      if (options.modelRegistry) {
        enrichedConfig.modelRegistry = options.modelRegistry;
      }
      return rawBuildAgent(enrichedConfig);
    };

    // Create TaskManager internally if taskConfig is provided
    if (options.taskConfig && options.llmClient && options.modelRegistry) {
      this.#taskManager = new TaskManager({
        buildAgent: this.#buildAgent as unknown as (config: Record<string, unknown>) => Promise<import("./task-manager.ts").TaskAgent>,
        llmClient: options.llmClient,
        modelRegistry: options.modelRegistry,
        config: options.coreConfig || {},
        hooks: options.hooks,
        maxIterations: options.taskConfig.maxIterations,
        taskProfile: options.taskConfig.taskProfile,
        taskRole: options.taskConfig.taskRole,
      });
      // Wire sessionManager reference
      this.#taskManager.setSessionManager(this as unknown as { getAgent: () => import("./task-manager.ts").TaskAgent | undefined });
    }
  }

  // ── Session Lifecycle ─────────────────────────────────────────────────────

  /**
   * Create a new agent and add it to the store.
   * Also creates the internal MessageBus for this session.
   * @param config — Agent config.
   * @returns Session ID.
   */
  async create(config: Record<string, unknown>): Promise<string> {
    const agent = await this.#buildAgent(config);
    const sessionId = this.#store.addAgent(agent);
    this.#currentSessionId = sessionId;
    this.#createSessionEntry(sessionId, agent, config);
    this.#hooks.notifyHooks(HOOKS.SESSION_CREATE, {
      session: this,
      config,
    });
    return sessionId;
  }

  /**
   * Construct a new agent and swap it in, replacing the current one.
   * @param config — New agent config.
   * @returns The new agent instance.
   */
  async swap(config: Record<string, unknown>): Promise<AgentLike> {
    const oldAgent = this.#currentSessionId
      ? this.#store.getAgent(this.#currentSessionId)
      : undefined;
    const newAgent = await this.#buildAgent(config);
    this.#store.addAgent(newAgent);
    this.#currentSessionId = newAgent.sessionId;
    this.#createSessionEntry(newAgent.sessionId, newAgent, config);
    this.#hooks.notifyHooks(HOOKS.SESSION_SWAP, {
      oldAgent: oldAgent ?? null,
      newAgent,
    });
    return newAgent;
  }

  /**
   * Get the current agent.
   * @returns Agent instance or undefined.
   */
  getAgent(): AgentLike | undefined {
    return this.#store.getAgent(this.#currentSessionId!);
  }

  /**
   * Get an agent by session ID.
   * @param sessionId
   * @returns Agent instance or undefined.
   */
  getAgentBySessionId(sessionId: string): AgentLike | undefined {
    return this.#store.getAgent(sessionId);
  }

  /**
   * Register a pre-built agent and create its session entry (bus, sink wiring).
   * Used by extensions that build agents outside SessionManager's normal flow
   * (e.g., websocket server with custom buildAgent).
   * @param agent — Pre-built agent instance
   * @param config — Session config for metadata
   * @returns Session ID
   */
  registerAgent(agent: AgentLike, config?: Record<string, unknown>): string {
    const sessionId = this.#store.addAgent(agent);
    // Don't override #currentSessionId — the caller may have an active session
    // (e.g., CLI session) that shouldn't be displaced by a websocket session.
    this.#createSessionEntry(sessionId, agent, config || {});
    return sessionId;
  }

  /**
   * Delete a session — cancels the bus, removes event handlers, and removes from store.
   * @param sessionId — Session ID to delete
   * @returns True if the session was deleted
   */
  deleteSession(sessionId: string): boolean {
    // Cancel the bus
    const entry = this.#sessions.get(sessionId);
    if (entry) {
      entry.bus.cancel();
      this.#sessions.delete(sessionId);
    }

    // Remove event handlers
    this.#eventHandlers.delete(sessionId);

    // Remove question buffer
    this.#questionBuffers.delete(sessionId);

    // Remove from store
    return this.#store.removeAgent(sessionId);
  }

  /**
   * Switch to a different session by ID.
   * @param sessionId
   * @returns Agent instance or undefined.
   */
  switchSession(sessionId: string): AgentLike | undefined {
    const agent = this.#store.getAgent(sessionId);
    if (agent) {
      this.#currentSessionId = sessionId;
      this.#hooks.notifyHooks(HOOKS.SESSION_SWAP, {
        oldAgent: agent,
        newAgent: agent,
      });
    }
    return agent;
  }

  /**
   * Get the session ID of the current agent.
   * @returns Session ID or undefined.
   */
  sessionId(): string | null {
    return this.#currentSessionId;
  }

  // ── I/O Routing (new) ────────────────────────────────────────────────────

  /**
   * Enqueue text for a specific session's message bus.
   * @param sessionId — Target session ID
   * @param text — Text to enqueue
   */
  enqueue(sessionId: string, text: string): void {
    const entry = this.#sessions.get(sessionId);
    if (entry) {
      entry.bus.enqueue(text);
    }
  }

  /**
   * Cancel a session's message bus run loop.
   * @param sessionId — Target session ID
   */
  cancel(sessionId: string): void {
    const entry = this.#sessions.get(sessionId);
    if (entry) {
      entry.bus.cancel();
    }
  }

  /**
   * Interrupt a session's current processing (clears queue, continues loop).
   * @param sessionId — Target session ID
   */
  interrupt(sessionId: string): void {
    const entry = this.#sessions.get(sessionId);
    if (entry) {
      entry.bus.interrupt();
    }
  }

  /**
   * Execute a command on a specific session.
   * @param sessionId — Target session ID
   * @param cmdText — Command text
   * @returns Command action bits or undefined
   */
  async executeCommand(sessionId: string, cmdText: string): Promise<number | undefined> {
    const entry = this.#sessions.get(sessionId);
    if (entry) {
      return await entry.bus.executeCommand(cmdText);
    }
    return undefined;
  }

  // ── Event Distribution (new) ─────────────────────────────────────────────

  /**
   * Register a callback for events from a specific session.
   * Returns an unsubscribe function.
   * @param sessionId — Session ID to subscribe to
   * @param handler — Event handler callback
   * @returns Unsubscribe function
   */
  onSessionEvents(sessionId: string, handler: SessionEventHandler): () => void {
    if (!this.#eventHandlers.has(sessionId)) {
      this.#eventHandlers.set(sessionId, []);
    }
    const handlers = this.#eventHandlers.get(sessionId)!;
    handlers.push(handler);

    return () => {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) {
        handlers.splice(idx, 1);
      }
    };
  }

  /**
   * Emit an event to all handlers subscribed to a session.
   * Called by the internal event sink when an agent emits output.
   * @param sessionId — Source session ID
   * @param event — Output event
   */
  emitToChannels(sessionId: string, event: OutputEvent): void {
    const handlers = this.#eventHandlers.get(sessionId);

    if (handlers && handlers.length > 0) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {
          // Handler errors are non-fatal
        }
      }
    } else if (event.type === OUTPUT_EVENT.QUESTION && event.questions) {
      // Buffer QUESTION events when no channels are connected,
      // so they can be replayed when a channel reconnects.
      if (!this.#questionBuffers.has(sessionId)) {
        this.#questionBuffers.set(sessionId, []);
      }
      this.#questionBuffers.get(sessionId)!.push(event.questions as unknown[]);
    }
  }

  /**
   * Drain buffered QUESTION events for a session.
   * Returns any questions that were emitted while no channels were connected,
   * and clears the buffer. Callers should replay these to newly connected channels.
   * @param sessionId — Session ID
   * @returns Buffered question arrays, or empty array if none
   */
  drainPendingQuestions(sessionId: string): unknown[][] {
    const buffer = this.#questionBuffers.get(sessionId);
    if (!buffer || buffer.length === 0) return [];
    this.#questionBuffers.delete(sessionId);
    return buffer;
  }

  // ── Session Info ─────────────────────────────────────────────────────────

  /**
   * Get session metadata.
   * @param sessionId — Session ID
   * @returns Session info or null
   */
  getSessionInfo(sessionId: string): { id: string; model?: string; profile?: string } | null {
    const agent = this.#store.getAgent(sessionId);
    if (!agent) return null;

    const agentAny = agent as unknown as Record<string, unknown>;
    return {
      id: sessionId,
      model: agentAny.model as string | undefined,
      profile: agentAny.profileName as string | undefined,
    };
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  /**
   * Serialize the current agent state.
   * @returns Serialized state, or null if no agent is active.
   */
  serialize(): Record<string, unknown> | null {
    const agent = this.getAgent();
    if (!agent) return null;
    if (this.#serializer) {
      return this.#serializer.serialize(agent);
    }
    return agent.serialize();
  }

  /**
   * Deserialize agent state from persisted data.
   * @param data
   * @returns The deserialized agent
   */
  async deserialize(data: Record<string, unknown>): Promise<AgentLike> {
    this.#hooks.notifyHooks(HOOKS.SESSION_DESERIALIZE, { data });

    const agent = await this.#buildAgent({ model: data.model });
    agent.deserialize(data);
    this.#store.addAgent(agent);
    this.#currentSessionId = data.sessionId as string;
    return agent;
  }

  // ── Store Access ──────────────────────────────────────────────────────────

  /**
   * Get the session store.
   */
  getStore(): SessionStore {
    return this.#store;
  }

  /**
   * Get all session IDs.
   */
  sessionIds(): string[] {
    return this.#store.sessionIds();
  }

  /**
   * Get the number of sessions.
   */
  sessionCount(): number {
    return this.#store.size();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Create an internal session entry with a MessageBus.
   * The bus uses an internal sink that fans out to subscribed channels.
   * Also wires up the TaskManager and agent enqueueCallback if configured.
   * @param sessionId — Session ID
   * @param agent — Agent instance
   * @param config — Session config
   */
  #createSessionEntry(sessionId: string, agent: AgentLike, config: Record<string, unknown>): void {
    // Create an internal sink that routes events to subscribed channels
    const internalSink = {
      emit: (event: OutputEvent) => {
        this.emitToChannels(sessionId, event);
      },
    };

    // Create the message bus with the internal sink
    const bus = new MessageBus({
      sessionManager: {
        getAgent: () => agent as unknown as {
          hooks: { runHookPipeline: (hookName: string, data: unknown, opts?: { shouldStop?: (result: unknown) => boolean }) => Promise<unknown> };
          run: (text: string) => Promise<unknown>;
          resetCancel: () => void;
          cancel: () => void;
          commandRegistry: CommandRegistryLike | undefined;
          executeCommand: (cmd: unknown) => Promise<unknown>;
        } | undefined,
      },
      sink: internalSink,
    });

    // Wire the agent's sink to the internal sink
    const agentAny = agent as unknown as Record<string, unknown>;
    if (agentAny.sink === null || agentAny.sink === undefined) {
      agentAny.sink = internalSink;
    }

    // Wire the agent's enqueueCallback so extensions/hooks can queue messages
    if ("enqueueCallback" in agentAny) {
      agentAny.enqueueCallback = (text: string) => bus.enqueue(text);
    }

    // Wire up the TaskManager for this session's bus
    if (this.#taskManager) {
      this.#taskManager.setBus(bus);
    }

    // Start the bus run loop (non-blocking)
    const runLoop = bus.run().catch((err: unknown) => {
      logger.error(`[session ${sessionId}] bus error: ${formatError(err)}`);
    });

    this.#sessions.set(sessionId, {
      agent,
      bus,
      busRunLoop: runLoop,
      metadata: config,
    });
  }

  /**
   * Get the internal message bus for a session.
   * @internal — exposed for extensions that need direct bus access
   * @param sessionId — Session ID
   * @returns MessageBus or undefined
   */
  getBus(sessionId: string): MessageBus | undefined {
    return this.#sessions.get(sessionId)?.bus;
  }

  // ── TaskManager Access ───────────────────────────────────────────────────

  /**
   * Get the internally owned TaskManager, if one was created.
   * @returns TaskManager or null
   */
  getTaskManager(): TaskManager | null {
    return this.#taskManager;
  }
}
