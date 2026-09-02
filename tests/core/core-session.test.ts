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
import { createCompletionService } from '../../src/core/completion.ts';
import { TASK_STATUS } from '../../src/core/session/task-manager.ts';
import { describe, it, expect, beforeEach } from 'bun:test';
import { MockLLMClient } from '../helpers.ts';

// Poll until a condition holds (fails loudly on timeout) instead of a
// fixed sleep, which is racy under parallel test load.
async function settle(fn: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 1));
  }
}

// Helper to create a minimal agent
function createMockAgent(options: Record<string, unknown> = {}): AgentLike {
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
    config: { maxToolCallsPerIteration: 10, maxRetries: 5, toolRetryDelay: 1 },
    ...options,
  }) as unknown as AgentLike;
}

describe('SessionManager.create (static)', () => {
  it('should create a SessionManager with an initial agent', async () => {
    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    const extensions = new ExtensionLoader({ hooks, toolRegistry, services: createServiceRegistry(), configRegistry: new ConfigRegistry(), cliSubcommandRegistry: createSubcommandRegistry(), completion: createCompletionService() });

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
    extensions = new ExtensionLoader({ hooks, toolRegistry, services: createServiceRegistry(), configRegistry: new ConfigRegistry(), cliSubcommandRegistry: createSubcommandRegistry(), completion: createCompletionService() });

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

    it('should emit SESSION_SWAP with the previously active agent as oldAgent', async () => {
      const session1 = await sessionManager.create({ model: 'model-1' });
      await sessionManager.swap({ model: 'model-2' });

      let payload: { oldAgent?: { model: string }; newAgent: { model: string } } | null = null;
      hooks.on('session:swap', (data: unknown) => {
        payload = data as typeof payload;
      });

      const agent = sessionManager.switchSession(session1);
      expect((agent as any).model).toBe('model-1');
      expect(payload).not.toBeNull();
      expect((payload!.newAgent as any).model).toBe('model-1');
      // oldAgent is the session that was current before the switch,
      // NOT the switch target (which was previously misreported).
      expect((payload!.oldAgent as any).model).toBe('model-2');
      expect(payload!.oldAgent).not.toBe(agent);
    });

    it('should emit SESSION_SWAP with no oldAgent when switching from an empty manager', async () => {
      // Register an agent without making any session current first.
      const agent = createMockAgent({ model: 'standalone', hooks });
      sessionManager.registerAgent(agent as any);
      const sessionId = (agent as any).sessionId;

      let payload: { oldAgent?: unknown; newAgent: unknown } | null = null;
      hooks.on('session:swap', (data: unknown) => {
        payload = data as typeof payload;
      });

      sessionManager.switchSession(sessionId);
      expect(payload).not.toBeNull();
      expect(payload!.oldAgent).toBeUndefined();
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

  describe('serialize', () => {
    it('should serialize the active session', async () => {
      await sessionManager.create({ model: 'test-model' });

      const serialized = sessionManager.serialize();
      expect(typeof serialized).toBe('object');
      expect((serialized as Record<string, unknown>).model).toBe('test-model');
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

describe('deleteSession cascades to subagent tasks', () => {
  it('aborts the deleted session\'s tasks; other sessions\' tasks survive', async () => {
    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    const extensions = new ExtensionLoader({ hooks, toolRegistry, services: createServiceRegistry(), configRegistry: new ConfigRegistry(), cliSubcommandRegistry: createSubcommandRegistry(), completion: createCompletionService() });

    // A TaskManager only exists when taskConfig + llmClient + modelRegistry
    // are all present, so build a dedicated manager (the beforeEach one has
    // no taskConfig).
    const llmClient = new MockLLMClient();

    // run() stays pending until the TaskManager's abortSignal fires (it is
    // assigned before run() is called), so tasks stay RUNNING until aborted.
    const buildAgent = async () =>
      ({
        sessionId: crypto.randomUUID(),
        model: 'test-model',
        abortSignal: null as AbortSignal | null,
        sink: null,
        enqueueCallback: null,
        run: function (this: { abortSignal: AbortSignal }) {
          return new Promise((_resolve: (v?: unknown) => void, reject: (e: Error) => void) => {
            if (this.abortSignal.aborted) {
              reject(new Error('aborted'));
              return;
            }
            this.abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        },
        cancel: () => {},
        resetCancel: () => {},
        notifyCompletion: () => {},
      }) as any;

    const sm = new SessionManager({
      hooks: hooks as any,
      extensions,
      buildAgent,
      llmClient: llmClient as any,
      modelRegistry: { 'test-model': {} } as any,
      taskConfig: { maxIterations: 100, taskProfile: 'task-default', taskRole: '' },
    });

    const sessionA = await sm.create({ model: 'test-model' });
    const sessionB = await sm.create({ model: 'test-model' });

    const tm = sm.getTaskManager()!;
    expect(tm).not.toBeNull();
    await tm.spawnTask('task-a', 'work', { managerAgent: { sessionId: sessionA } });
    await tm.spawnTask('task-b', 'work', { managerAgent: { sessionId: sessionB } });
    await settle(() => tm.activeTasks().length === 2, 'both tasks running');

    expect(sm.deleteSession(sessionA)).toBe(true);

    await settle(() => tm.taskStatus('task-a') === TASK_STATUS.CANCELLED, 'task-a -> CANCELLED');
    // task-b belongs to the surviving session; the cascade must not touch it.
    expect(tm.taskStatus('task-b')).toBe(TASK_STATUS.RUNNING);

    // Clean up so no run promises stay pending. (task-a's cancelled result
    // has no bus to land on -- the session is gone -- and is dropped quietly.)
    tm.interruptTask('task-b');
    await settle(() => tm.activeTasks().length === 0, 'task-b cleanup');
  });
});

// SessionStore tests moved to session-store.test.ts
