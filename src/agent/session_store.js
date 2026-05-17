// Per-session agent storage.
//
// Owns a map of agents keyed by session ID, enabling multi-session
// modes (ACP) while remaining compatible with single-session modes (CLI).

/**
 * Stores agents for multiple sessions, keyed by session ID.
 *
 * For single-session modes (CLI), one agent is created at startup.
 * For multi-session modes (ACP), new agents are created per session.
 */
export class SessionStore {
  /**
   * Create a new store with an initial agent.
   */
  constructor(initialAgent) {
    this._agents = new Map();
    const sessionId = initialAgent.sessionId;
    this._agents.set(sessionId, initialAgent);
  }

  /**
   * Add a new agent to the store.
   * Returns the session ID of the new agent.
   */
  addAgent(agent) {
    const sessionId = agent.sessionId;
    this._agents.set(sessionId, agent);
    return sessionId;
  }

  /**
   * Get an agent by session ID.
   */
  getAgent(sessionId) {
    return this._agents.get(sessionId) || null;
  }

  /**
   * Remove an agent by session ID.
   */
  removeAgent(sessionId) {
    return this._agents.delete(sessionId);
  }

  /**
   * Get the session ID of the first (or only) agent.
   */
  initialSessionId() {
    const first = this._agents.keys().next().value;
    if (first === undefined) {
      throw new Error("SessionStore must have at least one agent");
    }
    return first;
  }

  /**
   * Get all agents.
   */
  agents() {
    return Array.from(this._agents.values());
  }

  /**
   * Get the number of agents in the store.
   */
  size() {
    return this._agents.size;
  }
}
