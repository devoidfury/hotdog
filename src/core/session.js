// SessionManager — manages the session lifecycle.
// Owns agents, enables swaps, serialization.
// Delegates agent construction to extensions via hooks.

import { HOOKS } from './hooks.js';

/**
 * Session store — holds agents keyed by session ID.
 */
export class SessionStore {
  constructor() {
    this._agents = new Map();
    this._initialSessionId = null;
  }

  addAgent(agent) {
    const sessionId = agent.sessionId || crypto.randomUUID();
    this._agents.set(sessionId, agent);
    if (!this._initialSessionId) {
      this._initialSessionId = sessionId;
    }
    return sessionId;
  }

  getAgent(sessionId) {
    return this._agents.get(sessionId);
  }

  initialSessionId() {
    return this._initialSessionId;
  }

  size() {
    return this._agents.size;
  }
}

/**
 * Manages the session lifecycle: owns agents, enables swaps.
 */
export class SessionManager {
  /**
   * Create a new SessionManager with an initial agent.
   * @param {Object} options
   * @param {Object} options.hooks — HookSystem
   * @param {Object} options.extensions — ExtensionLoader
   * @param {Function} options.buildAgent — Function(config) → Agent
   * @param {Object} [options.serializer] — Optional session serializer
   * @param {Object} [options.initialConfig] — Config for initial agent
   * @returns {Promise<SessionManager>}
   */
  static async create(options) {
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

  constructor(options) {
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
   * @param {Object} config — Agent config
   * @returns {Promise<string>} Session ID
   */
  async create(config) {
    const agent = await this._buildAgent(config);
    const sessionId = this._store.addAgent(agent);
    this._currentSessionId = sessionId;
    await this._hooks.emitAsync(HOOKS.SESSION_CREATE, {
      session: this, config,
    });
    return sessionId;
  }

  /**
   * Construct a new agent and swap it in, replacing the current one.
   * @param {Object} config — New agent config
   * @returns {Promise<Object>} The new agent
   */
  async swap(config) {
    const oldAgent = this._store.getAgent(this._currentSessionId);
    const newAgent = await this._buildAgent(config);
    this._store.addAgent(newAgent);
    this._currentSessionId = newAgent.sessionId;
    await this._hooks.emitAsync(HOOKS.SESSION_SWAP, {
      oldAgent, newAgent,
    });
    return newAgent;
  }

  /**
   * Get the current agent.
   * @returns {Object|undefined}
   */
  getAgent() {
    return this._store.getAgent(this._currentSessionId);
  }

  /**
   * Get an agent by session ID.
   * @param {string} sessionId
   * @returns {Object|undefined}
   */
  getAgentBySessionId(sessionId) {
    return this._store.getAgent(sessionId);
  }

  /**
   * Switch to a different session by ID.
   * @param {string} sessionId
   * @returns {Object|undefined}
   */
  switchSession(sessionId) {
    const agent = this._store.getAgent(sessionId);
    if (agent) {
      this._currentSessionId = sessionId;
      this._hooks.emit(HOOKS.SESSION_SWAP, {
        oldAgent: agent, newAgent: agent,
      });
    }
    return agent;
  }

  /**
   * Get the session ID of the current agent.
   * @returns {string|undefined}
   */
  sessionId() {
    return this._currentSessionId;
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  /**
   * Serialize the current agent state.
   * @returns {Object}
   */
  serialize() {
    const agent = this.getAgent();
    if (!agent) return null;
    if (this._serializer) {
      return this._serializer.serialize(agent);
    }
    return agent.serialize();
  }

  /**
   * Deserialize agent state from persisted data.
   * @param {Object} data
   * @returns {Promise<Object>} The deserialized agent
   */
  async deserialize(data) {
    await this._hooks.emitAsync(HOOKS.SESSION_DESERIALIZE, { data });

    const agent = await this._buildAgent({ model: data.model });
    agent.deserialize(data);
    this._store.addAgent(agent);
    this._currentSessionId = data.sessionId;
    return agent;
  }

  // ── Store Access ──────────────────────────────────────────────────────────

  /**
   * Get the session store.
   */
  getStore() {
    return this._store;
  }

  /**
   * Get all session IDs.
   */
  sessionIds() {
    return Array.from(this._store._agents.keys());
  }

  /**
   * Get the number of sessions.
   */
  sessionCount() {
    return this._store.size();
  }
}
