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
import type { ProfileManager, SwitchProfile } from "../config/index.ts";
import type { Message, ImageAttachment, MessageSource } from "../context/message.ts";
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
  sink: OutputSink | null;
  toolWhitelist: string[] | null;
  role: string | undefined;
  profileBody: string | undefined;
  enqueueCallback: ((content: string | Array<Record<string, unknown>>, opts?: { source?: MessageSource }) => void) | null;
  serialize(): Record<string, unknown>;
  deserialize(data: Record<string, unknown>): void;
  applyProfile(name: string, profile: SwitchProfile): void;
  run(
    content: string | Array<Record<string, unknown>>,
    images?: ImageAttachment[],
    opts?: { source?: MessageSource },
  ): Promise<AgentRunResult | undefined>;
  clearContext(): Promise<void>;
  cancel(): void;
  resetCancel(): void;
  executeCommand(cmd: ParsedCommand): Promise<CommandResult | null>;
  addMessage(msg: Message): void;
  getMessages(): Message[];
  abortSignal?: AbortSignal | null;
  notifyCompletion?(result: string): void;
  followQueue?: string[];
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

  constructor() {
    this.#agents = new Map();
  }

  addAgent(agent: AgentLike): string {
    const sessionId = agent.sessionId || crypto.randomUUID();
    this.#agents.set(sessionId, agent);
    return sessionId;
  }

  getAgent(sessionId: string): AgentLike | undefined {
    return this.#agents.get(sessionId);
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
  // Owned by SessionManager and passed through buildAgent config, so entry points don't each create one.
  llmClient?: LlmClient;
  modelRegistry?: Record<string, ModelConfig>;
  coreConfig?: Record<string, unknown>;
  // When provided, SessionManager creates and owns a TaskManager internally.
  taskConfig?: {
    maxIterations: number;
    taskProfile: string;
    taskRole: string;
  } | null;
  extensions?: unknown;
  profileManager?: ProfileManager;
}

export type SessionEventHandler = (event: OutputEvent) => void;

export class SessionManager {
  #hooks: SessionManagerOptions["hooks"];
  #buildAgent: (config: Record<string, unknown>) => Promise<AgentLike>;
  #serializer: Serializer | null;
  #store: SessionStore;
  #currentSessionId: string | null;
  #sessions: Map<string, SessionEntry>;
  #eventHandlers: Map<string, SessionEventHandler[]>;
  #taskManager: TaskManager | null;
  #llmClient: LlmClient | null;
  // QUESTION events emitted while no channels are connected, replayed on reconnect.
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
        modelRegistry: options.modelRegistry,
        config: options.coreConfig || {},
        maxIterations: options.taskConfig.maxIterations,
        taskProfile: options.taskConfig.taskProfile,
        taskRole: options.taskConfig.taskRole,
        profileManager: options.profileManager,
      });

      this.#taskManager.setSessionManager(this);
    }
  }

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

  registerAgent(agent: AgentLike, config?: Record<string, unknown>): string {
    const sessionId = this.#store.addAgent(agent);
    // Don't displace the current session -- a CLI session shouldn't be bumped by a websocket one.
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
      // oldAgent is the previously active session's agent (the contract is
      // "who was current before this switch"), not the switch target.
      const oldAgent = this.#currentSessionId
        ? this.#store.getAgent(this.#currentSessionId)
        : undefined;
      this.#currentSessionId = sessionId;
      this.#hooks.notifyHooks(HOOKS.SESSION_SWAP, {
        oldAgent,
        newAgent: agent,
      });
    }
    return agent;
  }

  sessionId(): string | null {
    return this.#currentSessionId;
  }

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

  interrupt(sessionId: string): void {
    const entry = this.#sessions.get(sessionId);
    if (entry) {
      entry.bus.interrupt();
    }
  }

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

  /** Returns an unsubscribe function. */
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

  emitToChannels(sessionId: string, event: OutputEvent): void {
    const handlers = this.#eventHandlers.get(sessionId);

    if (handlers && handlers.length > 0) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {}
      }
    } else if (event.type === OUTPUT_EVENT.QUESTION && event.questions) {
      if (!this.#questionBuffers.has(sessionId)) {
        this.#questionBuffers.set(sessionId, []);
      }
      this.#questionBuffers.get(sessionId)!.push(event.questions);
    }
  }

  /** Clears the buffer; callers replay the returned questions to newly connected channels. */
  drainPendingQuestions(sessionId: string): QuestionOption[][] {
    const buffer = this.#questionBuffers.get(sessionId);
    if (!buffer || buffer.length === 0) return [];
    this.#questionBuffers.delete(sessionId);
    return buffer;
  }

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

  isSessionRunning(sessionId: string): boolean {
    const entry = this.#sessions.get(sessionId);
    return entry?.bus.isRunning ?? false;
  }

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

  getStore(): SessionStore {
    return this.#store;
  }

  sessionIds(): string[] {
    return this.#store.sessionIds();
  }

  sessionCount(): number {
    return this.#store.size();
  }

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

    agent.enqueueCallback = (text, opts) => bus.enqueue(text, opts);

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

  /** Exposed for extensions that need direct bus access. */
  getBus(sessionId: string): MessageBus | undefined {
    return this.#sessions.get(sessionId)?.bus;
  }

  getTaskManager(): TaskManager | null {
    return this.#taskManager;
  }
}
