// SessionManager — manages the session lifecycle.

import crypto from "node:crypto";
import { HOOKS } from "../hooks.ts";

export interface AgentLike {
  sessionId: string;
  serialize(): Record<string, unknown>;
  deserialize(data: Record<string, unknown>): void;
}

export interface Serializer {
  serialize(agent: AgentLike): Record<string, unknown> | null;
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
    notifyHooksAsync(hookName: string, data: unknown): Promise<void>;
    notifyHooks(hookName: string, data: unknown): void;
  };
  extensions: unknown;
  buildAgent: (config: Record<string, unknown>) => Promise<AgentLike>;
  serializer?: Serializer | null;
  initialConfig?: Record<string, unknown>;
}

/**
 * Manages the session lifecycle: owns agents, enables swaps.
 */
export class SessionManager {
  #hooks: SessionManagerOptions["hooks"];
  #extensions: unknown;
  #buildAgent: (config: Record<string, unknown>) => Promise<AgentLike>;
  #serializer: Serializer | null;
  #store: SessionStore;
  #currentSessionId: string | null;

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
    }

    return instance;
  }

  constructor(options: SessionManagerOptions) {
    this.#hooks = options.hooks;
    this.#extensions = options.extensions;
    this.#buildAgent = options.buildAgent;
    this.#serializer = options.serializer || null;
    this.#store = new SessionStore();
    this.#currentSessionId = null;
  }

  // ── Session Lifecycle ─────────────────────────────────────────────────────

  /**
   * Create a new agent and add it to the store.
   * @param config — Agent config.
   * @returns Session ID.
   */
  async create(config: Record<string, unknown>): Promise<string> {
    const agent = await this.#buildAgent(config);
    const sessionId = this.#store.addAgent(agent);
    this.#currentSessionId = sessionId;
    await this.#hooks.notifyHooksAsync(HOOKS.SESSION_CREATE, {
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
    await this.#hooks.notifyHooksAsync(HOOKS.SESSION_SWAP, {
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
    await this.#hooks.notifyHooksAsync(HOOKS.SESSION_DESERIALIZE, { data });

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
}
