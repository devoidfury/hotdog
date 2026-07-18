// ToolExecutor tests — tests the tool execution pipeline independently of Agent.

import { describe, it, expect, beforeEach } from 'bun:test';
import { ToolExecutor, createToolExecutor, type ToolExecutorDeps, type ToolCall } from '../../src/core/tool-executor.ts';
import { createToolRegistry } from '../../src/core/extensions/tool-registry.ts';
import { createHooks } from '../../src/core/hooks.ts';
import { Message } from '../../src/core/context/message.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockDeps(overrides: Partial<ToolExecutorDeps> = {}): ToolExecutorDeps {
  const toolRegistry = createToolRegistry();
  const hooks = createHooks();
  const messages: Message[] = [];
  const outputs: Array<{ type: string; data: Record<string, unknown> }> = [];

  return {
    toolRegistry,
    hooks,
    addMessage: (msg: Message) => messages.push(msg),
    emitOutput: (type, data) => outputs.push({ type, data }),
    toolWhitelist: null,
    cwdBoundary: '/workspace',
    workspaceRoot: '/workspace',
    isRestoring: () => false,
    agent: { sessionId: 'test' },
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ToolExecutor', () => {
  describe('buildToolContext', () => {
    it('should include agent and config info in tool context', async () => {
      const deps = createMockDeps({
        cwdBoundary: '/b',
        workspaceRoot: '/r',
      });
      const executor = createToolExecutor(deps);

      const capturedCtx: Record<string, unknown> = {};
      const testTool = {
        toToolDef: () => ({
          type: 'function',
          function: {
            name: 'ctx_test',
            description: 'test tool',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        }),
        execute: async (_input: unknown, ctx: unknown) => {
          const getter = ctx as { get: (k: string) => unknown };
          capturedCtx.agent = getter.get('agent');
          capturedCtx.isSessionRestoring = getter.get('isSessionRestoring');
          capturedCtx.cwdBoundary = getter.get('cwdBoundary');
          capturedCtx.workspaceRoot = getter.get('workspaceRoot');
          return 'ok';
        },
      };
      deps.toolRegistry.register('ctx_test', testTool);

      await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'ctx_test', arguments: '{}' },
      }]);

      expect(capturedCtx.agent).toBe(deps.agent);
      expect(capturedCtx.isSessionRestoring).toBe(false);
      expect(capturedCtx.cwdBoundary).toBe('/b');
      expect(capturedCtx.workspaceRoot).toBe('/r');
    });

    it('should handle null config values', async () => {
      const deps = createMockDeps({
        cwdBoundary: null,
        workspaceRoot: null,
      });
      const executor = createToolExecutor(deps);

      const capturedCtx: Record<string, unknown> = {};
      const testTool = {
        toToolDef: () => ({
          type: 'function',
          function: {
            name: 'ctx_test2',
            description: 'test',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        }),
        execute: async (_input: unknown, ctx: unknown) => {
          const getter = ctx as { get: (k: string) => unknown };
          capturedCtx.cwdBoundary = getter.get('cwdBoundary');
          capturedCtx.workspaceRoot = getter.get('workspaceRoot');
          return 'ok';
        },
      };
      deps.toolRegistry.register('ctx_test2', testTool);

      await executor.execute([{
        id: 'call-2',
        type: 'function',
        function: { name: 'ctx_test2', arguments: '{}' },
      }]);

      expect(capturedCtx.cwdBoundary).toBeNull();
      expect(capturedCtx.workspaceRoot).toBeNull();
    });

    it('should reflect dynamic isRestoring state', async () => {
      let restoring = false;
      const deps = createMockDeps({
        isRestoring: () => restoring,
      });
      const executor = createToolExecutor(deps);

      const capturedStates: boolean[] = [];
      const testTool = {
        toToolDef: () => ({
          type: 'function',
          function: {
            name: 'ctx_test3',
            description: 'test',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        }),
        execute: async (_input: unknown, ctx: unknown) => {
          capturedStates.push((ctx as { get: (k: string) => unknown }).get('isSessionRestoring') as boolean);
          return 'ok';
        },
      };
      deps.toolRegistry.register('ctx_test3', testTool);

      // Execute when not restoring
      await executor.execute([{
        id: 'call-3a',
        type: 'function',
        function: { name: 'ctx_test3', arguments: '{}' },
      }]);
      expect(capturedStates[0]).toBe(false);

      // Switch to restoring
      restoring = true;
      await executor.execute([{
        id: 'call-3b',
        type: 'function',
        function: { name: 'ctx_test3', arguments: '{}' },
      }]);
      expect(capturedStates[1]).toBe(true);
    });
  });

  describe('tool whitelist', () => {
    it('should reject tools not in whitelist', async () => {
      const deps = createMockDeps({
        toolWhitelist: ['allowed_tool'],
      });
      deps.toolRegistry.register('allowed_tool', {
        toToolDef: () => ({
          type: 'function',
          function: {
            name: 'allowed_tool',
            description: 'allowed',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        }),
        execute: async () => 'ok',
      });
      deps.toolRegistry.register('blocked_tool', {
        toToolDef: () => ({
          type: 'function',
          function: {
            name: 'blocked_tool',
            description: 'blocked',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        }),
        execute: async () => 'should not reach',
      });

      const executor = createToolExecutor(deps);
      const result = await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'blocked_tool', arguments: '{}' },
      }]);

      expect(result.toolResults[0]!.result).toContain('not available');
    });
  });

  describe('unknown tools', () => {
    it('should return error for unknown tool names', async () => {
      const deps = createMockDeps();
      const executor = createToolExecutor(deps);

      const result = await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'nonexistent_tool', arguments: '{}' },
      }]);

      expect(result.toolResults[0]!.result).toContain('Unknown tool');
    });
  });

  describe('invalid tool names', () => {
    it('should reject empty tool names', async () => {
      const deps = createMockDeps();
      const executor = createToolExecutor(deps);

      const result = await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: '', arguments: '{}' },
      }]);

      expect(result.toolResults[0]!.result).toContain('missing a valid name');
    });
  });

  describe('wait tool', () => {
    it('should return outcome "return" for wait tool', async () => {
      const deps = createMockDeps();
      deps.toolRegistry.register('wait', {
        toToolDef: () => ({
          type: 'function',
          function: {
            name: 'wait',
            description: 'wait',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        }),
        execute: async () => 'waiting',
      });

      const executor = createToolExecutor(deps);
      const result = await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'wait', arguments: '{}' },
      }]);

      expect(result.outcome).toBe('return');
    });
  });

  describe('hook integration', () => {
    it('should fire TOOL_BEFORE_EXECUTE and TOOL_AFTER_EXECUTE hooks', async () => {
      const deps = createMockDeps();
      const hookCalls: string[] = [];

      deps.hooks.on('tool:beforeExecute', (data: unknown) => {
        hookCalls.push('before');
      });
      deps.hooks.on('tool:afterExecute', (data: unknown) => {
        hookCalls.push('after');
      });

      deps.toolRegistry.register('hook_test', {
        toToolDef: () => ({
          type: 'function',
          function: {
            name: 'hook_test',
            description: 'test',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        }),
        execute: async () => 'ok',
      });

      const executor = createToolExecutor(deps);
      await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'hook_test', arguments: '{}' },
      }]);

      expect(hookCalls).toEqual(['before', 'after']);
    });

    it('should allow TOOL_CALL gate to block execution', async () => {
      const deps = createMockDeps();
      let toolExecuted = false;

      deps.hooks.on('tool:call', () => ({
        action: 'block',
        result: 'blocked by gate',
      }));

      deps.toolRegistry.register('gate_test', {
        toToolDef: () => ({
          type: 'function',
          function: {
            name: 'gate_test',
            description: 'test',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        }),
        execute: async () => {
          toolExecuted = true;
          return 'should not reach';
        },
      });

      const executor = createToolExecutor(deps);
      const result = await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'gate_test', arguments: '{}' },
      }]);

      expect(toolExecuted).toBe(false);
      expect(result.toolResults[0]!.result).toContain('blocked by gate');
    });

    it('should allow TOOL_CALL gate to modify input', async () => {
      const deps = createMockDeps();
      let receivedInput = '';

      deps.hooks.on('tool:call', () => ({
        action: 'modify',
        input: '{"path":"/modified"}',
      }));

      deps.toolRegistry.register('modify_test', {
        toToolDef: () => ({
          type: 'function',
          function: {
            name: 'modify_test',
            description: 'test',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        }),
        execute: async (input: unknown) => {
          receivedInput = input as string;
          return 'ok';
        },
      });

      const executor = createToolExecutor(deps);
      await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'modify_test', arguments: '{"path":"/original"}' },
      }]);

      expect(receivedInput).toBe('{"path":"/modified"}');
    });
  });

  describe('error handling', () => {
    it('should catch tool execution errors and return fallback result', async () => {
      const deps = createMockDeps();
      deps.toolRegistry.register('failing_tool', {
        toToolDef: () => ({
          type: 'function',
          function: {
            name: 'failing_tool',
            description: 'test',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        }),
        execute: async () => {
          throw new Error('boom');
        },
      });

      const executor = createToolExecutor(deps);
      const result = await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'failing_tool', arguments: '{}' },
      }]);

      expect(result.toolResults[0]!.result).toContain('Error executing tool');
      expect(result.toolResults[0]!.result).toContain('boom');
    });
  });

  describe('multiple tool calls', () => {
    it('should execute all tool calls and return results in order', async () => {
      const deps = createMockDeps();
      const executionOrder: string[] = [];

      for (const name of ['tool_a', 'tool_b', 'tool_c']) {
        const toolName = name;
        deps.toolRegistry.register(name, {
          toToolDef: () => ({
            type: 'function',
            function: {
              name: toolName,
              description: 'test',
              parameters: { type: 'object', properties: {}, required: [] },
            },
          }),
          execute: async () => {
            executionOrder.push(toolName);
            return `result of ${toolName}`;
          },
        });
      }

      const executor = createToolExecutor(deps);
      const result = await executor.execute([
        { id: 'call-1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
        { id: 'call-2', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
        { id: 'call-3', type: 'function', function: { name: 'tool_c', arguments: '{}' } },
      ]);

      expect(result.outcome).toBe('continue');
      expect(result.toolResults).toHaveLength(3);
      expect(executionOrder).toEqual(['tool_a', 'tool_b', 'tool_c']);
    });
  });
});
