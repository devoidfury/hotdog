// Tests for the core session manager and session store.

import { SessionManager, SessionStore } from '../../src/core/session/index.ts';
import { Agent } from '../../src/core/agent.ts';
import type { AgentLike } from '../../src/core/session/index.ts';
import { createHooks, HookSystem } from '../../src/core/hooks.ts';
import { ExtensionLoader } from '../../src/core/extensions/extensions.ts';
import { createToolRegistry } from '../../src/core/extensions/tool-registry.ts';
import { createServiceRegistry } from '../../src/core/extensions/service-registry.ts';
import { ConfigRegistry } from '../../src/core/extensions/config.ts';
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
    contextLimit: 128000,
    ...options,
  });
}

describe('SessionManager.create (static)', () => {
  it('should create a SessionManager with an initial agent', async () => {
    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    const extensions = new ExtensionLoader({ hooks, toolRegistry, services: createServiceRegistry(), configRegistry: new ConfigRegistry(), cliSubcommandRegistry: createSubcommandRegistry() });

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

    expect(sessionManager.sessionId()).toBeDefined();
    expect(typeof sessionManager.sessionId()).toBe('string');
    expect((sessionManager.getAgent() as any).model).toBe('initial-model');
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
    extensions = new ExtensionLoader({ hooks, toolRegistry, services: createServiceRegistry(), configRegistry: new ConfigRegistry(), cliSubcommandRegistry: createSubcommandRegistry() });

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
    it('should create a new agent, set current session, and pass config to buildAgent', async () => {
      const sessionId = await sessionManager.create({ model: 'test-model' });
      expect(typeof sessionId).toBe('string');
      expect(sessionManager.sessionId()).toBe(sessionId);
      expect((sessionManager.getAgent() as any).model).toBe('test-model');
    });
  });

  describe('swap', () => {
    it('should swap to a new agent with new config and emit hook', async () => {
      await sessionManager.create({ model: 'model-1' });
      const oldSessionId = sessionManager.sessionId();

      let hookFired = false;
      hooks.on('session:swap', () => { hookFired = true; });

      const newAgent = await sessionManager.swap({ model: 'model-2' });
      expect((newAgent as any).model).toBe('model-2');
      expect(sessionManager.sessionId()).not.toBe(oldSessionId);
      expect(hookFired).toBe(true);
    });
  });

  describe('switchSession', () => {
    it('should switch to an existing session', async () => {
      await sessionManager.create({ model: 'model-1' });
      const session1 = sessionManager.sessionId()!;
      await sessionManager.swap({ model: 'model-2' });

      const agent = sessionManager.switchSession(session1);
      expect((agent as any).model).toBe('model-1');
      expect(sessionManager.sessionId()).toBe(session1);
    });

    it('should return undefined for non-existent session', () => {
      expect(sessionManager.switchSession('non-existent')).toBeUndefined();
    });
  });

  describe('getAgentBySessionId', () => {
    it('should return agent for a specific session ID', async () => {
      await sessionManager.create({ model: 'test-model' });
      const sessionId = sessionManager.sessionId()!;
      const agent = sessionManager.getAgentBySessionId(sessionId);
      expect((agent as any).model).toBe('test-model');
    });

    it('should return undefined for non-existent session ID', () => {
      expect(sessionManager.getAgentBySessionId('non-existent')).toBeUndefined();
    });
  });

  describe('sessionIds / sessionCount', () => {
    it('should track session IDs and count', async () => {
      expect(sessionManager.sessionIds()).toEqual([]);
      expect(sessionManager.sessionCount()).toBe(0);

      await sessionManager.create({ model: 'model-1' });
      expect(sessionManager.sessionIds()).toHaveLength(1);
      expect(sessionManager.sessionCount()).toBe(1);

      await sessionManager.swap({ model: 'model-2' });
      expect(sessionManager.sessionIds()).toHaveLength(2);
      expect(sessionManager.sessionCount()).toBe(2);
    });
  });

  describe('serialize / deserialize', () => {
    it('should serialize and deserialize sessions', async () => {
      await sessionManager.create({ model: 'test-model' });
      const sessionId = sessionManager.sessionId()!;

      const serialized = sessionManager.serialize();
      expect(typeof serialized).toBe('object');

      const newSm = new SessionManager({
        hooks: hooks as any,
        extensions,
        buildAgent,
      });

      const agent = await newSm.deserialize(serialized as Record<string, unknown>);
      expect((agent as any).model).toBe('test-model');
      expect(newSm.sessionIds()).toContain(sessionId);
    });

    it('should return null when no active agent', () => {
      expect(sessionManager.serialize()).toBeNull();
    });
  });

  describe('cancel', () => {
    it('should cancel a session bus', async () => {
      const sessionId = await sessionManager.create({ model: 'test-model' });
      sessionManager.cancel(sessionId);
      expect(sessionManager.getBus(sessionId)!.isCancelled).toBe(true);
    });

    it('should be no-op for non-existent session', () => {
      expect(() => sessionManager.cancel('non-existent')).not.toThrow();
    });
  });

  describe('interrupt', () => {
    it('should interrupt a session bus', async () => {
      const sessionId = await sessionManager.create({ model: 'test-model' });
      const bus = sessionManager.getBus(sessionId)!;
      bus.enqueue('message');
      expect(bus.isIdle()).toBe(false);
      sessionManager.interrupt(sessionId);
      expect(bus.isIdle()).toBe(true);
    });

    it('should be no-op for non-existent session', () => {
      expect(() => sessionManager.interrupt('non-existent')).not.toThrow();
    });
  });

  describe('getSessionInfo', () => {
    it('should return session metadata', async () => {
      const sessionId = await sessionManager.create({ model: 'test-model' });
      expect(sessionManager.getSessionInfo(sessionId)).toEqual({
        id: sessionId,
        model: 'test-model',
        profile: undefined,
      });
    });

    it('should return null for non-existent session', () => {
      expect(sessionManager.getSessionInfo('non-existent')).toBeNull();
    });
  });

  describe('isSessionRunning', () => {
    it('should return false for idle and non-existent sessions', async () => {
      const sessionId = await sessionManager.create({ model: 'test-model' });
      expect(sessionManager.isSessionRunning(sessionId)).toBe(false);
      expect(sessionManager.isSessionRunning('non-existent')).toBe(false);
    });
  });

  describe('registerAgent', () => {
    it('should register a pre-built agent without overriding current session', async () => {
      await sessionManager.create({ model: 'cli-model' });
      const cliSessionId = sessionManager.sessionId();

      const preBuiltAgent = createMockAgent({ model: 'ws-model', sessionId: 'ws-session' });
      const registeredId = sessionManager.registerAgent(preBuiltAgent, { profile: 'ws' });

      expect(registeredId).toBe('ws-session');
      expect(sessionManager.sessionId()).toBe(cliSessionId); // current session unchanged
      expect(sessionManager.getAgentBySessionId('ws-session')).toBe(preBuiltAgent);
    });
  });

  describe('deleteSession', () => {
    it('should delete session and return true', async () => {
      const sessionId = await sessionManager.create({ model: 'test-model' });
      expect(sessionManager.sessionCount()).toBe(1);

      const deleted = sessionManager.deleteSession(sessionId);
      expect(deleted).toBe(true);
      expect(sessionManager.sessionCount()).toBe(0);
      expect(sessionManager.getAgentBySessionId(sessionId)).toBeUndefined();
    });

    it('should return false for non-existent session', () => {
      const deleted = sessionManager.deleteSession('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('getStore', () => {
    it('should return the session store', async () => {
      await sessionManager.create({ model: 'test-model' });
      const store = sessionManager.getStore();
      expect(store).toBeInstanceOf(SessionStore);
      expect(store.size()).toBe(1);
    });
  });

  describe('getBus', () => {
    it('should return the message bus for a session', async () => {
      const sessionId = await sessionManager.create({ model: 'test-model' });
      const bus = sessionManager.getBus(sessionId);
      expect(typeof bus?.enqueue).toBe('function');
    });

    it('should return undefined for non-existent session', () => {
      expect(sessionManager.getBus('non-existent')).toBeUndefined();
    });
  });

  describe('getTaskManager', () => {
    it('should return null when no task manager is configured', () => {
      expect(sessionManager.getTaskManager()).toBeNull();
    });
  });
});

// SessionStore tests moved to session-store.test.ts
