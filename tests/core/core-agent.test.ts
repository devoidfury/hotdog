// Tests for the core Agent class — full end-to-end agent loop.

import { Agent, HOOKS, ACTIONS } from '../../src/core/index.ts';
import { createHooks } from '../../src/core/hooks.ts';
import { createToolRegistry } from '../../src/core/extensions/tool-registry.ts';
import { Message } from '../../src/core/context/message.ts';
import { resolveModelConfig } from '../../src/core/config/providers.ts';
import type { LlmClient } from '../../src/core/llm-client/client.ts';
import type { OutputEvent, SessionStateEvent } from '../../src/core/context/output.ts';
import { OUTPUT_EVENT } from '../../src/core/context/output.ts';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  MockLLMClient,
  MockTool,
  buildStreamResponse,
  simpleTool,
  validatedTool,
  failingTool,
  metadataTool,
  createFixture,
} from '../helpers.ts';
import type { AgentRunResult } from '../../src/core/agent.ts';

/** Assert result is a completion and return it narrowed. */
function expectCompletion(result: AgentRunResult | undefined | null): { type: 'completion'; content: string } {
  expect(result?.type).toBe('completion');
  return result as { type: 'completion'; content: string };
}

/** Assert result is a tool_return and return it narrowed. */
function expectToolReturn(result: AgentRunResult | undefined | null): { type: 'tool_return'; outcome: string } {
  expect(result?.type).toBe('tool_return');
  return result as { type: 'tool_return'; outcome: string };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Agent — end-to-end loop', () => {
  let fixture: ReturnType<typeof createFixture> | null;

  beforeEach(() => {
    fixture = null; // created per-test
  });

  afterEach(() => {
    fixture?.agent.resetCancel();
  });

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
    const ctx = agent.log.getAll();
    expect(ctx).toHaveLength(2);
    expect(ctx[0]!.role).toBe('user');
    expect(ctx[1]!.role).toBe('assistant');
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
    expect(agent.log.at(1)!.reasoningContent).toBe('I need to think about this carefully.');
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
    const ctx = agent.log.getAll();
    const assistantMsg = ctx.find(m => m.role === 'assistant' && m.toolCalls);
    const toolMsg = ctx.find(m => m.role === 'tool');
    expect(assistantMsg).toBeTruthy();
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content as string).toContain('42');
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
    const ctx = agent.log.getAll();
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
    const toolMsg = agent.log.getAll().find(m => m.role === 'tool');
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

    // Verify error was recorded
    const toolMsg = agent.log.getAll().find(m => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content as string).toContain('Unknown tool');
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
    const toolMsg = agent.log.getAll().find(m => m.role === 'tool');
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
    const ctx = agent.log.getAll();
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
    expect(turnEvents[0]!.index).toBe(1);
    expect(turnEvents[1]!.type).toBe('end');
    expect(turnEvents[1]!.index).toBe(1);
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
    const toolMsg = agent.log.getAll().find(m => m.role === 'tool');
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
    const toolMsg = agent.log.getAll().find(m => m.role === 'tool');
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
    const ctx = agent.log.getAll();
    const followUpMsg = ctx.find(m => m.role === 'user' && m.content === 'Follow-up message');
    expect(followUpMsg).toBeTruthy();
  });

  // ── Serialize / deserialize full agent state ──────────────────────────────

  it('should serialize and deserialize full agent state', async () => {
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

    expect(serialized.sessionId).toBe('test-session');
    expect((serialized.context as unknown[]).length).toBe(2);
    expect(serialized.reasoningEffort).toBe('high');
    expect(serialized.model).toBe('test-model');

    // Deserialize into a fresh agent
    const freshAgent = new Agent({
      hooks: createHooks(),
      toolRegistry: createToolRegistry(),
      llmClient: new MockLLMClient() as unknown as LlmClient,
      model: 'test-model',
      maxIterations: 100,
      contextLimit: 128000,
    });
    freshAgent.deserialize(serialized);

    expect(freshAgent.sessionId).toBe('test-session');
    expect(freshAgent.log.length).toBe(2);
    expect(freshAgent.log.at(0)!.role).toBe('user');
    expect(freshAgent.log.at(0)!.content).toBe('test message');
    expect(freshAgent.log.at(1)!.role).toBe('assistant');
    expect(freshAgent.log.at(1)!.reasoningContent).toBe('thinking...');
    expect((freshAgent.log.at(1)!.toolCalls as Array<unknown>).length).toBe(1);
    expect(freshAgent.reasoningEffort).toBe('high');
    expect(freshAgent.model).toBe('test-model');
  });

  // ── Existing tests (preserved) ────────────────────────────────────────────

  describe('context', () => {
    it('should allow clearing context', async () => {
      const { agent } = createFixture({});
      agent.addMessage(new Message({ role: 'user', content: 'hello' }));
      await agent.clearContext();
      expect(agent.log.getAll()).toEqual([]);
      expect(agent.iterationCount).toBe(0);
    });
  });

  describe('tool registry access', () => {
    it('should return registered tool definitions and names', async () => {
      const { agent, toolRegistry } = createFixture({});
      const tool = {
        toToolDef: () => ({ type: 'function', function: { name: 'test-tool', description: '', parameters: {} } }),
        execute: async () => 'result',
      } as any;
      toolRegistry.register('test-tool', tool);

      expect(await agent.getToolDefs()).toEqual([
        { type: 'function', function: { name: 'test-tool', description: '', parameters: {} } },
      ]);
      expect(agent.getToolNames()).toEqual(['test-tool']);
    });
  });

  describe('executeCommand (existing)', () => {
    it('should handle clear command', async () => {
      const { agent } = createFixture({});
      agent.addMessage(new Message({ role: 'user', content: 'hello' }));
      const result = await agent.executeCommand({ type: 'clear', value: null });
      expect(result).toEqual({ action: ACTIONS.DISPLAY, content: 'Context cleared.' });
      expect(agent.log.getAll()).toEqual([]);
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
      // Hook results are passed through unchanged — no default action is added.
      // The MessageBus backward-compat path handles results without an action field.
      expect(result).toEqual({ content: 'custom handled' });
    });

    it('should return error for unknown commands', async () => {
      const { agent } = createFixture({});
      const result = await agent.executeCommand({ type: 'unknown-cmd', value: null });
      expect(result).toEqual({ action: ACTIONS.ERROR, error: 'Unknown command: unknown-cmd' });
    });

    it('should dispatch custom commands', async () => {
      const { agent } = createFixture({});
      let called = false;
      const cmd = { type: 'custom', value: 'test', _customCommand: true, _handler: async () => { called = true; return { content: 'handled' }; } } as any;
      const result = await agent.executeCommand(cmd);
      expect(called).toBe(true);
      expect((result as any).content).toBe('handled');
    });

    it('should fall through to hooks when custom handler returns null', async () => {
      const { agent, hooks } = createFixture({});
      hooks.on('command:dispatch', (data: { command: { type: string } }) => {
        if (data.command.type === 'fallback') return { content: 'hook handled' };
      });
      const cmd = { type: 'fallback', value: 'test', _customCommand: true, _handler: async () => null } as any;
      const result = await agent.executeCommand(cmd);
      expect((result as any).content).toBe('hook handled');
    });

    it('should fall through to command registry', async () => {
      const { agent } = createFixture({});
      const registry = agent.commandRegistry;
      registry.register('test-cmd', { handler: async () => ({ content: 'registered' }) });
      const result = await agent.executeCommand({ type: 'test-cmd', value: '' });
      expect((result as any).content).toBe('registered');
    });
  });

  describe('hooks integration (existing)', () => {
    it('should call SYSTEM_PROMPT_BUILD handlers and collect returned chunks', async () => {
      const { agent, hooks } = createFixture({});
      hooks.on(HOOKS.SYSTEM_PROMPT_BUILD, async ({ agent: a }: { agent: unknown }) => {
        return { name: 'test-chunk', priority: 500, content: '\n# Test Chunk' };
      });

      await agent.ensureSystemPrompt();
      expect(agent.systemPrompt).toContain('Test Chunk');
    });
  });

  describe('resolveModelConfig', () => {
    it('should include reasoning_effort from model registry', () => {
      const registry: Record<string, { name: string; temperature: number | null; contextLimit: number; reasoningEffort: string; tags: string[] }> = {
        'test-model': { name: 'test-model', temperature: 0.5, contextLimit: 100, reasoningEffort: 'high', tags: [] },
      };
      const config = resolveModelConfig('test-model', registry, 128000, undefined);
      expect(config.reasoningEffort).toBe('high');
    });

    it('should override reasoning_effort from runtime setting', () => {
      const registry: Record<string, { name: string; temperature: number | null; contextLimit: number; reasoningEffort: string; tags: string[] }> = {
        'test-model': { name: 'test-model', temperature: 0.5, contextLimit: 100, reasoningEffort: 'low', tags: [] },
      };
      const config = resolveModelConfig('test-model', registry, 128000, 'max');
      expect(config.reasoningEffort).toBe('max');
    });

    it('should omit reasoning_effort when not set anywhere', () => {
      const registry: Record<string, { name: string; temperature: number | null; contextLimit: number; tags: string[] }> = {
        'test-model': { name: 'test-model', temperature: 0.5, contextLimit: 100, tags: [] },
      };
      const config = resolveModelConfig('test-model', registry, 128000, undefined);
      expect(config.reasoningEffort).toBeUndefined();
    });
  });

  describe('serialize/deserialize', () => {
    it('should handle undefined reasoning_effort in deserialize', () => {
      const { agent } = createFixture({});
      const serialized = agent.serialize();
      expect(serialized.reasoningEffort).toBeUndefined();

      const newAgent = new Agent({
        hooks: createHooks(),
        toolRegistry: createToolRegistry(),
        llmClient: new MockLLMClient() as unknown as LlmClient,
        model: 'test',
        maxIterations: 100,
        contextLimit: 128000,
      });
      newAgent.reasoningEffort = 'high';
      newAgent.deserialize(serialized);
      expect(newAgent.reasoningEffort).toBeUndefined();
    });

    it('should serialize with no context', () => {
      const { agent } = createFixture({ sessionId: 'test-session' });
      const serialized = agent.serialize();
      expect(serialized.sessionId).toBe('test-session');
      expect(serialized.context).toEqual([]);
    });

    it('should handle deserialize with empty data', () => {
      const { agent } = createFixture({});
      agent.deserialize({ sessionId: 'new-id', context: [], model: 'new-model' });
      expect(agent.sessionId).toBe('new-id');
      expect(agent.model).toBe('new-model');
    });
  });

  describe('model setter with sink', () => {
    it('should emit session_state when sink is attached', () => {
      const events: OutputEvent[] = [];
      const sink = { emit: (e: OutputEvent) => events.push(e) };
      const { agent } = createFixture({ sink, model: 'old-model' });
      agent.model = 'new-model';
      const modelEvent = events.find(e => e.type === OUTPUT_EVENT.SESSION_STATE && e.key === 'model');
      expect(modelEvent).toBeDefined();
      expect((modelEvent as SessionStateEvent).value).toBe('new-model');
    });
  });

  describe('isRestoring', () => {
    it('should notify hook on change', () => {
      const hooks = createHooks();
      const hookCalls: unknown[] = [];
      hooks.on('session:restoreActive', (data) => hookCalls.push(data));
      const { agent } = createFixture({ hooks });
      agent.isRestoring = true;
      expect(hookCalls.length).toBeGreaterThan(0);
      expect((hookCalls[0] as { isRestoring: boolean }).isRestoring).toBe(true);
    });
  });

  describe('cancel with abortController', () => {
    it('should abort the run abort controller', () => {
      const { agent } = createFixture({});
      agent.runAbortController = new AbortController();
      expect(agent.runAbortController.signal.aborted).toBe(false);
      agent.cancel();
      expect(agent.cancelled).toBe(true);
      expect(agent.runAbortController.signal.aborted).toBe(true);
    });

    it('should handle missing abort controller', () => {
      const { agent } = createFixture({});
      agent.runAbortController = null;
      expect(() => agent.cancel()).not.toThrow();
      expect(agent.cancelled).toBe(true);
    });
  });

  // Tool execution error handling is covered in tool-executor.test.ts

  describe('_executeSingleToolCall invalid tool name', () => {
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
      const msgs = agent.log.getAll();
      expect(msgs.some(m => m.role === 'tool' && (m.content as string).includes('missing a valid name'))).toBe(true);
    });
  });

  describe('notifyCompletion', () => {
    it('should call onTaskComplete on sink', () => {
      let called = false;
      const sink = { emit: () => {}, onTaskComplete: (r: unknown) => { called = true; } };
      const { agent } = createFixture({ sink });
      agent.notifyCompletion('done');
      expect(called).toBe(true);
    });

    it('should handle missing sink', () => {
      const { agent } = createFixture({ sink: null });
      expect(() => agent.notifyCompletion('done')).not.toThrow();
    });
  });

  describe('_processStream finish reason', () => {
    it('should handle length finish reason', async () => {
      const mockLLM = new MockLLMClient({
        responseSequences: [[
          { type: 'content', content: 'Hello' },
          { type: 'finish', reason: 'length' },
          { type: 'usage', data: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } },
        ]],
      });
      const { agent } = createFixture({ mockLLM, stream: true });
      const result = await agent.run('test');
      expect((result as any)?.content).toBe('Hello');
    });

    it('should handle stop finish reason', async () => {
      const mockLLM = new MockLLMClient({
        responseSequences: [[
          { type: 'content', content: 'Hi' },
          { type: 'finish', reason: 'stop' },
          { type: 'usage', data: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } },
        ]],
      });
      const { agent } = createFixture({ mockLLM, stream: true });
      const result = await agent.run('test');
      expect((result as any)?.content).toBe('Hi');
    });
  });

  describe('addMessage / replaceContext', () => {
    it('addMessage fires CONTEXT_MESSAGE hook', () => {
      const hooks = createHooks();
      const calls: unknown[] = [];
      hooks.on('context:message', (data) => calls.push(data));
      const { agent } = createFixture({ hooks });
      const msg = new Message({ role: 'user', content: 'hello' });
      agent.addMessage(msg);
      expect(agent.log.length).toBe(1);
      expect(calls.length).toBeGreaterThan(0);
      expect((calls[0] as { message: Message }).message).toBe(msg);
    });

    it('replaceContext fires CONTEXT_REPLACED hook', () => {
      const hooks = createHooks();
      const calls: unknown[] = [];
      hooks.on('context:replaced', (data) => calls.push(data));
      const { agent } = createFixture({ hooks });
      const msgs = [new Message({ role: 'user', content: 'new' })];
      agent.replaceContext(msgs);
      expect(agent.log.length).toBe(1);
      expect(calls.length).toBeGreaterThan(0);
      expect((calls[0] as { newContext: Message[] }).newContext).toBe(msgs);
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
      const usage = agent.getTokenUsage();
      expect(usage.promptTokens).toBe(5);
      expect(usage.completionTokens).toBe(10);
      expect(usage.totalTokens).toBe(15);
    });
  });

  describe('streaming state', () => {
    it('returns empty strings for streaming content when not streaming', () => {
      const { agent } = createFixture({});
      expect(agent.currentStreamingContent).toBe('');
      expect(agent.currentStreamingReasoning).toBe('');
    });

    it('clears streaming content after run completes', async () => {
      const mockLLM = new MockLLMClient({
        responseSequences: [[
          { type: 'reasoning', content: 'Thinking...' },
          { type: 'content', content: 'Answer' },
          { type: 'usage', data: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } },
        ]],
      });
      const { agent } = createFixture({ mockLLM });
      await agent.run('test');
      expect(agent.currentStreamingContent).toBe('');
      expect(agent.currentStreamingReasoning).toBe('');
    });
  });

  describe('enqueue', () => {
    it('calls enqueueCallback when configured', () => {
      const queued: string[] = [];
      const { agent } = createFixture({});
      // Access private field for testing — enqueue is used by hooks/MessageBus integration
      (agent as any).enqueueCallback = (text: string) => queued.push(text);
      agent.enqueue('follow-up');
      expect(queued).toEqual(['follow-up']);
    });

    it('is no-op when no callback configured', () => {
      const { agent } = createFixture({});
      expect(() => agent.enqueue('test')).not.toThrow();
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
      const ctx = agent.log.getAll();
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
});
