// ToolExecutor tests — tests the tool execution pipeline independently of Agent.

import { describe, it, expect } from 'bun:test';
import { ToolExecutor, createToolExecutor, type ToolExecutorDeps } from '../../src/core/tool-executor.ts';
import type { ToolCall } from '../../src/core/context/message.ts';
import { createToolRegistry } from '../../src/core/extensions/tool-registry.ts';
import { createHooks } from '../../src/core/hooks.ts';
import { Message } from '../../src/core/context/message.ts';
import { TransientError } from '../../src/core/error.ts';
import type { Tool, ToolDef } from '../../src/core/extensions/tool-registry.ts';
import { createToolFormatRegistry } from '../../src/core/extensions/tool-format.ts';
import { xmlToolFormat } from '../../src/core/extensions/tool-format-xml.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create an inline test tool with the required Tool interface methods.
 */
function makeTestTool(
  name: string,
  execute: (input: string | Record<string, unknown> | null, ctx?: unknown) => Promise<unknown>,
  toToolDefOverride?: () => ToolDef,
): Tool {
  return {
    metadata: { sideEffects: false, difficulty: 1 },
    toToolDef: toToolDefOverride || (() => ({
      type: 'function',
      function: {
        name,
        description: 'test tool',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    })),
    callDisplay: (_input: string | Record<string, unknown> | null) => `${name}()`,
    execute,
  };
}

interface MockDepsOverrides extends Partial<ToolExecutorDeps> {
  /** Simulates the whitelist that Agent.getToolDefs() applies to tool defs. */
  toolWhitelist?: string[] | null;
}

function createMockDeps(
  overrides: MockDepsOverrides = {},
): ToolExecutorDeps & { addedMessages: Message[]; outputs: Array<{ type: string; data: Record<string, unknown> }> } {
  const toolRegistry = createToolRegistry();
  const hooks = createHooks();
  const addedMessages: Message[] = [];
  const outputs: Array<{ type: string; data: Record<string, unknown> }> = [];

  const state = {
    // Whitelist applied to the mock's getToolDefs() so it mirrors what
    // Agent.getToolDefs() returns (registry filtered by whitelist/blacklist).
    whitelist: overrides.toolWhitelist ?? null,
  };

  const agent = {
    sessionId: 'test',
    addMessage: (msg: Message) => { addedMessages.push(msg); },
    // ToolExecutor checks the filtered tool defs for availability.
    getToolDefs: async (): Promise<ToolDef[]> =>
      Array.from(toolRegistry.getAll())
        .filter(([name]) => !state.whitelist || state.whitelist.includes(name))
        .map(([name]) => ({
          type: 'function',
          function: {
            name,
            description: 'test tool',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        })),
  } as unknown as import('../../src/core/agent.ts').Agent;

  return {
    toolRegistry,
    hooks,
    emitOutput: (type, data) => outputs.push({ type, data }),
    cwdBoundary: '/workspace',
    workspaceRoot: '/workspace',
    maxRetries: 3,
    toolRetryDelay: 100,
    isRestoring: () => false,
    agent,
    addedMessages,
    outputs,
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
      const testTool = makeTestTool('ctx_test', async (_input, ctx) => {
        const getter = ctx as { get: (k: string) => unknown };
        capturedCtx.agent = getter.get('agent');
        capturedCtx.isSessionRestoring = getter.get('isSessionRestoring');
        capturedCtx.cwdBoundary = getter.get('cwdBoundary');
        capturedCtx.workspaceRoot = getter.get('workspaceRoot');
        return 'ok';
      });
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
      const testTool = makeTestTool('ctx_test2', async (_input, ctx) => {
        const getter = ctx as { get: (k: string) => unknown };
        capturedCtx.cwdBoundary = getter.get('cwdBoundary');
        capturedCtx.workspaceRoot = getter.get('workspaceRoot');
        return 'ok';
      });
      deps.toolRegistry.register('ctx_test2', testTool);

      await executor.execute([{
        id: 'call-2',
        type: 'function',
        function: { name: 'ctx_test2', arguments: '{}' },
      }]);

      expect(capturedCtx.cwdBoundary).toBeNull();
      expect(capturedCtx.workspaceRoot).toBeNull();
    });

    it('should always build a Workspace, defaulting to process cwd when no boundary is set', async () => {
      const deps = createMockDeps({
        cwdBoundary: null,
        workspaceRoot: null,
      });
      const executor = createToolExecutor(deps);

      const capturedCtx: Record<string, unknown> = {};
      const testTool = makeTestTool('ctx_test4', async (_input, ctx) => {
        const getter = ctx as { get: (k: string) => unknown };
        capturedCtx.workspace = getter.get('workspace');
        return 'ok';
      });
      deps.toolRegistry.register('ctx_test4', testTool);

      await executor.execute([{
        id: 'call-4',
        type: 'function',
        function: { name: 'ctx_test4', arguments: '{}' },
      }]);

      const workspace = capturedCtx.workspace as { root: string } | null;
      expect(workspace).not.toBeNull();
      expect(workspace!.root).toBe(process.cwd());
    });

    it('should reflect dynamic isRestoring state', async () => {
      let restoring = false;
      const deps = createMockDeps({
        isRestoring: () => restoring,
      });
      const executor = createToolExecutor(deps);

      const capturedStates: boolean[] = [];
      const testTool = makeTestTool('ctx_test3', async (_input, ctx) => {
        capturedStates.push((ctx as { get: (k: string) => unknown }).get('isSessionRestoring') as boolean);
        return 'ok';
      });
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
      deps.toolRegistry.register('allowed_tool', makeTestTool('allowed_tool', async () => 'ok'));
      deps.toolRegistry.register('blocked_tool', makeTestTool('blocked_tool', async () => 'should not reach'));

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
      // The mock's getToolDefs() mirrors Agent.getToolDefs(): in reality the
      // LLM can only name tools it was offered, so a truly unknown name is
      // caught by the defs check before reaching the registry lookup.
      (deps.agent as unknown as { getToolDefs: () => Promise<never[]> }).getToolDefs = async () => [];
      const executor = createToolExecutor(deps);

      const result = await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'nonexistent_tool', arguments: '{}' },
      }]);

      expect(result.toolResults[0]!.result).toContain('not available');
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
      const { ToolResult } = await import('../../src/core/extensions/tool-utils.ts');
      deps.toolRegistry.register('wait', makeTestTool('wait', async () => ToolResult.stop('waiting')));

      const executor = createToolExecutor(deps);
      const result = await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'wait', arguments: '{}' },
      }]);

      expect(result.outcome).toBe('return');
    });

    it('should return outcome "return" for any tool that uses ToolResult.stop()', async () => {
      const { ToolResult } = await import('../../src/core/extensions/tool-utils.ts');
      const deps = createMockDeps();
      deps.toolRegistry.register('my-stopping-tool', makeTestTool('my-stopping-tool', async () => ToolResult.stop('stopping now')));

      const executor = createToolExecutor(deps);
      const result = await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'my-stopping-tool', arguments: '{}' },
      }]);

      expect(result.outcome).toBe('return');
      expect(result.toolResults[0]?.stopLoop).toBe(true);
    });

    it('should continue when tool returns ToolResult.ok()', async () => {
      const { ToolResult } = await import('../../src/core/extensions/tool-utils.ts');
      const deps = createMockDeps();
      deps.toolRegistry.register('normal-tool', makeTestTool('normal-tool', async () => ToolResult.ok('done')));

      const executor = createToolExecutor(deps);
      const result = await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'normal-tool', arguments: '{}' },
      }]);

      expect(result.outcome).toBe('continue');
      expect(result.toolResults[0]?.stopLoop).toBe(false);
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

      deps.toolRegistry.register('hook_test', makeTestTool('hook_test', async () => 'ok'));

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

      deps.toolRegistry.register('gate_test', makeTestTool('gate_test', async () => {
        toolExecuted = true;
        return 'should not reach';
      }));

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

      deps.toolRegistry.register('modify_test', makeTestTool('modify_test', async (input) => {
        receivedInput = input as string;
        return 'ok';
      }));

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
      deps.toolRegistry.register('failing_tool', makeTestTool('failing_tool', async () => {
        throw new Error('boom');
      }));

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

  describe('retry behavior', () => {
    it('should still execute the tool once when maxRetries is 0', async () => {
      let calls = 0;
      const deps = createMockDeps({ maxRetries: 0 });
      deps.toolRegistry.register('once', makeTestTool('once', async () => {
        calls++;
        return 'ran';
      }));

      const executor = createToolExecutor(deps);
      const result = await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'once', arguments: '{}' },
      }]);

      expect(calls).toBe(1);
      expect(result.toolResults[0]!.result).toContain('ran');
    });

    it('should return an error result without retrying when a transient error occurs and maxRetries is 0', async () => {
      let calls = 0;
      const deps = createMockDeps({ maxRetries: 0, toolRetryDelay: 1 });
      deps.toolRegistry.register('transient', makeTestTool('transient', async () => {
        calls++;
        throw new TransientError('flaky');
      }));

      const executor = createToolExecutor(deps);
      const result = await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'transient', arguments: '{}' },
      }]);

      expect(calls).toBe(1);
      expect(result.toolResults[0]!.result).toContain('Error executing tool');
      expect(result.toolResults[0]!.result).toContain('flaky');
    });
  });

  describe('message logging', () => {
    it('should add tool result to context via agent.addMessage', async () => {
      const deps = createMockDeps();
      deps.toolRegistry.register('echo', makeTestTool('echo', async () => 'hello from tool'));

      const executor = createToolExecutor(deps);
      await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'echo', arguments: '{}' },
      }]);

      expect(deps.addedMessages).toHaveLength(1);
      const msg = deps.addedMessages[0]!;
      expect(msg.role).toBe('tool');
      expect(msg.toolCallId).toBe('call-1');
      expect(msg.content as string).toContain('hello from tool');
    });

    it('should add error results to context via agent.addMessage', async () => {
      const deps = createMockDeps();
      deps.toolRegistry.register('boom', makeTestTool('boom', async () => {
        throw new Error('kaboom');
      }));

      const executor = createToolExecutor(deps);
      await executor.execute([{
        id: 'call-2',
        type: 'function',
        function: { name: 'boom', arguments: '{}' },
      }]);

      expect(deps.addedMessages).toHaveLength(1);
      const msg = deps.addedMessages[0]!;
      expect(msg.role).toBe('tool');
      expect(msg.toolCallId).toBe('call-2');
      expect(msg.content as string).toContain('kaboom');
    });

    it('should add a tool message for calls with an invalid name', async () => {
      const deps = createMockDeps();

      const executor = createToolExecutor(deps);
      await executor.execute([{
        id: 'call-3',
        type: 'function',
        function: { name: '', arguments: '{}' },
      }]);

      expect(deps.addedMessages).toHaveLength(1);
      expect(deps.addedMessages[0]!.role).toBe('tool');
      expect(deps.addedMessages[0]!.toolCallId).toBe('call-3');
    });

  });

  describe('multiple tool calls', () => {
    it('should execute all tool calls and return results in order', async () => {
      const deps = createMockDeps();
      const executionOrder: string[] = [];

      for (const name of ['tool_a', 'tool_b', 'tool_c']) {
        const toolName = name;
        deps.toolRegistry.register(name, makeTestTool(toolName, async () => {
          executionOrder.push(toolName);
          return `result of ${toolName}`;
        }));
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

  describe('tool format name (agent-loop per-model resolution)', () => {
    const mdTable = {
      id: 'md-table',
      markers: ['tool-result'],
      formatResult(
        result: string | Record<string, unknown>,
        toolName: string,
        meta?: { status: string; [key: string]: string },
      ): string {
        const payload = typeof result === 'string' ? result : JSON.stringify(result);
        return `| ${toolName} | ${meta?.status || 'success'} |\n\n${payload}`;
      },
    };

    function makeEchoExecutor(deps: ReturnType<typeof createMockDeps>) {
      deps.toolRegistry.register('echo', makeTestTool('echo', async () => 'hi'));
      return createToolExecutor(deps);
    }

    it('renders results with the explicitly resolved format', async () => {
      const reg = createToolFormatRegistry();
      reg.register(xmlToolFormat);
      reg.register(mdTable);

      const deps = createMockDeps();
      const executor = makeEchoExecutor(deps);
      const result = await executor.execute(
        [{ id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{}' } }],
        'md-table',
        reg,
      );
      expect(result.toolResults[0]!.result).toContain('| echo | success |');
    });

    it('falls back to the built-in xml default when no name is passed', async () => {
      const deps = createMockDeps();
      const executor = makeEchoExecutor(deps);
      const result = await executor.execute([
        { id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{}' } },
      ]);
      expect(result.toolResults[0]!.result).toContain('<tool name="echo"');
    });

    it('resolves the format from the session registry, not another session\'s', async () => {
      // md-table exists only in this executor's session registry.
      const reg = createToolFormatRegistry();
      reg.register(xmlToolFormat);
      reg.register(mdTable);

      const deps = createMockDeps();
      const executor = makeEchoExecutor(deps);
      const result = await executor.execute(
        [{ id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{}' } }],
        'md-table',
        reg,
      );
      expect(result.toolResults[0]!.result).toContain('| echo | success |');

      // Same name against a registry without md-table is a config error at
      // the seam; execute() converts it to a tool error result (never a
      // silent fallback to another session's format).
      const emptyReg = createToolFormatRegistry();
      const result2 = await executor.execute(
        [{ id: 'call-2', type: 'function', function: { name: 'echo', arguments: '{}' } }],
        'md-table',
        emptyReg,
      );
      expect(result2.toolResults[0]!.result).toContain(
        'Tool execution failed: Unknown tool format "md-table"',
      );
    });
  });
});
