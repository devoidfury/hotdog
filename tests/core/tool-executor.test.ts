// ToolExecutor tests — tests the tool execution pipeline independently of Agent.

import { describe, it, expect } from 'bun:test';
import path from 'node:path';
import { createToolExecutor, type ToolExecutorDeps } from '../../src/core/tool-executor.ts';
import type { Workspace } from '../../src/utils/workspace.ts';
import { tmpDir, cleanupDir } from '../mocks/io.ts';
import { createToolRegistry } from '../../src/core/extensions/tool-registry.ts';
import { createHooks, HOOKS } from '../../src/core/hooks.ts';
import { Message } from '../../src/core/context/message.ts';
import { TransientError, AssistantRetryableError } from '../../src/core/error.ts';
import type { Tool, ToolDef } from '../../src/core/extensions/tool-registry.ts';
import { xmlWireFormat } from '@extensions/wire-format-xml/index.ts';
import { toolContentText } from '@utils/tool-content.ts';
import { renderWrapperForWire, type ToolResultPart } from '../../src/core/context/wrappers.ts';
import { MarkerMangler, CORE_PROTECTED_PREFIXES } from '../../src/core/marker-mangler.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The tool-result part the executor stored for a result (never a string). */
function resultPart(content: unknown): ToolResultPart {
  const parts = content as ToolResultPart[];
  expect(Array.isArray(parts)).toBe(true);
  const part = parts[0];
  expect(part?.type).toBe('tool-result');
  return part as ToolResultPart;
}

/** Wire text for a part: the built-in format plus a session mangler, as serialize.ts does. */
function toWire(part: ToolResultPart): string {
  const mangler = new MarkerMangler([...CORE_PROTECTED_PREFIXES, ...xmlWireFormat.markers]);
  return renderWrapperForWire(part, mangler, xmlWireFormat);
}

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
    workspaceRoots: [process.cwd()],
    workspaceDeny: null,
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
        workspaceRoots: ['/b'],
      });
      const executor = createToolExecutor(deps);

      const capturedCtx: Record<string, unknown> = {};
      const testTool = makeTestTool('ctx_test', async (_input, ctx) => {
        const getter = ctx as { get: (k: string) => unknown };
        capturedCtx.agent = getter.get('agent');
        capturedCtx.isSessionRestoring = getter.get('isSessionRestoring');
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
    });

    it('should fall back to the process cwd when workspaceRoots is empty', async () => {
      const deps = createMockDeps({
        workspaceRoots: [],
      });
      const executor = createToolExecutor(deps);

      const capturedCtx: Record<string, unknown> = {};
      const testTool = makeTestTool('ctx_test2', async (_input, ctx) => {
        const getter = ctx as { get: (k: string) => unknown };
        capturedCtx.workspace = getter.get('workspace');
        return 'ok';
      });
      deps.toolRegistry.register('ctx_test2', testTool);

      await executor.execute([{
        id: 'call-2',
        type: 'function',
        function: { name: 'ctx_test2', arguments: '{}' },
      }]);

      const workspace = capturedCtx.workspace as { roots: string[] } | null;
      expect(workspace).not.toBeNull();
      expect(workspace!.roots).toEqual([process.cwd()]);
    });

    it('should always build a Workspace, defaulting to process cwd when no roots are set', async () => {
      const deps = createMockDeps({
        workspaceRoots: null,
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

    it('should build a multi-root Workspace from workspaceRoots', async () => {
      const dirA = tmpDir();
      const dirB = tmpDir();
      try {
        const deps = createMockDeps({
          workspaceRoots: [dirA, dirB],
        });
        const executor = createToolExecutor(deps);

        const capturedCtx: Record<string, unknown> = {};
        const testTool = makeTestTool('ctx_multi', async (_input, ctx) => {
          const getter = ctx as { get: (k: string) => unknown };
          capturedCtx.workspace = getter.get('workspace');
          return 'ok';
        });
        deps.toolRegistry.register('ctx_multi', testTool);

        await executor.execute([{
          id: 'call-multi',
          type: 'function',
          function: { name: 'ctx_multi', arguments: '{}' },
        }]);

        const workspace = capturedCtx.workspace as Workspace | null;
        expect(workspace).not.toBeNull();
        expect(workspace!.roots).toEqual([dirA, dirB]);
        expect(workspace!.root).toBe(dirA);
        // Absolute path inside the secondary root is accepted.
        expect(workspace!.resolveSafe(path.join(dirB, 'x.md'))).toBe(path.join(dirB, 'x.md'));
        // Relative paths resolve under the primary root.
        expect(workspace!.resolveSafe('x.md')).toBe(path.join(dirA, 'x.md'));
      } finally {
        cleanupDir(dirA);
        cleanupDir(dirB);
      }
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

      expect(toolContentText(result.toolResults[0]!.content)).toContain('not available');
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

      expect(toolContentText(result.toolResults[0]!.content)).toContain('not available');
    });

    it('suggests a case/separator near-match from the offered tools', async () => {
      const deps = createMockDeps();
      deps.toolRegistry.register('read', makeTestTool('read', async () => 'should not reach'));
      const executor = createToolExecutor(deps);

      const result = await executor.execute(
        [{
          id: 'call-1',
          type: 'function',
          function: { name: 'Read', arguments: '{}' },
        }],
        ['read', 'edit'],
      );

      const msg = toolContentText(result.toolResults[0]!.content);
      expect(msg).toContain('not available');
      expect(msg).toContain('Did you mean: read?');
    });

    it('suggests a close name match for a misspelled tool', async () => {
      const deps = createMockDeps();
      const executor = createToolExecutor(deps);

      const result = await executor.execute(
        [{
          id: 'call-1',
          type: 'function',
          function: { name: 'search_files', arguments: '{}' },
        }],
        ['search_files_content', 'read'],
      );

      const msg = toolContentText(result.toolResults[0]!.content);
      expect(msg).toContain('not available');
      expect(msg).toContain('search_files_content');
    });

    it('gives no suggestion for an unrelated name', async () => {
      const deps = createMockDeps();
      const executor = createToolExecutor(deps);

      const result = await executor.execute(
        [{
          id: 'call-1',
          type: 'function',
          function: { name: 'quantum_flux', arguments: '{}' },
        }],
        ['read', 'edit'],
      );

      const msg = toolContentText(result.toolResults[0]!.content);
      expect(msg).toContain('not available');
      expect(msg).not.toContain('Did you mean');
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

      expect(toolContentText(result.toolResults[0]!.content)).toContain('missing a valid name');
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

    it('answers every remaining call with a synthesized result when a tool stops the loop mid-batch', async () => {
      // Invariant: every tool_call gets exactly one result. The assistant
      // message (with all N calls) is already in context when execute()
      // starts, so a mid-batch stop must still answer the rest or the next
      // request 400s on strict backends (same reason the
      // maxToolCallsPerIteration truncation synthesizes results).
      const { ToolResult } = await import('../../src/core/extensions/tool-utils.ts');
      const deps = createMockDeps();
      let afterStopExecuted = false;
      deps.toolRegistry.register('stopper', makeTestTool('stopper', async () => ToolResult.stop('halting')));
      deps.toolRegistry.register('after', makeTestTool('after', async () => {
        afterStopExecuted = true;
        return 'nope';
      }));

      const executor = createToolExecutor(deps);
      const result = await executor.execute([
        { id: 'call-1', type: 'function', function: { name: 'stopper', arguments: '{}' } },
        { id: 'call-2', type: 'function', function: { name: 'after', arguments: '{}' } },
        { id: 'call-3', type: 'function', function: { name: 'after', arguments: '{}' } },
      ]);

      expect(result.outcome).toBe('return');
      expect(afterStopExecuted).toBe(false);
      expect(result.toolResults).toHaveLength(3);
      expect(result.toolResults[1]!.toolCallId).toBe('call-2');
      expect(toolContentText(result.toolResults[1]!.content)).toContain('skipped');
      expect(result.toolResults[2]!.toolCallId).toBe('call-3');
      // Only the actual stopping tool carries stopLoop.
      expect(result.toolResults.map((r) => r.stopLoop === true)).toEqual([true, false, false]);
      // Each synthesized result is recorded as a tool message like any other.
      expect(deps.addedMessages.map((m) => m.toolCallId)).toEqual(['call-1', 'call-2', 'call-3']);
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

      deps.hooks.on('tool:beforeExecute', () => {
        hookCalls.push('before');
      });
      deps.hooks.on('tool:afterExecute', () => {
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

    it('should fire AGENT_TOOL_CONTEXT with toolCtx, toolName and agent', async () => {
      const deps = createMockDeps({
        isRestoring: () => true,
      });
      const captured: { toolCtx?: { get: (k: string) => unknown }; toolName?: string; agent?: unknown } = {};

      deps.hooks.on('agent:toolContext', (data: { toolCtx: { get: (k: string) => unknown }; toolName: string; agent: unknown }) => {
        captured.toolCtx = data.toolCtx;
        captured.toolName = data.toolName;
        captured.agent = data.agent;
      });

      deps.toolRegistry.register('ctx_hook', makeTestTool('ctx_hook', async () => 'ok'));

      const executor = createToolExecutor(deps);
      await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'ctx_hook', arguments: '{}' },
      }]);

      expect(captured.toolName).toBe('ctx_hook');
      expect(captured.agent).toBe(deps.agent);
      expect(captured.toolCtx!.get('agent')).toBe(deps.agent);
      expect(captured.toolCtx!.get('isSessionRestoring')).toBe(true);
    });

    it('fires AGENT_TOOL_CONTEXT before the TOOL_CALL gate and passes toolCtx to it', async () => {
      const deps = createMockDeps();
      const order: string[] = [];
      let payloadCtx: { get: (k: string) => unknown } | undefined;

      deps.hooks.on('agent:toolContext', () => { order.push('context'); });
      deps.hooks.on('tool:call', (p: { toolCtx?: { get: (k: string) => unknown } }) => {
        order.push('call');
        payloadCtx = p.toolCtx;
      });

      deps.toolRegistry.register('order_test', makeTestTool('order_test', async () => 'ok'));

      const executor = createToolExecutor(deps);
      await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'order_test', arguments: '{}' },
      }]);

      expect(order).toEqual(['context', 'call']);
      // The gate handler gets the very context the tool will receive, so an
      // approval prompt can travel through toolCtx.get('input').
      expect(payloadCtx).toBeDefined();
      expect(payloadCtx!.get('agent')).toBe(deps.agent);
    });

    it('lets a TOOL_CALL approval handler prompt through the toolCtx input seam', async () => {
      // The point of building the context before the gate: an approval-style
      // handler reaches the human with the seam the question tool already uses,
      // and its block/continue actually gates execution.
      const { create: createUserGate } = await import('@extensions/user-gate/index.ts');
      const deps = createMockDeps();
      const fakeInput = {
        isInteractive: () => true,
        collectAnswers: (qs: { key: string }[]) => ({ [qs[0]!.key]: 'allow once' }),
      };
      deps.hooks.on('agent:toolContext', (data: { toolCtx: { set: (k: string, v: unknown) => void } }) => {
        data.toolCtx.set('input', fakeInput);
      });
      const instance = createUserGate({ hooks: deps.hooks, config: { userGate: { enabled: true } } } as never);
      for (const [name, handler] of Object.entries(instance.hooks ?? {})) {
        deps.hooks.on(name, handler as never, 'user-gate');
      }
      let executed = 0;
      deps.toolRegistry.register('approved', makeTestTool('approved', async () => {
        executed++;
        return 'ok';
      }));

      const executor = createToolExecutor(deps);
      const call = [{ id: 'c1', type: 'function' as const, function: { name: 'approved', arguments: '{}' } }];
      const first = await executor.execute(call);
      expect(executed).toBe(1);
      expect(toolContentText(first.toolResults[0]?.content)).toContain('ok');

      // Now make the human say no: the tool must not run again.
      const denying = {
        isInteractive: () => true,
        collectAnswers: (qs: { key: string }[]) => ({ [qs[0]!.key]: 'deny' }),
      };
      deps.hooks.on('agent:toolContext', (data: { toolCtx: { set: (k: string, v: unknown) => void } }) => {
        data.toolCtx.set('input', denying);
      });
      const second = await executor.execute(call);
      expect(executed).toBe(1);
      expect(toolContentText(second.toolResults[0]?.content)).toContain('Tool call blocked');
    });

    it('still builds the tool context when the TOOL_CALL gate blocks', async () => {
      const deps = createMockDeps();
      let contextFired = 0;
      let toolExecuted = false;

      deps.hooks.on('agent:toolContext', () => { contextFired++; });
      deps.hooks.on('tool:call', () => ({ action: 'block', result: 'denied' }));
      deps.toolRegistry.register('block_ctx', makeTestTool('block_ctx', async () => {
        toolExecuted = true;
        return 'nope';
      }));

      const executor = createToolExecutor(deps);
      const result = await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'block_ctx', arguments: '{}' },
      }]);

      expect(contextFired).toBe(1);
      expect(toolExecuted).toBe(false);
      expect(toolContentText(result.toolResults[0]?.content)).toContain('denied');
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
      expect(toolContentText(result.toolResults[0]!.content)).toContain('blocked by gate');
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

    it('a throwing TOOL_CALL gate handler fails closed — the tool is not executed', async () => {
      const deps = createMockDeps();
      let toolExecuted = false;

      deps.hooks.on('tool:call', () => {
        throw new Error('gate bug');
      });

      deps.toolRegistry.register('guarded_tool', makeTestTool('guarded_tool', async () => {
        toolExecuted = true;
        return 'should not reach';
      }));

      const executor = createToolExecutor(deps);
      const result = await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'guarded_tool', arguments: '{}' },
      }]);

      expect(toolExecuted).toBe(false);
      const toolMsg = deps.addedMessages.find((m: Message) => m.role === 'tool');
      expect(toolMsg).toBeTruthy();
      // The gate error becomes the tool result so the LLM can self-correct.
      expect(toolMsg!.content as string).toContain('Tool execution failed');
      expect(toolMsg!.content as string).toContain('gate bug');
      // The batch itself keeps going: no exception escapes execute().
      expect(result.outcome).toBe('continue');
      expect(result.toolResults).toHaveLength(1);
    });
  });

  describe('availability resolution', () => {
    it('resolves tool availability once per batch, not per tool call', async () => {
      const deps = createMockDeps();
      let defsCalls = 0;
      const original = (deps.agent as unknown as { getToolDefs: () => Promise<ToolDef[]> }).getToolDefs;
      (deps.agent as unknown as { getToolDefs: () => Promise<ToolDef[]> }).getToolDefs = async () => {
        defsCalls++;
        return original();
      };
      deps.toolRegistry.register('t1', makeTestTool('t1', async () => '1'));
      deps.toolRegistry.register('t2', makeTestTool('t2', async () => '2'));

      const executor = createToolExecutor(deps);
      await executor.execute([
        { id: 'c1', type: 'function', function: { name: 't1', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: 't2', arguments: '{}' } },
        { id: 'c3', type: 'function', function: { name: 't1', arguments: '{}' } },
      ]);

      expect(defsCalls).toBe(1);
    });

    it('uses caller-provided available names instead of the agent defs', async () => {
      const deps = createMockDeps();
      let defsCalls = 0;
      (deps.agent as unknown as { getToolDefs: () => Promise<ToolDef[]> }).getToolDefs = async () => {
        defsCalls++;
        return [];
      };
      deps.toolRegistry.register('hidden_tool', makeTestTool('hidden_tool', async () => 'nope'));

      const executor = createToolExecutor(deps);
      const result = await executor.execute(
        [{ id: 'c1', type: 'function', function: { name: 'hidden_tool', arguments: '{}' } }],
        ['other_tool'], // what the model actually saw, not the agent's full defs
      );

      expect(defsCalls).toBe(0);
      expect(toolContentText(result.toolResults[0]!.content)).toContain('not available');
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

      expect(toolContentText(result.toolResults[0]!.content)).toContain('Error executing tool');
      expect(toolContentText(result.toolResults[0]!.content)).toContain('boom');
    });

    it('routes AssistantRetryableError hints through the WireFormat seam', async () => {
      const deps = createMockDeps();
      deps.toolRegistry.register('hint_tool', makeTestTool('hint_tool', async () => {
        throw AssistantRetryableError.WithHint(
          'File not found: x.txt',
          'Use the find tool to locate the file.',
        );
      }));

      const executor = createToolExecutor(deps);
      const result = await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'hint_tool', arguments: '{}' },
      }]);

      // The executor stores a PART: the thrown error is the payload and the
      // hint is a field, never inlined text.
      const part = resultPart(result.toolResults[0]!.content);
      expect(part.status).toBe('error');
      expect(part.output).toContain('Error executing tool hint_tool: File not found: x.txt');
      expect(part.hint).toBe('Use the find tool to locate the file.');
      // Shaped at the wire, the hint becomes the format's hint element --
      // thrown errors and ToolResult.err().withHint() render identically.
      const wire = toWire(part);
      const hintTag = xmlWireFormat.markers[3]!;
      expect(wire).toContain(`<${hintTag}>Use the find tool to locate the file.</${hintTag}>`);
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
      expect(toolContentText(result.toolResults[0]!.content)).toContain('ran');
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
      expect(toolContentText(result.toolResults[0]!.content)).toContain('Error executing tool');
      expect(toolContentText(result.toolResults[0]!.content)).toContain('flaky');
    });

    it('maxRetries: 2 makes one initial attempt plus two retries on transient errors', async () => {
      let calls = 0;
      const deps = createMockDeps({ maxRetries: 2, toolRetryDelay: 1 });
      deps.toolRegistry.register('flaky2', makeTestTool('flaky2', async () => {
        calls++;
        throw new TransientError('still flaky');
      }));

      const executor = createToolExecutor(deps);
      const result = await executor.execute([{
        id: 'call-1',
        type: 'function',
        function: { name: 'flaky2', arguments: '{}' },
      }]);

      expect(calls).toBe(3);
      expect(toolContentText(result.toolResults[0]!.content)).toContain('still flaky');
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
      expect(resultPart((msg.content as unknown) as never).output).toBe('hello from tool');
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
      const errPart = resultPart((msg.content as unknown) as never);
      expect(errPart.status).toBe('error');
      expect(errPart.output).toContain('kaboom');
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

  describe('stores tool results as parts, never as model-facing text', () => {
    function makeEchoExecutor(deps: ReturnType<typeof createMockDeps>) {
      deps.toolRegistry.register('echo', makeTestTool('echo', async () => 'hi'));
      return createToolExecutor(deps);
    }

    it('the stored content is a tool-result part with the tool named', async () => {
      const deps = createMockDeps();
      const executor = makeEchoExecutor(deps);
      const result = await executor.execute([
        { id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{}' } },
      ]);

      const content = result.toolResults[0]!.content;
      expect(Array.isArray(content)).toBe(true);
      const part = resultPart(content);
      expect(part).toEqual({
        type: 'tool-result',
        tool: 'echo',
        status: 'success',
        meta: [],
        error: null,
        hint: null,
        output: 'hi',
      });
      // No markup at rest: the shape exists only once a format renders it.
      expect(JSON.stringify(content)).not.toContain('<');
    });

    it('the session log stores the part, and each format shapes it at the wire', async () => {
      const deps = createMockDeps();
      const executor = makeEchoExecutor(deps);
      const result = await executor.execute([
        { id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{}' } },
      ]);
      const part = resultPart(result.toolResults[0]!.content);

      // Same stored part, two different formats -- the stored message never
      // changes, so switching formats mid-session cannot strand old context.
      expect(toWire(part)).toContain(`name="echo"`);
      const mdTable = {
        id: 'md-table',
        markers: ['md-row'],
        renderToolResult: (p: ToolResultPart) => `| ${p.tool} | ${p.status} |`,
        renderFileInclude: () => '',
        renderSystemNotice: () => '',
      };
      expect(renderWrapperForWire(part, new MarkerMangler(), mdTable)).toBe('| echo | success |');
    });

    it('a blocked gate call still answers with a part (status "error")', async () => {
      const deps = createMockDeps();
      deps.toolRegistry.register('echo', makeTestTool('echo', async () => 'unreachable'));
      deps.hooks.on(HOOKS.TOOL_CALL, () => ({ action: 'block', result: 'nope' }));
      const executor = createToolExecutor(deps);
      const result = await executor.execute([
        { id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{}' } },
      ]);

      const part = resultPart(result.toolResults[0]!.content);
      expect(part.status).toBe('error');
      expect(part.output).toContain('nope');
      // The block message is tool-authored data: the wire mangles it.
      const forged = `<${CORE_PROTECTED_PREFIXES[0]}>`;
      const mangled = toWire({ ...part, output: `${part.output} ${forged}` });
      expect(mangled).not.toContain(forged);
    });
  });
});
