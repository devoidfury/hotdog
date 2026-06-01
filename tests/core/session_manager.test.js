import { describe, it, expect, beforeEach } from "bun:test";
import { SessionStore } from "../../src/core/session.js";

// Mock agent
class MockAgent {
  static _counter = 0;
  constructor(sessionId) {
    this.sessionId = sessionId || `session-${++MockAgent._counter}`;
    this._sink = null;
  }
  setSink(sink) {
    this._sink = sink;
  }
  getSink() {
    return this._sink;
  }
}

// Mock session builder
class MockBuilder {
  async buildAgent() {
    const agent = new MockAgent();
    return agent;
  }
}

// Mock output sink
class MockSink {
  constructor() {
    this.events = [];
  }
  emit(event) {
    this.events.push(event);
  }
}

describe("SessionManager", () => {
  let builder, sink, manager;

  beforeEach(async () => {
    builder = new MockBuilder();
    sink = new MockSink();
    const initialAgent = await builder.buildAgent();
    const store = new SessionStore();
    const sessionId = store.addAgent(initialAgent);
    manager = {
      _store: store,
      _currentSessionId: sessionId,
      _builder: builder,
      getAgent() {
        return this._store.getAgent(this._currentSessionId);
      },
      getAgentBySessionId(id) {
        return this._store.getAgent(id) ?? null;
      },
      sessionId() {
        return this._currentSessionId;
      },
      async create(config) {
        const agent = await this._builder.buildAgent(config);
        const sid = this._store.addAgent(agent);
        this._currentSessionId = sid;
        return sid;
      },
      async swap(config) {
        const agent = await this._builder.buildAgent(config);
        this._store.addAgent(agent);
        this._currentSessionId = agent.sessionId;
        return agent;
      },
      switchSession(sessionId) {
        const agent = this._store.getAgent(sessionId);
        if (agent) this._currentSessionId = sessionId;
        return agent ?? null;
      },
      setSink(sink) {
        this.getAgent().setSink(sink);
      },
      builder() {
        return this._builder;
      },
      getStore() {
        return this._store;
      },
    };
  });

  it("creates with an initial agent", async () => {
    const agent = manager.getAgent();
    expect(agent).not.toBeNull();
    expect(agent).toBeInstanceOf(MockAgent);
  });

  it("has a session ID", () => {
    const sessionId = manager.sessionId();
    expect(sessionId).toBeDefined();
    expect(typeof sessionId).toBe("string");
  });

  it("gets agent by session ID", () => {
    const agent = manager.getAgent();
    const byId = manager.getAgentBySessionId(agent.sessionId);
    expect(byId).toBe(agent);
  });

  it("returns null for unknown session ID", () => {
    expect(manager.getAgentBySessionId("unknown-session")).toBeNull();
  });

  it("creates a new session", async () => {
    const newSink = new MockSink();
    const newSessionId = await manager.create({});
    expect(newSessionId).toBeDefined();
    expect(manager.sessionId()).toBe(newSessionId);
    const newAgentRetrieved = manager.getAgentBySessionId(newSessionId);
    expect(newAgentRetrieved).not.toBeNull();
    // Set sink on the newly created agent and verify it
    newAgentRetrieved.setSink(newSink);
    expect(newAgentRetrieved.getSink()).toBe(newSink);
  });

  it("switches to a different session", async () => {
    const agent1 = manager.getAgent();
    const sessionId1 = agent1.sessionId;
    const newAgent = await builder.buildAgent();
    const sessionId2 = await manager.create({});
    expect(sessionId2).not.toBe(sessionId1);
    expect(manager.sessionId()).toBe(sessionId2);
    const switchedAgent = manager.switchSession(sessionId1);
    expect(switchedAgent).toBe(agent1);
    expect(manager.sessionId()).toBe(sessionId1);
  });

  it("returns null when switching to unknown session", () => {
    const result = manager.switchSession("unknown-session");
    expect(result).toBeNull();
  });

  it("sets sink on current agent", () => {
    const newSink = new MockSink();
    manager.setSink(newSink);
    const agent = manager.getAgent();
    expect(agent.getSink()).toBe(newSink);
  });

  it("returns the builder", () => {
    const b = manager.builder();
    expect(b).toBeInstanceOf(MockBuilder);
  });
});

describe("SessionManager with multiple sessions", () => {
  let builder, sink, manager;

  beforeEach(async () => {
    builder = new MockBuilder();
    sink = new MockSink();
    const initialAgent = await builder.buildAgent();
    const store = new SessionStore();
    const sessionId = store.addAgent(initialAgent);
    manager = {
      _store: store,
      _currentSessionId: sessionId,
      _builder: builder,
      getAgent() {
        return this._store.getAgent(this._currentSessionId);
      },
      getAgentBySessionId(id) {
        return this._store.getAgent(id) ?? null;
      },
      sessionId() {
        return this._currentSessionId;
      },
      async create(config) {
        const agent = await this._builder.buildAgent(config);
        const sid = this._store.addAgent(agent);
        this._currentSessionId = sid;
        return sid;
      },
      async swap(config) {
        const agent = await this._builder.buildAgent(config);
        this._store.addAgent(agent);
        this._currentSessionId = agent.sessionId;
        return agent;
      },
      switchSession(sessionId) {
        const agent = this._store.getAgent(sessionId);
        if (agent) this._currentSessionId = sessionId;
        return agent ?? null;
      },
      setSink(sink) {
        this.getAgent().setSink(sink);
      },
      builder() {
        return this._builder;
      },
      getStore() {
        return this._store;
      },
    };
  });

  it("tracks multiple sessions", async () => {
    const id1 = await manager.create({});
    expect(id1).not.toBeNull();
    const id2 = await manager.create({});
    expect(id2).not.toBeNull();
    expect(id1).not.toBe(id2);
  });

  it("switches between sessions correctly", async () => {
    const agent1 = manager.getAgent();
    const id1 = agent1.sessionId;
    const id2 = await manager.create({});
    expect(id1).not.toBe(id2);
    manager.switchSession(id1);
    expect(manager.sessionId()).toBe(id1);
    expect(manager.getAgent()).toBe(agent1);
    manager.switchSession(id2);
    expect(manager.sessionId()).toBe(id2);
    expect(manager.getAgent()).not.toBeNull();
  });

  it("swapAgent replaces current agent", async () => {
    const originalAgent = manager.getAgent();
    const newAgent = await manager.swap({});
    expect(newAgent).not.toBe(originalAgent);
    expect(newAgent.sessionId).toBeDefined();
    expect(manager.sessionId()).toBe(newAgent.sessionId);
  });
});
