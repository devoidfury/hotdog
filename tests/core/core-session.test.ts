// Tests for the core session manager.

import { SessionManager } from '../../src/core/session/index.ts';
import { Agent } from '../../src/core/agent.ts';
import { createHooks, HookSystem } from '../../src/core/hooks.ts';
import { ExtensionLoader } from '../../src/core/extensions/extensions.ts';
import { createToolRegistry } from '../../src/core/extensions/tool-registry.ts';
import { createServiceRegistry } from '../../src/core/extensions/service-registry.ts';
import { createConfigRegistry } from '../../src/core/extensions/config-registry.ts';
import { createSubcommandRegistry } from '../../src/core/extensions/registries.ts';
import { describe, it, expect, beforeEach } from 'bun:test';
import { MockLLMClient } from '../helpers.ts';

// Helper to create a minimal agent
function createMockAgent(options: Record<string, unknown> = {}) {
  const hooks = (options.hooks as HookSystem) || createHooks();
  const toolRegistry = (options.toolRegistry as any) || createToolRegistry();
  const llmClient = (options.llmClient as MockLLMClient) || new MockLLMClient();

  return new Agent({
    hooks,
    toolRegistry,
    llmClient: llmClient as any,
    model: (options.model as string) || 'test-model',
    sessionId: (options.sessionId as string) || crypto.randomUUID(),
    maxIterations: 100,
    maxTokens: 4096,
    ...options,
  });
}

describe('SessionManager.create (static)', () => {
  it('should create a SessionManager with an initial agent', async () => {
    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    const extensions = new ExtensionLoader({ hooks, toolRegistry, services: createServiceRegistry(), configRegistry: createConfigRegistry(), cliSubcommandRegistry: createSubcommandRegistry() });

    const buildAgent = async (config: Record<string, unknown>) => {
      return createMockAgent({
        model: (config as any).model || 'test-model',
        hooks,
        toolRegistry,
      });
    };

    const sessionManager = await SessionManager.create({
      hooks: hooks as any,
      extensions,
      buildAgent,
      initialConfig: { model: 'initial-model' },
    });

    expect(sessionManager).toBeDefined();
    expect(sessionManager.sessionId()).toBeDefined();
    const agent = sessionManager.getAgent();
    expect(agent).toBeDefined();
    expect((agent as any).model).toBe('initial-model');
  });

  it('should create without initial agent when buildAgent is not provided', async () => {
    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    const extensions = new ExtensionLoader({ hooks, toolRegistry, services: createServiceRegistry(), configRegistry: createConfigRegistry(), cliSubcommandRegistry: createSubcommandRegistry() });

    const sessionManager = await SessionManager.create({
      hooks: hooks as any,
      extensions,
      buildAgent: async () => createMockAgent(),
    });

    expect(sessionManager).toBeDefined();
    expect(sessionManager.getAgent()).toBeDefined();
  });
});

describe('SessionManager', () => {
  let hooks: HookSystem;
  let extensions: ExtensionLoader;
  let toolRegistry: any;
  let buildAgent: (config: Record<string, unknown>) => Promise<any>;
  let sessionManager: SessionManager;

  beforeEach(() => {
    hooks = createHooks();
    toolRegistry = createToolRegistry();
    extensions = new ExtensionLoader({ hooks, toolRegistry, services: createServiceRegistry(), configRegistry: createConfigRegistry(), cliSubcommandRegistry: createSubcommandRegistry() });

    buildAgent = async (config: Record<string, unknown>) => {
      return createMockAgent({
        model: (config as any).model || 'test-model',
        hooks,
        toolRegistry,
      });
    };

    sessionManager = new SessionManager({
      hooks: hooks as any,
      extensions,
      buildAgent,
    });
  });

  describe('create', () => {
    it('should create a new agent and return session ID', async () => {
      const sessionId = await sessionManager.create({ model: 'test-model' });
      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');
    });

    it('should set the current session', async () => {
      const sessionId = await sessionManager.create({ model: 'test-model' });
      expect(sessionManager.sessionId()).toBe(sessionId);
    });

    it('should call buildAgent with config', async () => {
      const customBuildAgent = async (config: Record<string, unknown>) => {
        return createMockAgent({
          model: (config as any).model || 'default',
          hooks,
          toolRegistry,
        });
      };

      const sm = new SessionManager({ hooks: hooks as any, extensions, buildAgent: customBuildAgent });
      const sessionId = await sm.create({ model: 'custom-model' });
      expect(sessionId).toBeDefined();
    });
  });

  describe('sessionId', () => {
    it('should return the current session ID', async () => {
      const sessionId = await sessionManager.create({ model: 'test-model' });
      expect(sessionManager.sessionId()).toBe(sessionId);
    });

    it('should return null when no session is active', () => {
      expect(sessionManager.sessionId()).toBeNull();
    });
  });

  describe('getAgent', () => {
    it('should return the agent for the current session', async () => {
      await sessionManager.create({ model: 'test-model' });
      const agent = sessionManager.getAgent();
      expect(agent).toBeDefined();
    });

    it('should return undefined when no session is active', () => {
      const agent = sessionManager.getAgent();
      expect(agent).toBeUndefined();
    });
  });

  describe('swap', () => {
    it('should swap to a new agent with new config', async () => {
      await sessionManager.create({ model: 'model-1' });
      const oldSessionId = sessionManager.sessionId();

      const newAgent = await sessionManager.swap({ model: 'model-2' });
      expect(newAgent).toBeDefined();
      expect(sessionManager.sessionId()).not.toBe(oldSessionId);
    });

    it('should emit session:swap hook', async () => {
      let hookFired = false;
      hooks.on('session:swap', () => { hookFired = true; });

      await sessionManager.create({ model: 'model-1' });
      await sessionManager.swap({ model: 'model-2' });
      expect(hookFired).toBe(true);
    });
  });

  describe('switchSession', () => {
    it('should switch to an existing session', async () => {
      await sessionManager.create({ model: 'model-1' });
      const session1 = sessionManager.sessionId()!;
      await sessionManager.swap({ model: 'model-2' });

      const agent = sessionManager.switchSession(session1);
      expect(agent).toBeDefined();
      expect(sessionManager.sessionId()).toBe(session1);
    });

    it('should return undefined for non-existent session', async () => {
      const agent = sessionManager.switchSession('non-existent');
      expect(agent).toBeUndefined();
    });
  });

  describe('getAgentBySessionId', () => {
    it('should return agent for a specific session ID', async () => {
      await sessionManager.create({ model: 'test-model' });
      const sessionId = sessionManager.sessionId()!;
      const agent = sessionManager.getAgentBySessionId(sessionId);
      expect(agent).toBeDefined();
    });

    it('should return undefined for non-existent session ID', async () => {
      const agent = sessionManager.getAgentBySessionId('non-existent');
      expect(agent).toBeUndefined();
    });
  });

  describe('sessionIds', () => {
    it('should return all session IDs', async () => {
      await sessionManager.create({ model: 'model-1' });
      await sessionManager.swap({ model: 'model-2' });

      const ids = sessionManager.sessionIds();
      expect(ids.length).toBe(2);
    });

    it('should return empty array when no sessions', () => {
      const ids = sessionManager.sessionIds();
      expect(ids).toEqual([]);
    });
  });

  describe('sessionCount', () => {
    it('should return the number of sessions', async () => {
      expect(sessionManager.sessionCount()).toBe(0);
      await sessionManager.create({ model: 'model-1' });
      expect(sessionManager.sessionCount()).toBe(1);
      await sessionManager.swap({ model: 'model-2' });
      expect(sessionManager.sessionCount()).toBe(2);
    });
  });

  describe('serialize / deserialize', () => {
    it('should serialize and deserialize sessions', async () => {
      await sessionManager.create({ model: 'test-model' });
      const sessionId = sessionManager.sessionId()!;

      const serialized = sessionManager.serialize();
      expect(serialized).toBeDefined();

      const newSm = new SessionManager({
        hooks: hooks as any,
        extensions,
        buildAgent,
      });

      const agent = await newSm.deserialize(serialized as Record<string, unknown>);
      expect(agent).toBeDefined();
      expect(newSm.sessionIds()).toContain(sessionId);
    });

    it('should return null when serializing with no active agent', () => {
      const serialized = sessionManager.serialize();
      expect(serialized).toBeNull();
    });
  });

  describe('getStore', () => {
    it('should return the session store', () => {
      const store = sessionManager.getStore();
      expect(store).toBeDefined();
      expect(store.sessionIds).toBeDefined();
    });
  });
});
