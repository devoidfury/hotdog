// SessionManager — manages the session lifecycle.
// Owns sessions, agents, message buses, and event distribution.

import crypto from "node:crypto";
import { HOOKS, HookSystem } from "../hooks.ts";
import { MessageBus } from "./message-bus.ts";
import { TaskManager } from "./task-manager.ts";
import { OUTPUT_EVENT, OutputEvent } from "../context/output.ts";
import { formatError } from "../error.ts";
import { logger } from "../logger.ts";
import type { CommandRegistryLike, ParsedCommand } from "../commands.ts";
import type { LlmClient } from "../llm-client/client.ts";
import type { CommandResult } from "../extensions/registries.ts";
import type { ProfileManager } from "../config/index.ts";
import type { MessageLog } from "../context/message-log.ts";
import type { ImageAttachment } from "../context/message.ts";
import type { AgentRunResult, OutputSink } from "../agent.ts";
import type { ModelConfig } from "../config/providers.ts";

export interface QuestionOption {
  key: string;
  prompt: string;
  options?: string[];
  required?: boolean;
  default?: string;
  allow_other?: boolean;
}

export interface AgentLike {
  sessionId: string;
  model: string;
  profileName: string | undefined;
  hooks: HookSystem;
  log: MessageLog;
  sink: OutputSink | null;
  toolWhitelist: string[] | null;
  role: string | undefined;
  profileBody: string | undefined;
  enqueueCallback: ((text: string) => void) | null;
  serialize(): Record<string, unknown>;
  deserialize(data: Record<string, unknown>): void;
  run(text: string, images?: ImageAttachment[]): Promise<AgentRunResult | undefined>;
  clearContext(): Promise<void>;
  cancel(): void;
  resetCancel(): void;
  executeCommand(cmd: ParsedCommand): Promise<CommandResult | null>;
  addMessage(msg: import("../context/message.ts").Message): void;
  // Task agent support
  abortSignal?: AbortSignal | null;
  notifyCompletion?(result: string): void;
  followQueue?: string[];
  // Optional properties for completion handlers and session info
  commandRegistry?: CommandRegistryLike | null;
  modelRegistry?: Record<string, ModelConfig> | null;
  config?: Record<string, unknown> | null;
}

export interface Serializer {
  serialize(agent: AgentLike): Record<string, unknown> | null;
}

interface SessionEntry {
  agent: AgentLike;
  bus: MessageBus;
  busRunLoop: Promise<unknown>;
  metadata: Record<string, unknown>;
}

export class SessionStore {
  #agents: Map<string, AgentLike>;
  #initialSessionId: string | null;

  constructor(options: { initialSessionId?: string } = {}) {
    this.#agents = new Map();
    this.#initialSessionId = options.initialSessionId || null;
  }

  addAgent(agent: AgentLike): string {
    const sessionId = agent.sessionId || crypto.randomUUID();
    this.#agents.set(sessionId, agent);
    if (!this.#initialSessionId) {
      this.#initialSessionId = sessionId;
    }
    return sessionId;
  }

  getAgent(sessionId: string): AgentLike | undefined {
    return this.#agents.get(sessionId);
  }

  initialSessionId(): string | null {
    return this.#initialSessionId;
  }

  size(): number {
    return this.#agents.size;
  }

  removeAgent(sessionId: string): boolean {
    if (!this.#agents.has(sessionId)) return false;
    this.#agents.delete(sessionId);
    return true;
  }

  agents(): AgentLike[] {
    return Array.from(this.#agents.values());
  }

  sessionIds(): string[] {
    return Array.from(this.#agents.keys());
  }
}

export interface SessionManagerOptions {
  hooks: HookSystem;
  buildAgent: (config: Record<string, unknown>) => Promise<AgentLike>;
  serializer?: Serializer | null;
  initialConfig?: Record<string, unknown>;
  /** LLM client — when provided, SessionManager owns it and passes it through
   *  buildAgent config. Prevents each entry point from creating its own instance. */
  llmClient?: LlmClient;
  /** Model registry — passed through buildAgent config and used by TaskManager. */
  modelRegistry?: Record<string, ModelConfig>;
  /** Core config — used by TaskManager. */
  coreConfig?: Record<string, unknown>;
  /** Task configuration — when provided, SessionManager creates and owns a TaskManager internally. */
  taskConfig?: {
    maxIterations: number;
    taskProfile: string;
    taskRole: string;
  } | null;
  /** Extension loader — passed through to channels for extension access. */
  extensions?: unknown;
  /** Profile manager — used by TaskManager for profile lookups. */
  profileManager?: ProfileManager;
}

export type SessionEventHandler = (event: OutputEvent) => void;

/**
 * Manages the session lifecycle: owns agents, message buses, and event distribution.
 */
export class SessionManager {
  #hooks: SessionManagerOptions["hooks"];
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
  #llmClient: LlmClient | null;
  /** Per-session QUESTION event buffer — holds questions emitted while no channels
   *  are connected, so they can be replayed when a channel reconnects. */
  #questionBuffers: Map<string, QuestionOption[][]>;

  static async create(options: SessionManagerOptions): Promise<SessionManager> {
    const instance = new SessionManager(options);

    if (options.buildAgent) {
      const initialConfig = options.initialConfig || {};
      const agent = await options.buildAgent(initialConfig);
      const sessionId = instance.#store.addAgent(agent);
      instance.#currentSessionId = sessionId;
      instance.#createSessionEntry(sessionId, agent, initialConfig);
    }

    return instance;
  }

  constructor(options: SessionManagerOptions) {
    this.#hooks = options.hooks;
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

    if (options.taskConfig && options.llmClient && options.modelRegistry) {
      this.#taskManager = new TaskManager({
        buildAgent: this.#buildAgent,
        llmClient: options.llmClient,
        modelRegistry: options.modelRegistry,
        config: options.coreConfig || {},
        hooks: options.hooks,
        maxIterations: options.taskConfig.maxIterations,
        taskProfile: options.taskConfig.taskProfile,
        taskRole: options.taskConfig.taskRole,
        profileManager: options.profileManager,
      });

      this.#taskManager.setSessionManager(this);
    }
  }

  // ── Session Lifecycle ─────────────────────────────────────────────────────

  /**
   * Create a new agent and add it to the store.
   * Also creates the internal MessageBus for this session.
   */
  async create(config: Record<string, unknown>): Promise<string> {
    const agent = await this.#buildAgent(config);
    const sessionId = this.#store.addAgent(agent);
    this.#currentSessionId = sessionId;
    this.#createSessionEntry(sessionId, agent, config);
    this.#hooks.notifyHooks(HOOKS.SESSION_CREATE, {
      session: this,
      sessionId: sessionId,
      config,
    });
    return sessionId;
  }

  /**
   * Construct a new agent and swap it in, replacing the current one.
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
      oldAgent: oldAgent ?? undefined,
      newAgent,
    });
    return newAgent;
  }

  getAgent(): AgentLike | undefined {
    return this.#store.getAgent(this.#currentSessionId!);
  }

  getAgentBySessionId(sessionId: string): AgentLike | undefined {
    return this.#store.getAgent(sessionId);
  }

  /**
   * Register a pre-built agent and create its session entry (bus, sink wiring).
   * Used by extensions that build agents outside SessionManager's normal flow
   * (e.g., websocket server with custom buildAgent).
   */
  registerAgent(agent: AgentLike, config?: Record<string, unknown>): string {
    const sessionId = this.#store.addAgent(agent);
    // Don't override #currentSessionId — the caller may have an active session
    // (e.g., CLI session) that shouldn't be displaced by a websocket session.
    this.#createSessionEntry(sessionId, agent, config || {});
    return sessionId;
  }

  deleteSession(sessionId: string): boolean {
    const entry = this.#sessions.get(sessionId);
    if (entry) {
      entry.bus.cancel();
      this.#sessions.delete(sessionId);
    }

    this.#eventHandlers.delete(sessionId);
    this.#questionBuffers.delete(sessionId);

    return this.#store.removeAgent(sessionId);
  }

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

  sessionId(): string | null {
    return this.#currentSessionId;
  }

  // ── I/O Routing ──────────────────────────────────────────────────────────

  /**
   * Enqueue text for a specific session's message bus.
   */
  enqueue(sessionId: string, text: string): void {
    const entry = this.#sessions.get(sessionId);
    if (entry) {
      entry.bus.enqueue(text);
    }
  }

  cancel(sessionId: string): void {
    const entry = this.#sessions.get(sessionId);
    if (entry) {
      entry.bus.cancel();
    }
  }

  /**
   * Interrupt a session's current processing (clears queue, continues loop).
   */
  interrupt(sessionId: string): void {
    const entry = this.#sessions.get(sessionId);
    if (entry) {
      entry.bus.interrupt();
    }
  }

  /**
   * Execute a command on a specific session.
   * @returns Command action bits or undefined
   */
  async executeCommand(
    sessionId: string,
    cmdText: string,
  ): Promise<number | undefined> {
    const entry = this.#sessions.get(sessionId);
    if (entry) {
      return await entry.bus.executeCommand(cmdText);
    }
    return undefined;
  }

  // ── Event Distribution ───────────────────────────────────────────────────

  /**
   * Register a callback for events from a specific session.
   * Returns an unsubscribe function.
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
   */
  emitToChannels(sessionId: string, event: OutputEvent): void {
    const handlers = this.#eventHandlers.get(sessionId);

    if (handlers && handlers.length > 0) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {
          // non-fatal
        }
      }
    } else if (event.type === OUTPUT_EVENT.QUESTION && event.questions) {
      if (!this.#questionBuffers.has(sessionId)) {
        this.#questionBuffers.set(sessionId, []);
      }
      this.#questionBuffers.get(sessionId)!.push(event.questions);
    }
  }

  /**
   * Drain buffered QUESTION events for a session (emitted while no channels were
   * connected) and clear the buffer. Callers should replay these to newly
   * connected channels.
   */
  drainPendingQuestions(sessionId: string): QuestionOption[][] {
    const buffer = this.#questionBuffers.get(sessionId);
    if (!buffer || buffer.length === 0) return [];
    this.#questionBuffers.delete(sessionId);
    return buffer;
  }

  // ── Session Info ─────────────────────────────────────────────────────────

  getSessionInfo(
    sessionId: string,
  ): { id: string; model?: string; profile?: string } | null {
    const agent = this.#store.getAgent(sessionId);
    if (!agent) return null;

    return {
      id: sessionId,
      model: agent.model,
      profile: agent.profileName,
    };
  }

  /** Check if a session's agent is currently running (processing a message). */
  isSessionRunning(sessionId: string): boolean {
    const entry = this.#sessions.get(sessionId);
    return entry?.bus.isRunning ?? false;
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  /** Serialize the current agent state, or null if no agent is active. */
  serialize(): Record<string, unknown> | null {
    const agent = this.getAgent();
    if (!agent) return null;
    if (this.#serializer) {
      return this.#serializer.serialize(agent);
    }
    return agent.serialize();
  }

  async deserialize(data: Record<string, unknown>): Promise<AgentLike> {
    this.#hooks.notifyHooks(HOOKS.SESSION_DESERIALIZE, { data });

    const agent = await this.#buildAgent({ model: data.model });
    agent.deserialize(data);
    this.#store.addAgent(agent);
    this.#currentSessionId = data.sessionId as string;
    return agent;
  }

  // ── Store Access ──────────────────────────────────────────────────────────

  getStore(): SessionStore {
    return this.#store;
  }

  sessionIds(): string[] {
    return this.#store.sessionIds();
  }

  sessionCount(): number {
    return this.#store.size();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  #createSessionEntry(
    sessionId: string,
    agent: AgentLike,
    config: Record<string, unknown>,
  ): void {
    const internalSink = {
      emit: (event: OutputEvent) => {
        this.emitToChannels(sessionId, event);
      },
    };

    const bus = new MessageBus({
      sessionManager: {
        getAgent: () => agent,
      },
      sink: internalSink,
    });

    if (agent.sink === null || agent.sink === undefined) {
      agent.sink = internalSink;
    }

    // Wire the agent's enqueueCallback so extensions/hooks can queue messages
    agent.enqueueCallback = (text: string) => bus.enqueue(text);

    if (this.#taskManager) {
      this.#taskManager.setBus(bus);
    }

    const runLoop = bus.run().catch((err: Error) => {
      logger.error(`[session ${sessionId}] bus error: ${formatError(err)}`);
    });

    this.#sessions.set(sessionId, {
      agent,
      bus,
      busRunLoop: runLoop,
      metadata: config,
    });
  }

  /** Get the internal message bus. Exposed for extensions that need direct bus access. */
  getBus(sessionId: string): MessageBus | undefined {
    return this.#sessions.get(sessionId)?.bus;
  }

  // ── TaskManager Access ───────────────────────────────────────────────────

  getTaskManager(): TaskManager | null {
    return this.#taskManager;
  }
}
