import crypto from "node:crypto";
import { HOOKS, HookSystem } from "../hooks.ts";
import { MessageBus } from "./message-bus.ts";
import { createTurnLanes, type TurnLanes } from "./turn-lanes.ts";
import { TaskManager } from "./task-manager.ts";
import { OUTPUT_EVENT, OutputEvent } from "../context/output.ts";
import { trimTurns } from "../context/rewind.ts";
import { AgentError, formatError } from "../error.ts";
import { logger } from "@utils/logger.ts";
import type { CommandRegistryLike, ParsedCommand } from "../commands.ts";
import type { LlmClient } from "../llm-client/client.ts";
import type { CommandResult } from "../extensions/registries.ts";
import type { ProfileManager, SwitchProfile } from "../config/index.ts";
import type { Message, ImageAttachment, MessageSource } from "../context/message.ts";
import type { AgentRunResult, ForkSessionFn, ForkSessionResult, OutputSink } from "../agent.ts";
import type { ModelConfig, ProviderDef } from "../config/providers.ts";
import type { QuestionDef } from "../context/input.ts";

export interface AgentLike {
  sessionId: string;
  model: string;
  profileName: string | undefined;
  hooks: HookSystem;
  sink: OutputSink | null;
  toolWhitelist: string[] | null;
  profileBody: string | undefined;
  enqueueCallback: ((content: string | Array<Record<string, unknown>>, opts?: { source?: MessageSource }) => void) | null;
  /** Branch this session (/fork). Set by the owning SessionManager; absent on sessionless agents. */
  forkSession?: ForkSessionFn | null;
  serialize(): Record<string, unknown>;
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
  /** Inject a steering message (drained between LLM calls). See Agent.steer. */
  steer?(content: string): void;
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
    lanesPerProvider?: number;
    /** Cross-process lane ledger dir (resolved config: taskLanesDir). */
    lanesDir?: string | null;
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
  // Provider-lane coordinator shared by every session bus this manager owns
  // (same taskLanesDir / taskLanesPerProvider as the TaskManager). Null when
  // no taskConfig was given: session turns then run uncoordinated.
  #turnLanes: TurnLanes | null;
  #llmClient: LlmClient | null;
  // QUESTION events emitted while no channels are connected, replayed on reconnect.
  #questionBuffers: Map<string, QuestionDef[][]>;

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
    this.#turnLanes = null;
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

    if (options.taskConfig) {
      // Top-level session turns share the machine-wide lane ledger with task
      // agents: one slot per active turn, resolved model's lane, same caps.
      this.#turnLanes = createTurnLanes({
        lanesDir: options.taskConfig.lanesDir,
        lanesPerProvider: options.taskConfig.lanesPerProvider,
        providerDefs:
          ((options.coreConfig as Record<string, unknown> | undefined)?.providers as
            | ProviderDef[]
            | undefined) ?? [],
      });
    }

    if (options.taskConfig && options.llmClient && options.modelRegistry) {
      this.#taskManager = new TaskManager({
        buildAgent: this.#buildAgent,
        modelRegistry: options.modelRegistry,
        config: options.coreConfig || {},
        maxIterations: options.taskConfig.maxIterations,
        taskProfile: options.taskConfig.taskProfile,
        lanesPerProvider: options.taskConfig.lanesPerProvider,
        lanesDir: options.taskConfig.lanesDir,
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
    await this.#hooks.notifyHooks(HOOKS.SESSION_CREATE, {
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
    await this.#hooks.notifyHooks(HOOKS.SESSION_SWAP, {
      oldAgent: oldAgent ?? undefined,
      newAgent,
    });
    return newAgent;
  }

  getAgent(): AgentLike | undefined {
    return this.#store.getAgent(this.#currentSessionId!);
  }

  /**
   * Branch a session (/fork command): build a new agent from the source's original build config,
   * copy its non-system messages minus the last `turnsBack` turns, and switch this manager to the new session.
   *
   * Kept messages ride `addMessage` (not replaceContext) so CONTEXT_MESSAGE fires and the session-log extension
   * writes the new session's log live -- persistence stays in the extension, so `--no-log` is honored and no core
   * JSONL writer is needed. The source session is untouched.
   *
   * `sessionId` is stripped from the metadata config: it may carry the `--session` id of a resumed run,
   * and an adopted id would make the fork append to the source's log.
   *
   * The optional `/fork` prompt is NOT enqueued here: each UI enqueues it after re-targeting its
   * channel/socket onto the fork (interactive CLI `.then()`, webui after sessionCreated + replay),
   * so the fork's first output can never fire before anyone is listening. `parseForkArg` is shared.
   */
  async forkSession(
    sourceSessionId: string,
    opts: { turnsBack: number },
  ): Promise<ForkSessionResult> {
    const entry = this.#sessions.get(sourceSessionId);
    if (!entry) {
      throw new AgentError(`Cannot fork unknown session: ${sourceSessionId}`);
    }
    // UI servers (e.g. the webui ws layer) may call this directly, bypassing the bus's
    // SESSION_MUTATING_COMMANDS guard; the same invariant applies mid-turn.
    if (entry.bus.isRunning) {
      throw new AgentError(
        `Cannot fork ${sourceSessionId} while the session is running.`,
      );
    }

    const nonSystem = entry.agent.getMessages().filter((m) => m.role !== "system");
    const { kept, droppedTurns } = trimTurns(nonSystem, opts.turnsBack);

    // The fork's own metadata: stripped and copied, so the stored entry never aliases the
    // source's object or carries its sessionId into SESSION_CREATE / later re-forks.
    const forkMeta = { ...entry.metadata, sessionId: undefined };

    // Captured before the swap below so SESSION_SWAP keeps its contract ("who was current
    // before this switch") even though current already points at the fork when it fires.
    const oldAgent = this.#currentSessionId
      ? this.#store.getAgent(this.#currentSessionId)
      : undefined;

    const newAgent = await this.#buildAgent(forkMeta);
    this.#store.addAgent(newAgent);
    this.#createSessionEntry(newAgent.sessionId, newAgent, forkMeta);
    // Mirror create(): current points at the new session before SESSION_CREATE fires.
    this.#currentSessionId = newAgent.sessionId;
    await this.#hooks.notifyHooks(HOOKS.SESSION_CREATE, {
      session: this,
      sessionId: newAgent.sessionId,
      config: forkMeta,
    });

    for (const msg of kept) {
      newAgent.addMessage(msg);
    }

    // The swap switchSession() would have performed, fired the same fire-and-forget way.
    this.#hooks.notifyHooks(HOOKS.SESSION_SWAP, { oldAgent, newAgent });
    return { sessionId: newAgent.sessionId, droppedTurns };
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
    const existed = this.#sessions.has(sessionId) || this.#store.getAgent(sessionId) !== undefined;

    const entry = this.#sessions.get(sessionId);
    if (entry) {
      entry.bus.cancel();
      this.#sessions.delete(sessionId);
    }

    // Cascade: abort any subagent tasks this session delegated so they stop
    // burning tokens with no session left to receive their results. Only this
    // session's tasks are interrupted; tasks owned by other sessions survive.
    // (No-op when this SessionManager owns no TaskManager.)
    this.#taskManager?.interruptTasksForSession(sessionId);

    this.#eventHandlers.delete(sessionId);
    this.#questionBuffers.delete(sessionId);

    // Teardown notice for extensions, fire-and-forget
    if (existed) {
      this.#hooks.notifyHooks(HOOKS.SESSION_END, { sessionId });
    }

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

  enqueue(sessionId: string, text: string, opts?: { steering?: boolean }): void {
    const entry = this.#sessions.get(sessionId);
    if (entry) {
      entry.bus.enqueue(text, opts);
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
        } catch (e) {
          // A throwing channel handler must not abort the others, but it must
          // not vanish either (AGENTS.md: every catch goes through formatError).
          logger.debug(
            `[session ${sessionId}] channel event handler error: ${formatError(e)}`,
          );
        }
      }
    } else if (event.type === OUTPUT_EVENT.QUESTION && event.questions) {
      if (!this.#questionBuffers.has(sessionId)) {
        this.#questionBuffers.set(sessionId, []);
      }
      this.#questionBuffers.get(sessionId)!.push(event.questions);
    }
  }

  /** Clears the buffer; callers replay the returned questions to newly connected channels. */
  drainPendingQuestions(sessionId: string): QuestionDef[][] {
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
      lanes: this.#turnLanes ?? undefined,
    });

    if (agent.sink === null || agent.sink === undefined) {
      agent.sink = internalSink;
    }

    agent.enqueueCallback = (text, opts) => bus.enqueue(text, opts);
    agent.forkSession = (opts) => this.forkSession(sessionId, opts);

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
