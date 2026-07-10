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
  _agents: Map<string, AgentLike>;
  _initialSessionId: string | null;

  /**
   * @param options
   * @param options.initialSessionId - Optional initial session ID
   */
  constructor(options: { initialSessionId?: string } = {}) {
    this._agents = new Map();
    this._initialSessionId = options.initialSessionId || null;
  }

  /**
   * Add an agent to the store.
   * @param agent - Agent instance.
   * @returns Session ID.
   */
  addAgent(agent: AgentLike): string {
    const sessionId = agent.sessionId || crypto.randomUUID();
    this._agents.set(sessionId, agent);
    if (!this._initialSessionId) {
      this._initialSessionId = sessionId;
    }
    return sessionId;
  }

  /**
   * Get an agent by session ID.
   * @param sessionId - Session ID.
   * @returns Agent instance or undefined.
   */
  getAgent(sessionId: string): AgentLike | undefined {
    return this._agents.get(sessionId);
  }

  /**
   * Get the initial session ID.
   * @returns Initial session ID or null.
   */
  initialSessionId(): string | null {
    return this._initialSessionId;
  }

  /**
   * Get the number of agents in the store.
   * @returns Agent count.
   */
  size(): number {
    return this._agents.size;
  }

  /**
   * Remove an agent from the store.
   * @param sessionId - Session ID.
   * @returns True if agent was removed.
   */
  removeAgent(sessionId: string): boolean {
    if (!this._agents.has(sessionId)) return false;
    this._agents.delete(sessionId);
    return true;
  }

  /**
   * Get all agents in the store.
   * @returns Array of agent instances.
   */
  agents(): AgentLike[] {
    return Array.from(this._agents.values());
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
  _hooks: SessionManagerOptions["hooks"];
  _extensions: unknown;
  _buildAgent: (config: Record<string, unknown>) => Promise<AgentLike>;
  _serializer: Serializer | null;
  _store: SessionStore;
  _currentSessionId: string | null;

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
      const sessionId = instance._store.addAgent(agent);
      instance._currentSessionId = sessionId;
    }

    return instance;
  }

  constructor(options: SessionManagerOptions) {
    this._hooks = options.hooks;
    this._extensions = options.extensions;
    this._buildAgent = options.buildAgent;
    this._serializer = options.serializer || null;
    this._store = new SessionStore();
    this._currentSessionId = null;
  }

  // ── Session Lifecycle ─────────────────────────────────────────────────────

  /**
   * Create a new agent and add it to the store.
   * @param config — Agent config.
   * @returns Session ID.
   */
  async create(config: Record<string, unknown>): Promise<string> {
    const agent = await this._buildAgent(config);
    const sessionId = this._store.addAgent(agent);
    this._currentSessionId = sessionId;
    await this._hooks.notifyHooksAsync(HOOKS.SESSION_CREATE, {
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
    const oldAgent = this._store.getAgent(this._currentSessionId!);
    const newAgent = await this._buildAgent(config);
    this._store.addAgent(newAgent);
    this._currentSessionId = newAgent.sessionId;
    await this._hooks.notifyHooksAsync(HOOKS.SESSION_SWAP, {
      oldAgent,
      newAgent,
    });
    return newAgent;
  }

  /**
   * Get the current agent.
   * @returns Agent instance or undefined.
   */
  getAgent(): AgentLike | undefined {
    return this._store.getAgent(this._currentSessionId!);
  }

  /**
   * Get an agent by session ID.
   * @param sessionId
   * @returns Agent instance or undefined.
   */
  getAgentBySessionId(sessionId: string): AgentLike | undefined {
    return this._store.getAgent(sessionId);
  }

  /**
   * Switch to a different session by ID.
   * @param sessionId
   * @returns Agent instance or undefined.
   */
  switchSession(sessionId: string): AgentLike | undefined {
    const agent = this._store.getAgent(sessionId);
    if (agent) {
      this._currentSessionId = sessionId;
      this._hooks.notifyHooks(HOOKS.SESSION_SWAP, {
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
    return this._currentSessionId;
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  /**
   * Serialize the current agent state.
   * @returns Serialized state, or null if no agent is active.
   */
  serialize(): Record<string, unknown> | null {
    const agent = this.getAgent();
    if (!agent) return null;
    if (this._serializer) {
      return this._serializer.serialize(agent);
    }
    return agent.serialize();
  }

  /**
   * Deserialize agent state from persisted data.
   * @param data
   * @returns The deserialized agent
   */
  async deserialize(data: Record<string, unknown>): Promise<AgentLike> {
    await this._hooks.notifyHooksAsync(HOOKS.SESSION_DESERIALIZE, { data });

    const agent = await this._buildAgent({ model: data.model });
    agent.deserialize(data);
    this._store.addAgent(agent);
    this._currentSessionId = data.sessionId as string;
    return agent;
  }

  // ── Store Access ──────────────────────────────────────────────────────────

  /**
   * Get the session store.
   */
  getStore(): SessionStore {
    return this._store;
  }

  /**
   * Get all session IDs.
   */
  sessionIds(): string[] {
    return Array.from(this._store._agents.keys());
  }

  /**
   * Get the number of sessions.
   */
  sessionCount(): number {
    return this._store.size();
  }
}
