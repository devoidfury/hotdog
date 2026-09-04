// Tests for the core Agent class — full end-to-end agent loop.

import { Agent } from '../../src/core/agent.ts';
import { HOOKS, createHooks } from '../../src/core/hooks.ts';
import { ACTIONS } from '../../src/core/commands.ts';
import { createToolRegistry } from '../../src/core/extensions/tool-registry.ts';
import { Message } from '../../src/core/context/message.ts';
import { AgentError, ConfigError } from '../../src/core/error.ts';
import type { LlmClient } from '../../src/core/llm-client/client.ts';
import type { OutputEvent } from '../../src/core/context/output.ts';
import { OUTPUT_EVENT } from '../../src/core/context/output.ts';
import { describe, it, expect } from 'bun:test';
import {
  MockLLMClient,
  MockTool,
  buildStreamResponse,
  simpleTool,
  validatedTool,
  failingTool,
  createFixture,
} from '../helpers.ts';
import { expectCompletion, expectToolReturn } from '../test-helpers.ts';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Agent — end-to-end loop', () => {
  // ── Text-only response ─────────────────────────────────────────────────────

  it('should return text response when LLM returns only content', async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [[
        { type: 'content', content: 'Hello! I am an AI assistant.' },
        { type: 'usage', data: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } },
      ]],
    });

    const { agent } = createFixture({ mockLLM });

    const result = await agent.run('Hi');

    const completion = expectCompletion(result);
    expect(completion.content).toBe('Hello! I am an AI assistant.');
    expect(mockLLM.callCount).toBe(1);

    // Verify conversation history was recorded
    const ctx = agent.context.log.getAll();
    expect(ctx).toHaveLength(2);
    expect(ctx[0]!.role).toBe('user');
    expect(ctx[1]!.role).toBe('assistant');
    // Model output is tagged so provenance survives persistence/replay.
    expect(ctx[1]!.source).toBe('model');
  });

  it('should handle reasoning content alongside text', async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [[
        { type: 'reasoning', content: 'I need to think about this carefully.' },
        { type: 'content', content: 'Here is my answer.' },
        { type: 'usage', data: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 } },
      ]],
    });

    const { agent } = createFixture({ mockLLM });

    const result = await agent.run('Think step by step');

    const completion = expectCompletion(result);
    expect(completion.content).toBe('Here is my answer.');
    expect(agent.context.log.at(1)!.reasoningContent).toBe('I need to think about this carefully.');
  });

  it('run() with harness source creates a harness-role message', async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [[
        { type: 'content', content: 'ok' },
        { type: 'usage', data: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ]],
    });

    const { agent } = createFixture({ mockLLM });

    await agent.run('[Task t1 completed]\ndone', undefined, { source: 'harness' });

    const harnessMsg = agent.context.log.getAll().find((m) => m.role === 'harness');
    expect(harnessMsg).toBeTruthy();
    expect(harnessMsg!.source).toBe('harness');

    // Without opts the message is plain user input.
    await agent.run('plain user input');
    const plainMsg = agent.context.log.getAll().filter((m) => m.role === 'user').at(-1);
    expect(plainMsg!.source).toBe('user');
  });

  // ── Single tool call ───────────────────────────────────────────────────────

  it('should execute a single tool call and return result to LLM', async () => {
    const tool = simpleTool('calculator', '42');

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Let me calculate that.',
          toolCalls: [{ index: 0, name: 'calculator', arguments: '{"expr":"2+2"}', id: 'call_calc_1' }],
          usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 },
        }),
        buildStreamResponse({
          content: 'The answer is 42.',
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
        }),
      ],
    });

    const { agent, toolRegistry } = createFixture({ mockLLM });
    toolRegistry.register('calculator', tool);

    const result = await agent.run('What is 2+2?');

    const completion = expectCompletion(result);
    expect(completion.content).toBe('The answer is 42.');
    expect(tool.executeCount).toBe(1);
    expect(tool.lastInput).toBe('{"expr":"2+2"}');
    expect(mockLLM.callCount).toBe(2);

    // Verify tool call and result are in conversation history
    const ctx = agent.context.log.getAll();
    const assistantMsg = ctx.find(m => m.role === 'assistant' && m.toolCalls);
    const toolMsg = ctx.find(m => m.role === 'tool');
    expect(assistantMsg).toBeTruthy();
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content as string).toContain('42');
  });

  it('should fire CONTEXT_MESSAGE once per context message, including tool results', async () => {
    const tool = simpleTool('calculator', '42');

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Let me calculate that.',
          toolCalls: [{ index: 0, name: 'calculator', arguments: '{"expr":"2+2"}', id: 'call_calc_1' }],
          usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 },
        }),
        buildStreamResponse({
          content: 'The answer is 42.',
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
        }),
      ],
    });

    const { hooks, toolRegistry, agent } = createFixture({ mockLLM });
    toolRegistry.register('calculator', tool);

    const logged: Array<{ role: string; content: string }> = [];
    hooks.on(HOOKS.CONTEXT_MESSAGE, ({ message }) => {
      logged.push({ role: message.role ?? "", content: typeof message.content === 'string' ? message.content : "" });
    });

    await agent.run('What is 2+2?');

    const roles = logged.map(m => m.role);
    // Tool results must reach the hook (session log writes them to jsonl)
    expect(roles).toContain('tool');
    const toolEntry = logged.find(m => m.role === 'tool')!;
    expect(toolEntry.content).toContain('42');
    // Each message is notified exactly once -- no duplicates
    expect(roles.filter(r => r === 'user')).toHaveLength(1);
    expect(roles.filter(r => r === 'assistant')).toHaveLength(2);
    expect(roles.filter(r => r === 'tool')).toHaveLength(1);
  });

  // ── Multiple tool calls in one turn ────────────────────────────────────────

  it('should execute multiple parallel tool calls from one LLM response', async () => {
    const readTool = simpleTool('read_file', 'file contents');
    const grepTool = simpleTool('grep', 'search results');

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'I will search and read simultaneously.',
          toolCalls: [
            { index: 0, name: 'read_file', arguments: '{"path":"/test.txt"}', id: 'call_read_1' },
            { index: 1, name: 'grep', arguments: '{"pattern":"test"}', id: 'call_grep_1' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50 },
        }),
        buildStreamResponse({
          content: 'Both operations completed.',
          usage: { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 },
        }),
      ],
    });

    const { agent, toolRegistry } = createFixture({ mockLLM });
    toolRegistry.register('read_file', readTool);
    toolRegistry.register('grep', grepTool);

    const result = await agent.run('Search and read');

    const completion = expectCompletion(result);
    expect(completion.content).toBe('Both operations completed.');
    expect(readTool.executeCount).toBe(1);
    expect(grepTool.executeCount).toBe(1);
    expect(mockLLM.callCount).toBe(2);

    // Verify both tools were called and results recorded
    const ctx = agent.context.log.getAll();
    const assistantMsg = ctx.find(m => m.role === 'assistant' && m.toolCalls);
    expect(assistantMsg).toBeTruthy();
    expect((assistantMsg!.toolCalls as Array<unknown>).length).toBe(2);
    const toolMsgs = ctx.filter(m => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
  });

  // ── Tool validation error ─────────────────────────────────────────────────

  it('should return validation error when tool input fails schema validation', async () => {
    const tool = validatedTool('greet', {
      properties: { name: { type: 'string', description: 'Name to greet' } },
      required: ['name'],
    }, async (input) => `Hello ${(input as { name?: string })?.name}!`);

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Let me greet someone.',
          toolCalls: [{ index: 0, name: 'greet', arguments: '{}', id: 'call_greet_1' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        buildStreamResponse({
          content: 'The validation failed as expected.',
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
        }),
      ],
    });

    const { agent, toolRegistry } = createFixture({ mockLLM });
    toolRegistry.register('greet', tool);

    const result = await agent.run('Greet someone');

    const completion = expectCompletion(result);
    expect(completion.content).toBe('The validation failed as expected.');
    expect(tool.executeCount).toBe(0); // tool was NOT executed
    expect(mockLLM.callCount).toBe(2);

    // Verify validation error was recorded
    const toolMsg = agent.context.log.getAll().find(m => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content as string).toContain('validation');
  });

  // ── Unknown tool ─────────────────────────────────────────────────────────

  it('should handle unknown tool calls gracefully', async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'I will use a tool.',
          toolCalls: [{ index: 0, name: 'nonexistent_tool', arguments: '{}', id: 'call_unknown_1' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        buildStreamResponse({
          content: 'The tool was not found.',
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
        }),
      ],
    });

    const { agent } = createFixture({ mockLLM });

    const result = await agent.run('Use a tool');

    const completion = expectCompletion(result);
    expect(completion.content).toBe('The tool was not found.');
    expect(mockLLM.callCount).toBe(2);

    // Verify error was recorded. The defs check (getToolDefs) catches names
    // the agent was never offered, so the message is "not available" rather
    // than the old registry-lookup "Unknown tool".
    const toolMsg = agent.context.log.getAll().find(m => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content as string).toContain('not available');
  });

  it('should use the model-visible tool defs for availability (PROVIDER_REQUEST can narrow them)', async () => {
    const tool = simpleTool('secret_tool', 'secret result');

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Using a tool.',
          toolCalls: [{ index: 0, name: 'secret_tool', arguments: '{}', id: 'call_secret_1' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        buildStreamResponse({
          content: 'Tool not available.',
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
        }),
      ],
    });

    const { agent, toolRegistry, hooks } = createFixture({ mockLLM });
    toolRegistry.register('secret_tool', tool);

    // A provider-layer hook hides the tool from the request the model sees.
    // Availability must track what the model was offered, not the registry.
    hooks.on(HOOKS.PROVIDER_REQUEST, ({ toolDefs }) => ({
      toolDefs: toolDefs.filter(d => d.function.name !== 'secret_tool'),
    }));

    const result = await agent.run('Use the tool');

    const completion = expectCompletion(result);
    expect(completion.content).toBe('Tool not available.');
    expect(tool.executeCount).toBe(0);
    const toolMsg = agent.context.log.getAll().find(m => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content as string).toContain('not available');
  });

  // ── Tool execution error ──────────────────────────────────────────────────

  it('should handle tool execution errors gracefully', async () => {
    const tool = failingTool('crash', 'disk full');

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'I will try to use the tool.',
          toolCalls: [{ index: 0, name: 'crash', arguments: '{}', id: 'call_crash_1' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        buildStreamResponse({
          content: 'The tool reported an error.',
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
        }),
      ],
    });

    const { agent, toolRegistry } = createFixture({ mockLLM });
    toolRegistry.register('crash', tool);

    const result = await agent.run('Use the tool');

    const completion = expectCompletion(result);
    expect(completion.content).toBe('The tool reported an error.');
    expect(tool.executeCount).toBe(1);

    // Verify error was recorded
    const toolMsg = agent.context.log.getAll().find(m => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content as string).toContain('Error executing');
  });

  // ── Wait tool (yield control) ─────────────────────────────────────────────

  it('should stop agent loop when wait tool is called', async () => {
    const { ToolResult } = await import('../../src/core/extensions/tool-utils.ts');
    const waitTool = new MockTool({
      name: 'wait',
      execute: async () => ToolResult.stop('nothing to do'),
    });

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Done, yielding control.',
          toolCalls: [{ index: 0, name: 'wait', arguments: '{}', id: 'call_wait_1' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      ],
    });

    const { agent, toolRegistry } = createFixture({ mockLLM });
    toolRegistry.register('wait', waitTool);

    // Should return early without a second LLM call
    const result = await agent.run('Do work then wait');

    const toolReturn = expectToolReturn(result);
    expect(toolReturn.outcome).toBe('return');
    expect(mockLLM.callCount).toBe(1); // only one LLM call
    expect(waitTool.executeCount).toBe(1);
  });

  // ── Tool whitelist enforcement ───────────────────────────────────────────

  it('should block tools not in the whitelist', async () => {
    const allowedTool = simpleTool('allowed_tool', 'allowed result');
    const blockedTool = simpleTool('blocked_tool', 'blocked result');

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Using tools.',
          toolCalls: [
            { index: 0, name: 'allowed_tool', arguments: '{}', id: 'call_allowed_1' },
            { index: 1, name: 'blocked_tool', arguments: '{}', id: 'call_blocked_1' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 },
        }),
        buildStreamResponse({
          content: 'One tool was blocked.',
          usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
        }),
      ],
    });

    const { agent, toolRegistry } = createFixture({
      mockLLM,
      toolWhitelist: ['allowed_tool'],
    });
    toolRegistry.register('allowed_tool', allowedTool);
    toolRegistry.register('blocked_tool', blockedTool);

    const result = await agent.run('Use tools');

    const completion = expectCompletion(result);
    expect(completion.content).toBe('One tool was blocked.');
    expect(allowedTool.executeCount).toBe(1);
    expect(blockedTool.executeCount).toBe(0);

    // Verify whitelist enforcement
    const ctx = agent.context.log.getAll();
    const allowedResult = ctx.find(m => m.role === 'tool' && (m.content as string).includes('allowed result'));
    const blockedResult = ctx.find(m => m.role === 'tool' && (m.content as string).includes('not available'));
    expect(allowedResult).toBeTruthy();
    expect(blockedResult).toBeTruthy();
  });

  // ── Cancellation during streaming ─────────────────────────────────────────

  it('should abort when cancelled during LLM streaming', async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [
        // Generator that yields one event then hangs
        (async function* () {
          yield { type: 'content', content: 'Starting...' };
          // Simulate a long stream — yield nothing, test cancels
          await new Promise(() => {}); // never resolves
        })() as unknown as Record<string, unknown>[],
      ],
      cancelable: true,
    });

    const { agent } = createFixture({ mockLLM });

    // Run and cancel concurrently
    const runPromise = agent.run('Cancel me');
    await Promise.resolve(); // let the run start
    agent.cancel();

    await expect(runPromise).rejects.toThrow('cancelled');
  });

  it('should abort when abortSignal is fired during streaming', async () => {
    const abortController = new AbortController();

    const mockLLM = new MockLLMClient({
      responseSequences: [
        (async function* () {
          yield { type: 'content', content: 'Starting...' };
          await new Promise(() => {}); // never resolves
        })() as unknown as Record<string, unknown>[],
      ],
      cancelable: true,
    });

    const { agent } = createFixture({
      mockLLM,
      abortSignal: abortController.signal,
    });

    const runPromise = agent.run('Abort me');
    await Promise.resolve();
    abortController.abort();

    await expect(runPromise).rejects.toThrow('Agent aborted');
  });

  // ── Hook integration ──────────────────────────────────────────────────────

  it('should fire PROVIDER_REQUEST hook before each LLM call', async () => {
    const tool = simpleTool('hook_test_tool', 'hook result');
    const mockLLM = new MockLLMClient({
      responseSequences: [
        // First LLM call: returns a tool call → triggers second LLM call
        buildStreamResponse({
          content: 'Calling tool.',
          toolCalls: [{ index: 0, name: 'hook_test_tool', arguments: '{}', id: 'call_hook_1' }],
          usage: { total_tokens: 10 },
        }),
        // Second LLM call: returns final text
        buildStreamResponse({ content: 'Second response', usage: { total_tokens: 20 } }),
      ],
    });

    const { agent, toolRegistry, hooks } = createFixture({ mockLLM });
    toolRegistry.register('hook_test_tool', tool);
    const requestHookCalls: string[] = [];

    hooks.on(HOOKS.PROVIDER_REQUEST, (data: { modelConfig?: { name?: string }; agent?: { model: string } }) => {
      requestHookCalls.push(data.modelConfig?.name || data.agent!.model);
    });

    await agent.run('Hi');

    expect(requestHookCalls.length).toBe(2);
    expect(requestHookCalls[0]).toBe('test-model');
    expect(requestHookCalls[1]).toBe('test-model');
  });

  it('should fire PROVIDER_RESPONSE hook after each LLM call', async () => {
    const tool = simpleTool('hook_test_tool', 'hook result');
    const mockLLM = new MockLLMClient({
      responseSequences: [
        // First LLM call: returns a tool call → triggers second LLM call
        buildStreamResponse({
          content: 'First',
          toolCalls: [{ index: 0, name: 'hook_test_tool', arguments: '{}', id: 'call_hook_1' }],
          usage: { total_tokens: 10 },
        }),
        // Second LLM call: returns final text
        buildStreamResponse({ content: 'Second', usage: { total_tokens: 20 } }),
      ],
    });

    const { agent, toolRegistry, hooks } = createFixture({ mockLLM });
    toolRegistry.register('hook_test_tool', tool);
    const responseHookCalls: string[] = [];

    hooks.on(HOOKS.PROVIDER_RESPONSE, (data) => {
      const response = data.response as { fullText: string };
      responseHookCalls.push(response.fullText);
    });

    await agent.run('Hi');

    expect(responseHookCalls.length).toBe(2);
    expect(responseHookCalls[0]).toBe('First');
    expect(responseHookCalls[1]).toBe('Second');
  });

  it('should fire TURN_START and TURN_END hooks', async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({ content: 'Turn 1', usage: { total_tokens: 10 } }),
      ],
    });

    const { agent, hooks } = createFixture({ mockLLM });
    const turnEvents: Array<{ type: string; index?: number; stopped?: boolean }> = [];

    hooks.on(HOOKS.TURN_START, (data: { turnIndex: number }) => {
      turnEvents.push({ type: 'start', index: data.turnIndex });
    });

    hooks.on(HOOKS.TURN_END, (data: { turnIndex: number; stopped: boolean }) => {
      turnEvents.push({ type: 'end', index: data.turnIndex, stopped: data.stopped });
    });

    await agent.run('Hi');

    expect(turnEvents.length).toBe(2);
    expect(turnEvents[0]!.type).toBe('start');
    expect(turnEvents[0]!.index).toBeGreaterThan(0);
    expect(turnEvents[1]!.type).toBe('end');
    expect(turnEvents[1]!.index).toBe(turnEvents[0]!.index);
    expect(turnEvents[1]!.stopped).toBe(true);
  });

  it('should allow CONTEXT hook to modify messages before LLM call', async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({ content: 'Response', usage: { total_tokens: 10 } }),
      ],
    });

    const { agent, hooks } = createFixture({ mockLLM });

    hooks.on(HOOKS.CONTEXT, ({ messages }: { messages: Message[] }) => {
      // Add a system instruction before each LLM call
      return {
        messages: [
          new Message({ role: 'system', content: 'Be concise.' }),
          ...messages,
        ],
      };
    });

    await agent.run('Hi');

    expect(mockLLM.lastMessages![0] as Message).toHaveProperty('role', 'system');
    expect((mockLLM.lastMessages![0] as Message).content).toBe('Be concise.');
  });

  it('should fire TOOL_CALL gate hook and allow blocking/modifying', async () => {
    const tool = simpleTool('sensitive_tool', 'sensitive data');

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Using tool.',
          toolCalls: [{ index: 0, name: 'sensitive_tool', arguments: '{}', id: 'call_sensitive_1' }],
          usage: { total_tokens: 20 },
        }),
        buildStreamResponse({
          content: 'Tool blocked by gate.',
          usage: { total_tokens: 30 },
        }),
      ],
    });

    const { agent, toolRegistry, hooks } = createFixture({ mockLLM });
    toolRegistry.register('sensitive_tool', tool);

    // Block the tool via gate hook
    hooks.on(HOOKS.TOOL_CALL, ({ toolName }: { toolName: string }) => {
      if (toolName === 'sensitive_tool') {
        return { action: 'block', result: 'Blocked: sensitive tool not allowed' };
      }
      return { action: 'continue' };
    });

    const result = await agent.run('Access sensitive data');

    const completion = expectCompletion(result);
    expect(completion.content).toBe('Tool blocked by gate.');
    expect(tool.executeCount).toBe(0); // tool was NOT executed

    // Verify blocked result was recorded
    const toolMsg = agent.context.log.getAll().find(m => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content as string).toContain('Blocked');
  });

  it('should fire TOOL_RESULT hook and allow modifying result', async () => {
    const tool = simpleTool('modify_tool', 'original result');

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Using tool.',
          toolCalls: [{ index: 0, name: 'modify_tool', arguments: '{}', id: 'call_modify_1' }],
          usage: { total_tokens: 20 },
        }),
        buildStreamResponse({
          content: 'Modified result received.',
          usage: { total_tokens: 30 },
        }),
      ],
    });

    const { agent, toolRegistry, hooks } = createFixture({ mockLLM });
    toolRegistry.register('modify_tool', tool);

    // Modify the tool result
    hooks.on(HOOKS.TOOL_RESULT, ({ result }: { result: unknown }) => {
      return { result: `[MODIFIED] ${result}` };
    });

    const result = await agent.run('Modify result');

    const completion = expectCompletion(result);
    expect(completion.content).toBe('Modified result received.');
    expect(tool.executeCount).toBe(1);

    // Verify modified result was recorded
    const toolMsg = agent.context.log.getAll().find(m => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content as string).toContain('MODIFIED');
  });

  // ── Max iterations ───────────────────────────────────────────────────────

  it('should throw when max iterations reached', async () => {
    // Produce tool calls forever so the agent loops indefinitely
    const tool = simpleTool('looper', 'loop result');

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: '',
          toolCalls: [{ index: 0, name: 'looper', arguments: '{}', id: 'call_loop_1' }],
          usage: { total_tokens: 10 },
        }),
        buildStreamResponse({
          content: '',
          toolCalls: [{ index: 0, name: 'looper', arguments: '{}', id: 'call_loop_2' }],
          usage: { total_tokens: 20 },
        }),
        buildStreamResponse({
          content: '',
          toolCalls: [{ index: 0, name: 'looper', arguments: '{}', id: 'call_loop_3' }],
          usage: { total_tokens: 30 },
        }),
        buildStreamResponse({
          content: '',
          toolCalls: [{ index: 0, name: 'looper', arguments: '{}', id: 'call_loop_4' }],
          usage: { total_tokens: 40 },
        }),
      ],
    });

    const { agent, toolRegistry } = createFixture({
      mockLLM,
      maxIterations: 3, // Only 3 iterations allowed
    });
    toolRegistry.register('looper', tool);

    await expect(agent.run('Loop')).rejects.toThrow('Max iterations');
    expect(mockLLM.callCount).toBe(3);
  });

  // ── Follow-up queue draining ─────────────────────────────────────────────

  it('should drain follow-up queue at the start of each iteration', async () => {
    const tool = simpleTool('worker', 'work result');

    const mockLLM = new MockLLMClient({
      responseSequences: [
        // First call: tool call
        buildStreamResponse({
          content: '',
          toolCalls: [{ index: 0, name: 'worker', arguments: '{}', id: 'call_work_1' }],
          usage: { total_tokens: 10 },
        }),
        // Second call: responds after follow-up is drained
        buildStreamResponse({
          content: 'Follow-up processed.',
          usage: { total_tokens: 30 },
        }),
      ],
    });

    const { agent, toolRegistry } = createFixture({ mockLLM });
    toolRegistry.register('worker', tool);

    // Queue a follow-up before running
    agent.followQueue.push('Follow-up message');

    const result = await agent.run('Do work');

    const completion = expectCompletion(result);
    expect(completion.content).toBe('Follow-up processed.');
    expect(mockLLM.callCount).toBe(2);

    // Context should contain the follow-up user message
    const ctx = agent.context.log.getAll();
    const followUpMsg = ctx.find(m => m.role === 'user' && m.content === 'Follow-up message');
    expect(followUpMsg).toBeTruthy();
  });

  // ── Existing tests (preserved) ────────────────────────────────────────────

  describe('context', () => {
    it('should allow clearing context', async () => {
      const { agent } = createFixture({});
      agent.addMessage(new Message({ role: 'user', content: 'hello' }));
      await agent.clearContext();
      expect(agent.context.log.getAll()).toEqual([]);
      expect(agent.iterationCount).toBe(0);
    });
  });

  describe('executeCommand', () => {
    it('should handle clear command', async () => {
      const { agent } = createFixture({});
      agent.addMessage(new Message({ role: 'user', content: 'hello' }));
      const result = await agent.executeCommand({ type: 'clear', value: null });
      expect(result).toEqual({ action: ACTIONS.DISPLAY, content: 'Context cleared.' });
      expect(agent.context.log.getAll()).toEqual([]);
    });

    it('should handle reasoning command to set effort', async () => {
      const { agent } = createFixture({});
      const result = await agent.executeCommand({ type: 'reasoning', value: 'high' });
      expect(result).toEqual({ action: ACTIONS.DISPLAY, content: 'Reasoning effort set to: high' });
      expect(agent.reasoningEffort).toBe('high');
    });

    it('should delegate to hooks for custom commands', async () => {
      const { agent, hooks } = createFixture({});
      hooks.on(HOOKS.COMMAND_DISPATCH, () => ({ content: 'custom handled' }));
      const result = await agent.executeCommand({ type: 'custom', value: null });
      expect(result).toEqual({ content: 'custom handled' });
    });

    it('should return error for unknown commands', async () => {
      const { agent } = createFixture({});
      const result = await agent.executeCommand({ type: 'unknown-cmd', value: null });
      expect(result).toEqual({ action: ACTIONS.ERROR, error: 'Unknown command: unknown-cmd' });
    });

    it('should fall through to command registry', async () => {
      const { agent } = createFixture({});
      const registry = agent.commandRegistry;
      registry.register('test-cmd', { handler: async () => ({ content: 'registered' }) });
      const result = await agent.executeCommand({ type: 'test-cmd', value: '' });
      expect((result as any).content).toBe('registered');
    });
  });

  describe('SYSTEM_PROMPT_BUILD hook', () => {
    it('should call SYSTEM_PROMPT_BUILD handlers and collect returned chunks', async () => {
      const { agent, hooks } = createFixture({});
      hooks.on(HOOKS.SYSTEM_PROMPT_BUILD, async () => {
        return { name: 'test-chunk', priority: 500, content: '\n# Test Chunk' };
      });

      await agent.ensureSystemPrompt();
      expect(agent.context.getSystemPrompt()).toContain('Test Chunk');
    });

    it('clears the cached system prompt on model change and rebuilds with the new model', async () => {
      const { agent, hooks } = createFixture({});
      // Simulate an environment chunk that bakes the model name into the prompt
      hooks.on(HOOKS.SYSTEM_PROMPT_BUILD, async ({ agent: a }: { agent: unknown }) => {
        return { name: 'env-chunk', priority: 100, content: `Harness model: ${(a as { model: string }).model}` };
      });

      await agent.ensureSystemPrompt();
      expect(agent.context.getSystemPrompt()).toContain('Harness model: test-model');

      agent.model = 'replaced-model';
      // The cached prompt must be invalidated on model change
      expect(agent.context.getSystemPrompt()).toBeNull();

      await agent.ensureSystemPrompt();
      expect(agent.context.getSystemPrompt()).toContain('Harness model: replaced-model');
    });
  });

// resolveModelConfig tests moved to providers.test.ts

  describe('serialize/deserialize', () => {
    it('should preserve conversation history and state across serialize/deserialize', async () => {
      const { agent } = createFixture({});

      agent.addMessage(new Message({ role: 'user', content: 'test message' }));
      agent.addMessage(new Message({
        role: 'assistant',
        content: 'response',
        reasoningContent: 'thinking...',
        toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }],
      }));
      agent.reasoningEffort = 'high';

      const serialized = agent.serialize();

      const freshAgent = new Agent({
        hooks: createHooks(),
        toolRegistry: createToolRegistry(),
        llmClient: new MockLLMClient() as unknown as LlmClient,
        model: 'test-model',
        maxIterations: 100,
        contextLimit: 128000,
        config: { maxToolCallsPerIteration: 10, maxRetries: 5, toolRetryDelay: 1 },
      });
      freshAgent.deserialize(serialized);

      expect(freshAgent.sessionId).toBe('test-session');
      expect(freshAgent.context.log.length).toBe(2);
      expect(freshAgent.context.log.at(0)!.content).toBe('test message');
      expect(freshAgent.context.log.at(1)!.reasoningContent).toBe('thinking...');
      expect(freshAgent.reasoningEffort).toBe('high');
    });

    it('should handle deserialize with empty data', () => {
      const { agent } = createFixture({});
      agent.deserialize({ sessionId: 'new-id', context: [], model: 'new-model' });
      expect(agent.sessionId).toBe('new-id');
      expect(agent.model).toBe('new-model');
    });
  });

  // Tool execution error handling is covered in tool-executor.test.ts

  describe('invalid tool name handling', () => {
    it.each([
      { name: '', desc: 'empty' },
      { name: '  ', desc: 'whitespace' },
      { name: null as unknown as string, desc: 'null' },
    ])('should reject tool call with %s name', async ({ name }) => {
      const mockLLM = new MockLLMClient({
        responseSequences: [
          buildStreamResponse({
            content: '',
            toolCalls: [{ index: 0, name, arguments: '{}', id: 'call_1' }],
            usage: { total_tokens: 10 },
          }),
          buildStreamResponse({ content: 'Error handled', usage: { total_tokens: 5 } }),
        ],
      });
      const { agent } = createFixture({ mockLLM });
      const result = await agent.run('test');
      expect((result as any)?.content).toBe('Error handled');
      const msgs = agent.context.log.getAll();
      expect(msgs.some(m => m.role === 'tool' && (m.content as string).includes('missing a valid name'))).toBe(true);
    });
  });

  describe('getTokenUsage', () => {
    it('returns usage object after run', async () => {
      const mockLLM = new MockLLMClient({
        responseSequences: [[
          { type: 'content', content: 'Hello' },
          { type: 'usage', data: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } },
        ]],
      });
      const { agent } = createFixture({ mockLLM });
      await agent.run('test');
      const usage = agent.context.getTokenUsage();
      expect(usage.sessionPromptTokens).toBe(5);
      expect(usage.sessionCompletionTokens).toBe(10);
      expect(usage.sessionTotalTokens).toBe(15);
    });
  });

  describe('required config keys (no runtime fallbacks)', () => {
    function buildAgent(config: Record<string, unknown> | undefined): Agent {
      return new Agent({
        hooks: createHooks(),
        toolRegistry: createToolRegistry(),
        llmClient: new MockLLMClient() as unknown as LlmClient,
        model: 'test-model',
        maxIterations: 10,
        contextLimit: 128000,
        config,
      });
    }

    it('throws ConfigError when maxToolCallsPerIteration is missing', () => {
      expect(() => buildAgent({ maxRetries: 5, toolRetryDelay: 1 })).toThrow(
        "Missing required configuration: 'maxToolCallsPerIteration'",
      );
    });

    it('throws ConfigError when maxRetries is missing', () => {
      expect(() => buildAgent({ maxToolCallsPerIteration: 10, toolRetryDelay: 1 })).toThrow(
        "Missing required configuration: 'maxRetries'",
      );
    });

    it('throws ConfigError when toolRetryDelay is missing', () => {
      expect(() => buildAgent({ maxToolCallsPerIteration: 10, maxRetries: 5 })).toThrow(
        "Missing required configuration: 'toolRetryDelay'",
      );
    });

    it('throws ConfigError when no config is provided', () => {
      expect(() => buildAgent(undefined)).toThrow(ConfigError);
    });

    it('accepts an agent built with all keys present', () => {
      const agent = buildAgent({ maxToolCallsPerIteration: 10, maxRetries: 5, toolRetryDelay: 1 });
      expect(agent.maxToolCallsPerIteration).toBe(10);
    });
  });

  describe('model resolution (no built-in default)', () => {
    function buildAgentWithModel(model: unknown): Agent {
      return new Agent({
        hooks: createHooks(),
        toolRegistry: createToolRegistry(),
        llmClient: new MockLLMClient() as unknown as LlmClient,
        model: model as string,
        maxIterations: 10,
        contextLimit: 128000,
        config: { maxToolCallsPerIteration: 10, maxRetries: 5, toolRetryDelay: 1 },
      });
    }

    it('throws a ConfigError when the model is an empty string', () => {
      expect(() => buildAgentWithModel('')).toThrow(ConfigError);
      expect(() => buildAgentWithModel('')).toThrow(/No model configured/);
    });

    it('throws a ConfigError when the model is null (nothing in the resolution chain)', () => {
      // The resolution layer can pass null through when no layer (CLI,
      // profile, env, config, provider) supplies a model.
      expect(() => buildAgentWithModel(null)).toThrow(ConfigError);
      expect(() => buildAgentWithModel(null)).toThrow(/No model configured/);
    });

    it('throws a ConfigError when the model is whitespace-only', () => {
      expect(() => buildAgentWithModel('   ')).toThrow(/No model configured/);
    });

    it('accepts a valid model', () => {
      const agent = buildAgentWithModel('test-model');
      expect(agent.model).toBe('test-model');
    });
  });

  describe('maxToolCallsPerIteration', () => {
    it('skips tool calls exceeding maxToolCallsPerIteration limit', async () => {
      const tool1 = simpleTool('tool1', 'result1');
      const tool2 = simpleTool('tool2', 'result2');
      const tool3 = simpleTool('tool3', 'result3');

      const mockLLM = new MockLLMClient({
        responseSequences: [
          // First call: 3 tool calls but limit is 2
          buildStreamResponse({
            content: '',
            toolCalls: [
              { index: 0, name: 'tool1', arguments: '{}', id: 'call_1' },
              { index: 1, name: 'tool2', arguments: '{}', id: 'call_2' },
              { index: 2, name: 'tool3', arguments: '{}', id: 'call_3' },
            ],
            usage: { total_tokens: 10 },
          }),
          // Second call: final response
          buildStreamResponse({ content: 'Done', usage: { total_tokens: 20 } }),
        ],
      });

      const { agent, toolRegistry } = createFixture({ mockLLM, maxIterations: 5 });
      agent.maxToolCallsPerIteration = 2;
      toolRegistry.register('tool1', tool1);
      toolRegistry.register('tool2', tool2);
      toolRegistry.register('tool3', tool3);

      await agent.run('test');

      expect(tool1.executeCount).toBe(1);
      expect(tool2.executeCount).toBe(1);
      expect(tool3.executeCount).toBe(0); // skipped

      // Context should contain skipped tool result
      const ctx = agent.context.log.getAll();
      const skippedResult = ctx.find(m =>
        m.role === 'tool' &&
        (m.content as string).includes('Skipped due to maxToolCallsPerIteration')
      );
      expect(skippedResult).toBeTruthy();
    });
  });

  describe('streaming_reasoning_chunk output', () => {
    it('emits streaming_reasoning_chunk when stream is enabled', async () => {
      const events: OutputEvent[] = [];
      const sink = { emit: (e: OutputEvent) => events.push(e) };
      const mockLLM = new MockLLMClient({
        responseSequences: [[
          { type: 'reasoning', content: 'Thinking...' },
          { type: 'content', content: 'Answer' },
          { type: 'usage', data: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } },
        ]],
      });
      const { agent } = createFixture({ mockLLM, stream: true, sink });

      await agent.run('test');

      // OUTPUT_EVENT.STREAMING_REASONING_CHUNK is the numeric type
      const reasoningEvents = events.filter(e => e.type === OUTPUT_EVENT.STREAMING_REASONING_CHUNK);
      expect(reasoningEvents.length).toBeGreaterThan(0);
      expect(reasoningEvents[0]?.content).toBe('Thinking...');
    });
  });

  describe('replaceContext', () => {
    it('replaces context and fires CONTEXT_REPLACED hook', async () => {
      const { agent, hooks } = createFixture({});
      agent.addMessage(new Message({ role: 'user', content: 'old message' }));
      agent.addMessage(new Message({ role: 'assistant', content: 'old response' }));

      const hookCalls: Array<{ oldContext: Message[]; newContext: Message[] }> = [];
      hooks.on(HOOKS.CONTEXT_REPLACED, (data: { oldContext: Message[]; newContext: Message[] }) => {
        hookCalls.push({ oldContext: data.oldContext, newContext: data.newContext });
      });

      const newContext = [
        new Message({ role: 'user', content: 'compacted message' }),
      ];
      agent.replaceContext(newContext);

      expect(agent.context.log.getAll()).toEqual(newContext);
      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0]!.oldContext).toHaveLength(2);
      expect(hookCalls[0]!.newContext).toEqual(newContext);
    });
  });

  describe('isRestoring', () => {
    it('fires SESSION_RESTORE_ACTIVE hook when changed', async () => {
      const { agent, hooks } = createFixture({});
      const hookCalls: boolean[] = [];
      hooks.on(HOOKS.SESSION_RESTORE_ACTIVE, (data: { isRestoring: boolean }) => {
        hookCalls.push(data.isRestoring);
      });

      agent.isRestoring = true;
      expect(hookCalls).toEqual([true]);

      agent.isRestoring = false;
      expect(hookCalls).toEqual([true, false]);

      // No hook when value unchanged
      agent.isRestoring = false;
      expect(hookCalls).toEqual([true, false]);
    });
  });

  describe('enqueue', () => {
    it('calls enqueueCallback when configured', async () => {
      const enqueued: Array<string | unknown[]> = [];
      const { agent } = createFixture({});
      agent.enqueueCallback = (content) => { enqueued.push(content); };
      agent.enqueue('test message');
      expect(enqueued).toEqual(['test message']);
    });

    it('passes content parts through verbatim', async () => {
      const enqueued: Array<string | unknown[]> = [];
      const { agent } = createFixture({});
      agent.enqueueCallback = (content) => { enqueued.push(content); };
      const parts = [
        { type: 'text', text: '[Task t1 completed]\n' },
        { type: 'untrusted', text: 'raw result' },
      ];
      agent.enqueue(parts, { source: 'harness' });
      expect(enqueued).toEqual([parts]);
    });
  });

  // ── Turn-end semantics ────────────────────────────────────────────────────

  describe('turn-end semantics', () => {
    it('emits a single TURN_END per iteration with accurate reason', async () => {
      const tool = simpleTool('echo', 'echoed');
      const mockLLM = new MockLLMClient({
        responseSequences: [
          buildStreamResponse({
            content: 'Using tool.',
            toolCalls: [{ index: 0, name: 'echo', arguments: '{}', id: 'call_1' }],
            usage: { total_tokens: 10 },
          }),
          buildStreamResponse({ content: 'Done.', usage: { total_tokens: 20 } }),
        ],
      });

      const { agent, toolRegistry, hooks } = createFixture({ mockLLM });
      toolRegistry.register('echo', tool);

      const turnEnds: Array<{ turnIndex: number; stopped: boolean; reason?: string }> = [];
      hooks.on(HOOKS.TURN_END, (d: { turnIndex: number; stopped: boolean; reason?: string }) => {
        turnEnds.push({ turnIndex: d.turnIndex, stopped: d.stopped, reason: d.reason });
      });

      await agent.run('Test');

      expect(turnEnds).toHaveLength(2);
      expect(turnEnds[0]!.stopped).toBe(false);
      expect(turnEnds[0]!.reason).toBe('continue');
      expect(turnEnds[1]!.stopped).toBe(true);
      expect(turnEnds[1]!.reason).toBe('completion');
      // Exactly one turn-end per iteration: continue (iter 1), completion (iter 2).
      // No double-emit for the same iteration.
      expect(turnEnds[1]!.turnIndex).toBe(turnEnds[0]!.turnIndex + 1);
    });

    it('emits honest max_iterations turn-end without double-emit', async () => {
      const tool = simpleTool('looper', 'looped');
      const mockLLM = new MockLLMClient({
        responseSequences: [
          buildStreamResponse({ content: '', toolCalls: [{ index: 0, name: 'looper', arguments: '{}', id: 'call_1' }], usage: { total_tokens: 10 } }),
          buildStreamResponse({ content: '', toolCalls: [{ index: 0, name: 'looper', arguments: '{}', id: 'call_2' }], usage: { total_tokens: 20 } }),
          buildStreamResponse({ content: '', toolCalls: [{ index: 0, name: 'looper', arguments: '{}', id: 'call_3' }], usage: { total_tokens: 30 } }),
        ],
      });

      const { agent, toolRegistry, hooks } = createFixture({ mockLLM, maxIterations: 3 });
      toolRegistry.register('looper', tool);

      const turnEnds: Array<{ stopped: boolean; reason?: string }> = [];
      hooks.on(HOOKS.TURN_END, (d: { stopped: boolean; reason?: string }) => {
        turnEnds.push({ stopped: d.stopped, reason: d.reason });
      });

      await expect(agent.run('Loop')).rejects.toThrow('Max iterations');

      // 3 continue + 1 honest max_iterations — no double-emit
      expect(turnEnds).toHaveLength(4);
      expect(turnEnds.filter((e) => e.reason === 'continue')).toHaveLength(3);
      const last = turnEnds[3]!;
      expect(last.reason).toBe('max_iterations');
      expect(last.stopped).toBe(true);
    });

    it('emits cancelled turn-end when cancelled mid-stream', async () => {
      const mockLLM = new MockLLMClient({
        responseSequences: [
          (async function* () {
            yield { type: 'content', content: 'Starting...' };
            await new Promise(() => {}); // hang until cancelled
          })() as unknown as Record<string, unknown>[],
        ],
        cancelable: true,
      });

      const { agent, hooks } = createFixture({ mockLLM });
      const turnEnds: Array<{ stopped: boolean; cancelled?: boolean; reason?: string }> = [];
      hooks.on(HOOKS.TURN_END, (d: { stopped: boolean; cancelled?: boolean; reason?: string }) => {
        turnEnds.push({ stopped: d.stopped, cancelled: d.cancelled, reason: d.reason });
      });

      const runPromise = agent.run('Cancel me');
      await Promise.resolve();
      agent.cancel();

      await expect(runPromise).rejects.toThrow(/cancelled/i);
      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0]!.stopped).toBe(true);
      expect(turnEnds[0]!.cancelled).toBe(true);
      expect(turnEnds[0]!.reason).toBe('cancelled');
    });

    it('emits error turn-end (not completion) when system prompt build fails', async () => {
      const mockLLM = new MockLLMClient({
        responseSequences: [buildStreamResponse({ content: 'Done.', usage: { total_tokens: 10 } })],
      });

      const { agent, hooks } = createFixture({ mockLLM });
      agent.ensureSystemPrompt = async () => { throw new Error('system prompt boom'); };

      const turnEnds: Array<{ stopped: boolean; reason?: string }> = [];
      hooks.on(HOOKS.TURN_END, (d: { stopped: boolean; reason?: string }) => {
        turnEnds.push({ stopped: d.stopped, reason: d.reason });
      });

      await expect(agent.run('Hi')).rejects.toThrow('system prompt boom');
      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0]!.stopped).toBe(true);
      expect(turnEnds[0]!.reason).toBe('error');
    });
  });

  describe('applyProfile', () => {
    // SwitchProfile shape (see config/profiles.ts).
    const makeProfile = (overrides: Record<string, unknown> = {}) => ({
      role: 'New role',
      body: 'New body',
      model: null as string | null,
      whitelistTools: null as string[] | null,
      blacklistTools: [] as string[],
      ...overrides,
    });

    it('applies name, role, body, and whitelist', () => {
      const { agent } = createFixture({});
      agent.applyProfile('fresh', makeProfile({ whitelistTools: ['alpha'] }));
      expect(agent.profileName).toBe('fresh');
      expect(agent.role).toBe('New role');
      expect(agent.profileBody).toBe('New body');
      expect(agent.toolWhitelist).toEqual(['alpha']);
    });

    it('treats empty role/body as unset', () => {
      const { agent } = createFixture({});
      agent.applyProfile('empty', makeProfile({ role: '', body: '' }));
      expect(agent.role).toBeUndefined();
      expect(agent.profileBody).toBeUndefined();
    });

    it('filters tool defs by the new whitelist and blacklist', async () => {
      const { agent, toolRegistry } = createFixture({});
      toolRegistry.register('alpha', simpleTool('alpha'));
      toolRegistry.register('beta', simpleTool('beta'));

      agent.applyProfile('restricted', makeProfile({ whitelistTools: ['alpha'] }));
      let names = (await agent.getToolDefs()).map((d) => d.function.name);
      expect(names).toEqual(['alpha']);

      // A profile with no whitelist lifts the previous one.
      agent.applyProfile('open', makeProfile({ blacklistTools: ['alpha'] }));
      names = (await agent.getToolDefs()).map((d) => d.function.name);
      expect(names).toEqual(['beta']);
    });

    it('a profile without a blacklist clears a top-level config blacklist', async () => {
      const { agent, toolRegistry } = createFixture({
        config: { blacklistTools: ['beta'] } as Record<string, unknown>,
      });
      toolRegistry.register('alpha', simpleTool('alpha'));
      toolRegistry.register('beta', simpleTool('beta'));

      let names = (await agent.getToolDefs()).map((d) => d.function.name);
      expect(names).toEqual(['alpha']);

      agent.applyProfile('open', makeProfile());
      names = (await agent.getToolDefs()).map((d) => d.function.name);
      expect(names).toEqual(['alpha', 'beta']);
    });

    it('invalidates the cached system prompt and rebuilds with the new profile', async () => {
      const { agent } = createFixture({});
      await agent.ensureSystemPrompt();
      expect(agent.context.getSystemPrompt()).toContain('Test agent');

      agent.applyProfile('other', makeProfile({ role: 'Audit mode' }));
      expect(agent.context.getSystemPrompt()).toBeNull();

      await agent.ensureSystemPrompt();
      expect(agent.context.getSystemPrompt()).toContain('Audit mode');
    });

    it('switches the model via the model setter when the profile specifies one', () => {
      const { agent, hooks } = createFixture({
        model: 'prov/old-model',
        modelRegistry: {
          'prov/old-model': { name: 'old-model', contextLimit: 128000 },
          'prov/new-model': { name: 'new-model', contextLimit: 64000 },
        },
      });
      const changes: Array<{ oldModel: string; newModel: string }> = [];
      hooks.on(HOOKS.MODEL_CHANGE, (d: { oldModel: string; newModel: string }) => {
        changes.push({ oldModel: d.oldModel, newModel: d.newModel });
      });

      agent.applyProfile('big-brain', makeProfile({ model: 'prov/new-model' }));
      expect(agent.model).toBe('prov/new-model');
      expect(agent.contextLimit).toBe(64000);
      expect(changes).toEqual([{ oldModel: 'prov/old-model', newModel: 'prov/new-model' }]);
    });

    it('keeps the current model when the profile has none (and does not fire MODEL_CHANGE)', () => {
      const { agent, hooks } = createFixture({ model: 'prov/only-model' });
      const changes: unknown[] = [];
      hooks.on(HOOKS.MODEL_CHANGE, (d: unknown) => { changes.push(d); });

      agent.applyProfile('no-model', makeProfile());
      expect(agent.model).toBe('prov/only-model');
      expect(changes).toHaveLength(0);
    });

    it('does not clear the message log', () => {
      const { agent } = createFixture({});
      agent.addMessage(new Message({ role: 'user', content: 'hello' }));
      agent.applyProfile('fresh', makeProfile());
      expect(agent.context.log.getAll()).toHaveLength(1);
    });
  });
});

describe('Agent — run() re-entrancy guard', () => {
  // A client whose stream gates on an externally-resolved promise, so the
  // first run is provably mid-flight when the second run() is attempted.
  function gatedFixture() {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    class GatedLLM extends MockLLMClient {
      override chatStreamCancellable(
        messages: unknown[],
        modelConfig: Record<string, unknown>,
        toolDefs: Record<string, unknown>[],
        cancelSignal: AbortSignal | null | undefined,
      ) {
        const inner = super.chatStreamCancellable(
          messages, modelConfig, toolDefs, cancelSignal,
        ) as AsyncGenerator<Record<string, unknown>>;
        return (async function* (): AsyncGenerator<Record<string, unknown>> {
          await gate;
          yield* inner;
        })();
      }
    }

    const mockLLM = new GatedLLM({
      responseSequences: [
        [{ type: 'content', content: 'first run done' }],
        [{ type: 'content', content: 'third run done' }],
      ],
    });
    const { agent } = createFixture({ mockLLM });
    return { agent, mockLLM, release };
  }

  it('rejects a concurrent run() while the first is mid-flight', async () => {
    const { agent, release } = gatedFixture();

    const first = agent.run('first');
    // Let the first run reach the gated stream.
    await new Promise((r) => setTimeout(r, 10));

    let caught: unknown;
    try {
      await agent.run('second');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as Error).message).toContain('already running');

    // The rejected run must not have touched the context.
    const userMsgs = agent.context.log.getAll().filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);

    release();
    const result = await first;
    expect(expectCompletion(result).content).toBe('first run done');
  });

  it('clears the guard after the first run completes', async () => {
    const { agent, release } = gatedFixture();

    const first = agent.run('first');
    await new Promise((r) => setTimeout(r, 10));
    release();
    await first;

    // A fresh (ungated) sequence would be consumed here; the mock has one
    // left and would return an empty stream otherwise.
    const third = await agent.run('third');
    expect(expectCompletion(third).content).toBe('third run done');
  });

  it('clears the guard when the run throws', async () => {
    const mockLLM = new MockLLMClient({ responseSequences: [] });
    mockLLM.chatStreamCancellable = () => {
      throw new Error('boom');
    };
    const { agent } = createFixture({ mockLLM });

    let threw = false;
    try {
      await agent.run('x');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // The flag must be released even on the error path.
    mockLLM.chatStreamCancellable = () =>
      (async function* (): AsyncGenerator<Record<string, unknown>> {
        yield { type: 'content', content: 'recovered' };
      })();
    const result = await agent.run('y');
    expect(expectCompletion(result).content).toBe('recovered');
  });
});
