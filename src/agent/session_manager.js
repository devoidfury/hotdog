// Session lifecycle management.
//
// Owns the SessionBuilder and current Agent, enabling agent swaps
// (e.g., for profile switching) without reconstructing the builder.
//
// This is the key abstraction that decouples the UI layer from
// the Agent type. The UI holds a SessionManager and can
// create/swap agents through it.

import { SessionStore } from "./session_store.js";

/**
 * Manages the session lifecycle: owns the builder and current agent.
 *
 * Provides methods to get the current agent and construct new agents
 * (for profile switches, multi-agent sessions, etc.).
 */
export class SessionManager {
  /**
   * Create a new SessionManager with an initial agent built from the builder.
   * @param {import("./session_builder.js").SessionBuilder} builder - The session builder
   * @param {import("../context/output.js").OutputSink} sink - Output sink for the initial agent
   * @returns {Promise<SessionManager>} The constructed session manager
   */
  static async create(builder, sink) {
    const instance = new SessionManager();
    instance._builder = builder;
    instance._store = new SessionStore(
      await builder.buildAgent(sink),
    );
    instance._currentSessionId = instance._store.initialSessionId();
    return instance;
  }

  /**
   * Private constructor — use SessionManager.create() instead.
   */
  constructor() {
  }

  /**
   * Create a new agent with a custom sink and add it to the store.
   * Returns the session ID of the new agent.
   */
  async newSession(sink) {
    const agent = await this._builder.buildAgent(sink);
    const sessionId = this._store.addAgent(agent);
    this._currentSessionId = sessionId;
    return sessionId;
  }

  /**
   * Get the current agent.
   */
  getAgent() {
    return this._store.getAgent(this._currentSessionId);
  }

  /**
   * Get an agent by session ID.
   */
  getAgentBySessionId(sessionId) {
    return this._store.getAgent(sessionId);
  }

  /**
   * Get the current agent as a clone of the agent reference.
   */
  agentClone() {
    return this.getAgent();
  }

  /**
   * Replace the current agent's output sink.
   */
  setSink(sink) {
    const agent = this.getAgent();
    if (agent) {
      agent.setSink(sink);
    }
  }

  /**
   * Construct a new agent and swap it in, replacing the current one.
   *
   * The closure receives the builder so it can construct
   * the new agent with any custom configuration (sink, etc.).
   *
   * Returns the new agent.
   */
  async swapAgent(factory) {
    const agent = await factory(this._builder);
    this._store.addAgent(agent);
    this._currentSessionId = agent.sessionId;
    return agent;
  }

  /**
   * Switch to a different session by ID.
   * Returns the agent for that session, or null if not found.
   */
  switchSession(sessionId) {
    const agent = this._store.getAgent(sessionId);
    if (agent) {
      this._currentSessionId = sessionId;
    }
    return agent;
  }

  /**
   * Get a reference to the builder.
   */
  builder() {
    return this._builder;
  }

  /**
   * Get the session ID of the current agent.
   */
  sessionId() {
    return this._currentSessionId;
  }

  /**
   * Get the session store.
   */
  store() {
    return this._store;
  }
}
