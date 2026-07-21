// Comprehensive integration tests for the Agent class.
// Tests parallel tool calling, hook pipelines, error handling, and full agent loops.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Agent } from '../../src/core/agent.ts';
import { HOOKS, GateAction, ContextHookResult } from '../../src/core/hooks.ts';
import { createHooks } from '../../src/core/hooks.ts';
import { createToolRegistry } from '../../src/core/extensions/tool-registry.ts';
import { Message } from '../../src/core/context/message.ts';
import type { LlmClient } from '../../src/core/llm-client/client.ts';
import type { OutputEvent } from '../../src/core/context/output.ts';
import { MockLLMClient, buildStreamResponse, MockTool, simpleTool, validatedTool, failingTool } from '../helpers.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface AgentFixture {
  hooks: ReturnType<typeof createHooks>;
  toolRegistry: ReturnType<typeof createToolRegistry>;
  mockLLM: MockLLMClient;
  agent: Agent;
  outputEvents: OutputEvent[];
}

function createAgentFixture(options: {
  mockLLM?: MockLLMClient;
  model?: string;
  maxIterations?: number;
  contextLimit?: number;
  stream?: boolean;
  toolWhitelist?: string[] | null;
} = {}): AgentFixture {
  const hooks = createHooks();
  const toolRegistry = createToolRegistry();
  const mockLLM = options.mockLLM || new MockLLMClient({ cancelable: false });
  const outputEvents: OutputEvent[] = [];

  const agent = new Agent({
    hooks,
    toolRegistry,
    llmClient: mockLLM as unknown as LlmClient,
    model: options.model || 'test-model',
    maxIterations: options.maxIterations || 20,
    contextLimit: options.contextLimit || 128000,
    hideTools: true,
    hideThinking: false,
    showTokenUse: false,
    stream: options.stream ?? false,
    sink: { emit: (event) => outputEvents.push(event) },
    modelRegistry: {},
    profileName: 'test',
    role: 'Test integration agent',
    profileBody: '',
    config: undefined,
    sessionId: 'integration-test-session',
    abortSignal: undefined,
    toolWhitelist: options.toolWhitelist || null,
  });

  return { hooks, toolRegistry, mockLLM, agent, outputEvents };
}

// ── Parallel Tool Calling ────────────────────────────────────────────────────

describe('Agent — parallel tool calling', () => {
  it('should execute multiple tools in parallel from a single LLM response', async () => {
    const toolA = new MockTool({
      name: 'tool_a',
      execute: async () => 'result_a',
    });
    const toolB = new MockTool({
      name: 'tool_b',
      execute: async () => 'result_b',
    });
    const toolC = new MockTool({
      name: 'tool_c',
      execute: async () => 'result_c',
    });

    const mockLLM = new MockLLMClient({
      responseSequences: [
        // First call: 3 parallel tool calls
        buildStreamResponse({
          content: 'I will run three tools in parallel.',
          toolCalls: [
            { index: 0, name: 'tool_a', arguments: '{"x":1}', id: 'call_a' },
            { index: 1, name: 'tool_b', arguments: '{"y":2}', id: 'call_b' },
            { index: 2, name: 'tool_c', arguments: '{"z":3}', id: 'call_c' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 },
        }),
        // Second call: final response after all tools complete
        buildStreamResponse({
          content: 'All three tools completed: result_a, result_b, result_c',
          usage: { prompt_tokens: 50, completion_tokens: 15, total_tokens: 65 },
        }),
      ],
    });

    const { agent, toolRegistry } = createAgentFixture({ mockLLM });
    toolRegistry.register('tool_a', toolA);
    toolRegistry.register('tool_b', toolB);
    toolRegistry.register('tool_c', toolC);

    const result = await agent.run('Run tools in parallel');

    expect(result).toBe('All three tools completed: result_a, result_b, result_c');
    expect(toolA.executeCount).toBe(1);
    expect(toolB.executeCount).toBe(1);
    expect(toolC.executeCount).toBe(1);
    expect(mockLLM.callCount).toBe(2);

    // Verify context: user → assistant(tool calls) → 3 tool results → assistant(final)
    const ctx = agent.log.getAll();
    expect(ctx.length).toBe(6); // user + assistant(tool calls) + 3 tool results + assistant(final)
    expect(ctx[0]!.role).toBe('user');
    expect(ctx[1]!.role).toBe('assistant');
    expect(ctx[1]!.toolCalls).toHaveLength(3);
    expect(ctx[2]!.role).toBe('tool');
    expect(ctx[3]!.role).toBe('tool');
    expect(ctx[4]!.role).toBe('tool');
  });

  it('should handle a mix of successful and failing parallel tool calls', async () => {
    const goodTool = new MockTool({
      name: 'good_tool',
      execute: async () => 'success',
    });
    const badTool = new MockTool({
      name: 'bad_tool',
      execute: async () => { throw new Error('boom'); },
    });

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Running tools...',
          toolCalls: [
            { index: 0, name: 'good_tool', arguments: '{}', id: 'call_good' },
            { index: 1, name: 'bad_tool', arguments: '{}', id: 'call_bad' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        buildStreamResponse({
          content: 'One succeeded, one failed.',
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
        }),
      ],
    });

    const { agent, toolRegistry } = createAgentFixture({ mockLLM });
    toolRegistry.register('good_tool', goodTool);
    toolRegistry.register('bad_tool', badTool);

    const result = await agent.run('Test mixed tools');

    expect(result).toBe('One succeeded, one failed.');
    expect(goodTool.executeCount).toBe(1);
    expect(badTool.executeCount).toBe(1);

    // Both tools should have results in context (one success, one error)
    const ctx = agent.log.getAll();
    const toolResults = ctx.filter(m => m.role === 'tool');
    expect(toolResults).toHaveLength(2);
    const badResult = toolResults.find(m => (m.content as string).includes('Error'));
    expect(badResult).toBeDefined();
  });

  it('should handle many parallel tool calls (stress test)', async () => {
    const toolCount = 8;
    const tools: MockTool[] = [];

    for (let i = 0; i < toolCount; i++) {
      tools.push(new MockTool({
        name: `tool_${i}`,
        execute: async () => `result_${i}`,
      }));
    }

    const toolCalls = tools.map((t, i) => ({
      index: i,
      name: t.name,
      arguments: `{}`,
      id: `call_${i}`,
    }));

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Running many tools.',
          toolCalls,
          usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 },
        }),
        buildStreamResponse({
          content: 'All done.',
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        }),
      ],
    });

    const { agent, toolRegistry } = createAgentFixture({ mockLLM });
    for (const t of tools) {
      toolRegistry.register(t.name, t);
    }

    const result = await agent.run('Stress test');

    expect(result).toBe('All done.');
    for (const t of tools) {
      expect(t.executeCount).toBe(1);
    }

    const ctx = agent.log.getAll();
    expect(ctx.length).toBe(3 + toolCount); // user + assistant + toolCount results + final
  });
});

// ── Multi-turn Conversations ─────────────────────────────────────────────────

describe('Agent — multi-turn conversations', () => {
  it('should maintain conversation context across multiple runs', async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Hello! I remember your name is Alice.',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
        buildStreamResponse({
          content: 'Nice to meet you too, Alice!',
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        }),
      ],
    });

    const { agent, mockLLM: llm } = createAgentFixture({ mockLLM });

    await agent.run('My name is Alice');
    expect(llm.callCount).toBe(1);

    const result = await agent.run('Hi again');
    expect(result).toBe('Nice to meet you too, Alice!');
    expect(llm.callCount).toBe(2);

    // The second request should include the full conversation history
    const lastMessages = llm.lastMessages as Array<Record<string, unknown>>;
    const userMessages = lastMessages.filter((m: Record<string, unknown>) => m.role === 'user');
    expect(userMessages.length).toBe(2);
    expect(userMessages[0]!.content).toBe('My name is Alice');
    expect(userMessages[1]!.content).toBe('Hi again');
  });

  it('should handle tool calls spanning multiple turns', async () => {
    const readTool = new MockTool({
      name: 'read',
      execute: async () => 'File content: important data',
    });
    const writeTool = new MockTool({
      name: 'write',
      execute: async () => 'File written',
    });

    const mockLLM = new MockLLMClient({
      responseSequences: [
        // Turn 1: read a file
        buildStreamResponse({
          content: 'Let me read the file first.',
          toolCalls: [{ index: 0, name: 'read', arguments: '{"path":"data.txt"}', id: 'call_1' }],
          usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
        }),
        // Turn 2: write to another file
        buildStreamResponse({
          content: 'Now I will write the processed data.',
          toolCalls: [{ index: 0, name: 'write', arguments: '{"path":"output.txt"}', id: 'call_2' }],
          usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 },
        }),
        // Turn 3: final response
        buildStreamResponse({
          content: 'Done! Data processed and saved.',
          usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
        }),
      ],
    });

    const { agent, toolRegistry } = createAgentFixture({ mockLLM });
    toolRegistry.register('read', readTool);
    toolRegistry.register('write', writeTool);

    const result = await agent.run('Process data.txt');

    expect(result).toBe('Done! Data processed and saved.');
    expect(readTool.executeCount).toBe(1);
    expect(writeTool.executeCount).toBe(1);
    expect(mockLLM.callCount).toBe(3);
  });
});

// ── Hook Pipeline Integration ────────────────────────────────────────────────

describe('Agent — hook pipeline integration', () => {
  it('should allow TOOL_CALL gate hook to block a tool call', async () => {
    const blockedTool = new MockTool({
      name: 'dangerous',
      execute: async () => 'should not see this',
    });

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Attempting dangerous operation.',
          toolCalls: [{ index: 0, name: 'dangerous', arguments: '{}', id: 'call_1' }],
          usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
        }),
        buildStreamResponse({
          content: 'Operation was blocked.',
          usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
        }),
      ],
    });

    const fixture = createAgentFixture({ mockLLM });
    fixture.toolRegistry.register('dangerous', blockedTool);

    // Register a gate hook that blocks "dangerous" tool
    fixture.hooks.on(HOOKS.TOOL_CALL, ({ toolName }) => {
      if (toolName === 'dangerous') {
        return { action: 'block', result: 'Access denied: tool is blocked by policy' } as GateAction;
      }
      return { action: 'continue' } as GateAction;
    });

    const result = await fixture.agent.run('Run the dangerous tool');

    expect(result).toBe('Operation was blocked.');
    expect(blockedTool.executeCount).toBe(0);

    // The tool result should contain the blocked message
    const ctx = fixture.agent.log.getAll();
    const toolResult = ctx.find(m => m.role === 'tool');
    expect(toolResult!.content).toContain('Access denied');
  });

  it('should allow TOOL_CALL gate hook to modify tool input', async () => {
    const modifyTool = new MockTool({
      name: 'search',
      execute: async (input: unknown) => {
        const parsed = JSON.parse(input as string);
        return `Searched for: ${parsed.query}`;
      },
    });

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Searching...',
          toolCalls: [{ index: 0, name: 'search', arguments: '{"query":"secret"}', id: 'call_1' }],
          usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
        }),
        buildStreamResponse({
          content: 'Search complete.',
          usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
        }),
      ],
    });

    const fixture = createAgentFixture({ mockLLM });
    fixture.toolRegistry.register('search', modifyTool);

    // Gate hook modifies the search query
    fixture.hooks.on(HOOKS.TOOL_CALL, ({ toolName, input }) => {
      if (toolName === 'search') {
        const parsed = JSON.parse(input);
        parsed.query = 'safe_query';
        return { action: 'modify', input: JSON.stringify(parsed) } as GateAction;
      }
      return { action: 'continue' } as GateAction;
    });

    await fixture.agent.run('Search for secrets');

    expect(modifyTool.executeCount).toBe(1);
    expect(modifyTool.lastInput).toBe('{"query":"safe_query"}');
  });

  it('should allow TOOL_RESULT hook to transform tool output', async () => {
    const rawTool = new MockTool({
      name: 'fetch_data',
      execute: async () => ({ raw: 'sensitive_data', public: 'safe_info' }),
    });

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Fetching data...',
          toolCalls: [{ index: 0, name: 'fetch_data', arguments: '{}', id: 'call_1' }],
          usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
        }),
        buildStreamResponse({
          content: 'Data processed.',
          usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
        }),
      ],
    });

    const fixture = createAgentFixture({ mockLLM });
    fixture.toolRegistry.register('fetch_data', rawTool);

    // Result hook sanitizes the output
    fixture.hooks.on(HOOKS.TOOL_RESULT, ({ toolName, result }) => {
      if (toolName === 'fetch_data' && typeof result === 'object') {
        const sanitized = (result as Record<string, unknown>).public;
        return { result: sanitized };
      }
      return undefined;
    });

    await fixture.agent.run('Fetch data');

    // The context should only contain the sanitized result
    const ctx = fixture.agent.log.getAll();
    const toolResult = ctx.find(m => m.role === 'tool');
    expect(toolResult!.content).toContain('safe_info');
    expect(toolResult!.content).not.toContain('sensitive_data');
  });

  it('should allow CONTEXT hook to inject messages before LLM call', async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'I have received the injected reminder.',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      ],
    });

    const fixture = createAgentFixture({ mockLLM });

    // Context hook injects a reminder message
    fixture.hooks.on(HOOKS.CONTEXT, ({ messages }) => {
      const reminder = new Message({
        role: 'user',
        content: 'Remember: always be concise.',
      });
      return { messages: [...messages, reminder] } as ContextHookResult;
    });

    await fixture.agent.run('Hello');

    // The LLM should have received the injected message
    const lastMessages = mockLLM.lastMessages as Array<Record<string, unknown>>;
    const reminderMsg = lastMessages.find(
      (m: Record<string, unknown>) => m.content === 'Remember: always be concise.'
    );
    expect(reminderMsg).toBeDefined();
  });

  it('should support chained CONTEXT hooks', async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Done.',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      ],
    });

    const fixture = createAgentFixture({ mockLLM });

    // First hook mutates the messages array in place (pipeline pattern)
    fixture.hooks.on(HOOKS.CONTEXT, ({ messages }) => {
      messages.push(new Message({ role: 'user', content: 'Reminder 1' }));
      return { messages } as ContextHookResult;
    });

    // Second hook also mutates the same array (sees the first hook's additions)
    fixture.hooks.on(HOOKS.CONTEXT, ({ messages }) => {
      messages.push(new Message({ role: 'user', content: 'Reminder 2' }));
      return { messages } as ContextHookResult;
    });

    await fixture.agent.run('Test');

    const lastMessages = mockLLM.lastMessages as Array<Record<string, unknown>>;
    const reminders = lastMessages.filter(
      (m: Record<string, unknown>) => (m.content as string)?.startsWith('Reminder')
    );
    expect(reminders.length).toBe(2);
    expect(reminders[0]!.content).toBe('Reminder 1');
    expect(reminders[1]!.content).toBe('Reminder 2');
  });
});

// ── Tool Whitelist ───────────────────────────────────────────────────────────

describe('Agent — tool whitelist', () => {
  it('should only allow whitelisted tools', async () => {
    const allowedTool = new MockTool({ name: 'allowed', execute: async () => 'ok' });
    const disallowedTool = new MockTool({ name: 'denied', execute: async () => 'should not run' });

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Running tools...',
          toolCalls: [
            { index: 0, name: 'allowed', arguments: '{}', id: 'call_1' },
            { index: 1, name: 'denied', arguments: '{}', id: 'call_2' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
        }),
        buildStreamResponse({
          content: 'Done.',
          usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
        }),
      ],
    });

    const { agent, toolRegistry } = createAgentFixture({
      mockLLM,
      toolWhitelist: ['allowed'],
    });
    toolRegistry.register('allowed', allowedTool);
    toolRegistry.register('denied', disallowedTool);

    await agent.run('Test whitelist');

    expect(allowedTool.executeCount).toBe(1);
    expect(disallowedTool.executeCount).toBe(0);

    // Denied tool should get a not-available result
    const ctx = agent.log.getAll();
    const deniedResult = ctx.find(
      m => m.role === 'tool' && (m.content as string).includes('not available')
    );
    expect(deniedResult).toBeDefined();
  });
});

// ── Error Handling ───────────────────────────────────────────────────────────

describe('Agent — error handling', () => {
  it('should handle unknown tool calls gracefully', async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Calling unknown tool.',
          toolCalls: [{ index: 0, name: 'nonexistent', arguments: '{}', id: 'call_1' }],
          usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
        }),
        buildStreamResponse({
          content: 'Tool not found.',
          usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
        }),
      ],
    });

    const { agent } = createAgentFixture({ mockLLM });

    const result = await agent.run('Use nonexistent tool');

    expect(result).toBe('Tool not found.');

    // The tool result should indicate unknown tool
    const ctx = agent.log.getAll();
    const toolResult = ctx.find(m => m.role === 'tool');
    expect(toolResult!.content).toContain('Unknown tool');
  });

  it('should handle invalid JSON in tool arguments', async () => {
    const tool = new MockTool({ name: 'test', execute: async () => 'ok' });

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Calling with bad JSON.',
          toolCalls: [{ index: 0, name: 'test', arguments: '{invalid json}', id: 'call_1' }],
          usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
        }),
        buildStreamResponse({
          content: 'Handled.',
          usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
        }),
      ],
    });

    const { agent, toolRegistry } = createAgentFixture({ mockLLM });
    toolRegistry.register('test', tool);

    const result = await agent.run('Test bad JSON');

    expect(result).toBe('Handled.');
    // Tool may not execute if validation fails, but agent should not crash
    const ctx = agent.log.getAll();
    const toolResult = ctx.find(m => m.role === 'tool');
    expect(toolResult).toBeDefined();
    const content = toolResult!.content ?? '';
    // Either the tool ran with raw input, or validation failed with an error message
    expect(
      content.includes('ok') || content.includes('Error') ||
      content.includes('validation')
    ).toBe(true);
  });
});

// ── Output Events ────────────────────────────────────────────────────────────

describe('Agent — output events', () => {
  it('should emit output events for tool calls and results', async () => {
    const tool = new MockTool({ name: 'echo', execute: async () => 'echoed' });

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Echoing...',
          toolCalls: [{ index: 0, name: 'echo', arguments: '{"msg":"hello"}', id: 'call_1' }],
          usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
        }),
        buildStreamResponse({
          content: 'Done.',
          usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
        }),
      ],
    });

    const { agent, toolRegistry, outputEvents } = createAgentFixture({ mockLLM });
    toolRegistry.register('echo', tool);

    await agent.run('Echo hello');

    // Output events use numeric OUTPUT_EVENT constants, not string names
    const toolCalls = outputEvents.filter(e => e.type === 4); // OUTPUT_EVENT.TOOL_CALL
    const toolResults = outputEvents.filter(e => e.type === 5); // OUTPUT_EVENT.TOOL_RESULT

    expect(toolCalls.length).toBe(1);
    expect(toolResults.length).toBe(1);
    // Events are { type, ...data } — toolName is a direct property, not nested under .data
    expect(toolCalls[0]!.toolName).toBe('echo');
  });
});

// ── Cancellation ─────────────────────────────────────────────────────────────

describe('Agent — cancellation', () => {
  it('should stop processing when cancelled', async () => {
    const slowTool = new MockTool({
      name: 'slow',
      execute: async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return 'done';
      },
    });

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Starting slow operation.',
          toolCalls: [{ index: 0, name: 'slow', arguments: '{}', id: 'call_1' }],
          usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
        }),
      ],
    });

    const { agent, toolRegistry } = createAgentFixture({ mockLLM });
    toolRegistry.register('slow', slowTool);

    // Cancel immediately after starting
    agent.run('Run slow tool').catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 10));
    agent.cancel();

    // Agent should be marked as cancelled
    expect(agent.cancelled).toBe(true);
  });
});
