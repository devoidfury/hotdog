// Tests for the core SessionManager class.

import { SessionManager } from '../../src/core/session/index.ts';
import { Agent } from '../../src/core/agent.ts';
import { createHooks } from '../../src/core/hooks.ts';
import { ExtensionLoader, createExtensionLoader } from '../../src/core/extensions/extensions.ts';
import { createToolRegistry } from '../../src/core/extensions/tool-registry.ts';
import { Message } from '../../src/core/context/message.ts';
import { describe, it, expect, beforeEach } from 'bun:test';
import { MockLLMClient } from '../helpers.js';

// Helper to create a minimal agent
function createMockAgent(options = {}) {
  const hooks = options.hooks || createHooks();
  const toolRegistry = options.toolRegistry || createToolRegistry();
  const llmClient = options.llmClient || new MockLLMClient();

  return new Agent({
    hooks,
    toolRegistry,
    llmClient,
    model: options.model || 'test-model',
    sessionId: options.sessionId || crypto.randomUUID(),
    maxIterations: 100,
    maxTokens: 4096,
    ...options,
  });
}

describe('SessionManager.create (static)', () => {
  it('should create a SessionManager with an initial agent', async () => {
    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    const extensions = new ExtensionLoader({ hooks, toolRegistry });

    const buildAgent = async (config) => {
      return createMockAgent({
        model: config.model || 'test-model',
        hooks,
        toolRegistry,
      });
    };

    const sessionManager = await SessionManager.create({
      hooks,
      extensions,
      buildAgent,
      initialConfig: { model: 'initial-model' },
    });

    expect(sessionManager).toBeDefined();
    expect(sessionManager.sessionId()).toBeDefined();
    const agent = sessionManager.getAgent();
    expect(agent).toBeDefined();
    expect(agent.model).toBe('initial-model');
  });

  it('should create without initial agent when buildAgent is not provided', async () => {
    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    const extensions = new ExtensionLoader({ hooks, toolRegistry });

    const sessionManager = await SessionManager.create({
      hooks,
      extensions,
    });

    expect(sessionManager).toBeDefined();
    expect(sessionManager.getAgent()).toBeUndefined();
  });
});

describe('SessionManager', () => {
  let hooks;
  let extensions;
  let toolRegistry;
  let buildAgent;
  let sessionManager;

  beforeEach(() => {
    hooks = createHooks();
    toolRegistry = createToolRegistry();
    extensions = new ExtensionLoader({ hooks, toolRegistry });

    buildAgent = async (config) => {
      return createMockAgent({
        model: config.model || 'test-model',
        hooks,
        toolRegistry,
      });
    };

    sessionManager = new SessionManager({
      hooks,
      extensions,
      buildAgent,
    });
  });

  describe('create', () => {
    it('should create a new agent and return session ID', async () => {
      const sessionId = await sessionManager.create({ model: 'test-model' });
      expect(sessionId).toBeDefined();

      const agent = sessionManager.getAgent();
      expect(agent).toBeDefined();
      expect(agent.model).toBe('test-model');
      expect(sessionManager.sessionId()).toBe(sessionId);
    });

    it('should emit session:create hook', async () => {
      const emitted = [];
      hooks.on('session:create', (data) => {
        emitted.push(data);
      });

      await sessionManager.create({ model: 'test-model' });
      expect(emitted.length).toBe(1);
      expect(emitted[0].config.model).toBe('test-model');
    });
  });

  describe('swap', () => {
    it('should replace the current agent', async () => {
      await sessionManager.create({ model: 'model-1' });
      const oldAgent = sessionManager.getAgent();

      const newAgent = await sessionManager.swap({ model: 'model-2' });
      expect(newAgent.model).toBe('model-2');
      expect(sessionManager.getAgent()).toBe(newAgent);
      expect(sessionManager.getAgent()).not.toBe(oldAgent);
    });

    it('should emit session:swap hook', async () => {
      await sessionManager.create({ model: 'model-1' });

      const emitted = [];
      hooks.on('session:swap', (data) => {
        emitted.push(data);
      });

      await sessionManager.swap({ model: 'model-2' });
      expect(emitted.length).toBe(1);
      expect(emitted[0].oldAgent.model).toBe('model-1');
      expect(emitted[0].newAgent.model).toBe('model-2');
    });
  });

  describe('switchSession', () => {
    it('should switch to a different session', async () => {
      await sessionManager.create({ model: 'model-1' });
      const session1Id = sessionManager.sessionId();
      await sessionManager.create({ model: 'model-2' });
      const session2Id = sessionManager.sessionId();

      // Currently on model-2, switch to model-1
      const agent = sessionManager.switchSession(session1Id);
      expect(agent.model).toBe('model-1');
      expect(sessionManager.sessionId()).toBe(session1Id);

      // Switch back to model-2
      const agent2 = sessionManager.switchSession(session2Id);
      expect(agent2.model).toBe('model-2');
      expect(sessionManager.sessionId()).toBe(session2Id);
    });

    it('should return undefined for unknown session', () => {
      sessionManager.switchSession('nonexistent');
      expect(sessionManager.getAgent()).toBeUndefined();
    });

    it('should emit session:swap hook when switching', async () => {
      await sessionManager.create({ model: 'model-1' });
      const session1Id = sessionManager.sessionId();
      await sessionManager.create({ model: 'model-2' });
      const session2Id = sessionManager.sessionId();

      const emitted = [];
      hooks.on('session:swap', (data) => {
        emitted.push(data);
      });

      sessionManager.switchSession(session1Id);
      expect(emitted.length).toBe(1);
      expect(emitted[0].newAgent.model).toBe('model-1');
    });
  });

  describe('serialize / deserialize', () => {
    it('should serialize agent state', async () => {
      await sessionManager.create({ model: 'test-model' });
      const agent = sessionManager.getAgent();
      agent.addMessage(new Message({ role: 'user', content: 'hello' }));

      const data = sessionManager.serialize();
      expect(data.sessionId).toBeDefined();
      expect(data.model).toBe('test-model');
      expect(data.context.length).toBe(1);
    });

    it('should deserialize agent state', async () => {
      const data = {
        sessionId: 'restored-session',
        model: 'restored-model',
        context: [
          { role: 'user', content: 'hello', reasoning_content: null, tool_calls: null, tool_call_id: null },
        ],
        iterationCount: 5,
      };

      const agent = await sessionManager.deserialize(data);
      expect(agent.sessionId).toBe('restored-session');
      expect(agent.model).toBe('restored-model');
      expect(agent.log.length).toBe(1);
      expect(agent.log.at(0).content).toBe('hello');
    });

    it('should use custom serializer when provided', async () => {
      const hooks = createHooks();
      const toolRegistry = createToolRegistry();
      const extensions = new ExtensionLoader({ hooks, toolRegistry });

      const customSerializer = {
        serialize: (agent) => ({ custom: true, model: agent.model }),
      };

      const sessionManager = new SessionManager({
        hooks,
        extensions,
        buildAgent,
        serializer: customSerializer,
      });

      await sessionManager.create({ model: 'test-model' });
      const data = sessionManager.serialize();
      expect(data.custom).toBe(true);
      expect(data.model).toBe('test-model');
    });

    it('should return null when no agent to serialize', async () => {
      const hooks = createHooks();
      const toolRegistry = createToolRegistry();
      const extensions = new ExtensionLoader({ hooks, toolRegistry });

      const sessionManager = new SessionManager({
        hooks,
        extensions,
        buildAgent,
      });

      const data = sessionManager.serialize();
      expect(data).toBeNull();
    });
  });

  describe('session management', () => {
    it('should track multiple sessions', async () => {
      await sessionManager.create({ model: 'model-1' });
      await sessionManager.create({ model: 'model-2' });

      expect(sessionManager.sessionCount()).toBe(2);
      expect(sessionManager.sessionIds().length).toBe(2);
    });

    it('should get agent by session ID', async () => {
      await sessionManager.create({ model: 'model-1' });
      await sessionManager.create({ model: 'model-2' });

      const sessionIds = sessionManager.sessionIds();
      const agent1 = sessionManager.getAgentBySessionId(sessionIds[0]);
      const agent2 = sessionManager.getAgentBySessionId(sessionIds[1]);

      expect(agent1.model).toBe('model-1');
      expect(agent2.model).toBe('model-2');
    });
  });
});
