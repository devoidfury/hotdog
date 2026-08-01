// Integration tests for the Agent class.
// Focuses on scenarios that span multiple components: parallel tool calling,
// hook pipelines, multi-turn conversations, and output event flow.
// Note: Basic agent loop tests are in core-agent.test.ts to avoid duplication.

import { describe, it, expect } from 'bun:test';
import { HOOKS, GateAction, ContextHookResult } from '../../src/core/hooks.ts';
import { Message } from '../../src/core/context/message.ts';
import { OUTPUT_EVENT } from '../../src/core/context/output.ts';
import type { OutputEvent } from '../../src/core/context/output.ts';
import { MockLLMClient, buildStreamResponse, MockTool } from '../helpers.ts';
import { createFixture } from '../mocks/fixtures.ts';
import { expectCompletion } from '../test-helpers.ts';

/**
 * A MockLLMClient that uses a custom async generator for streaming.
 * Used for tests that need fine-grained control over stream timing.
 */
class CustomStreamLLMClient extends MockLLMClient {
  private customGenerator: () => AsyncGenerator<Record<string, unknown>>;

  constructor(generator: () => AsyncGenerator<Record<string, unknown>>) {
    super({});
    this.customGenerator = generator;
  }

  chatStreamCancellable(
    messages: unknown[],
    modelConfig: Record<string, unknown>,
    toolDefs: Record<string, unknown>[],
    cancelSignal: AbortSignal | null | undefined,
    sessionId?: string,
  ): AsyncGenerator<Record<string, unknown>, void, unknown> {
    this.callCount++;
    this.lastMessages = messages;
    this.lastModelConfig = modelConfig;
    this.lastToolDefs = toolDefs;
    this.lastCancelSignal = cancelSignal ?? null;

    return (async function* (gen, signal) {
      for await (const event of gen()) {
        if (signal?.aborted) {
          throw new Error('Aborted');
        }
        yield event;
      }
    })(this.customGenerator, cancelSignal);
  }
}

/** Integration-test fixture with output event capture. */
function createAgentFixture(options: {
  mockLLM?: MockLLMClient;
  model?: string;
  maxIterations?: number;
  contextLimit?: number;
  stream?: boolean;
  toolWhitelist?: string[] | null;
} = {}) {
  const outputEvents: OutputEvent[] = [];
  const fixture = createFixture({
    ...options,
    sink: { emit: (event) => outputEvents.push(event) },
    sessionId: 'integration-test-session',
    maxIterations: options.maxIterations || 20,
    role: 'Test integration agent',
  });
  return { ...fixture, outputEvents };
}

// ── Parallel Tool Calling ────────────────────────────────────────────────────

describe('Agent — parallel tool calling', () => {
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

    const completion = expectCompletion(result);
    expect(completion.content).toBe('One succeeded, one failed.');
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

    const completion = expectCompletion(result);
    expect(completion.content).toBe('All done.');
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
    const completion = expectCompletion(result);
    expect(completion.content).toBe('Nice to meet you too, Alice!');
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

    const completion = expectCompletion(result);
    expect(completion.content).toBe('Done! Data processed and saved.');
    expect(readTool.executeCount).toBe(1);
    expect(writeTool.executeCount).toBe(1);
    expect(mockLLM.callCount).toBe(3);
  });
});

// ── Hook Pipeline Integration ────────────────────────────────────────────────

describe('Agent — hook pipeline integration', () => {
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

// ── Error Handling ───────────────────────────────────────────────────────────

describe('Agent — error handling', () => {
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

    const completion = expectCompletion(result);
    expect(completion.content).toBe('Handled.');
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

    const toolCalls = outputEvents.filter(e => e.type === OUTPUT_EVENT.TOOL_CALL);
    const toolResults = outputEvents.filter(e => e.type === OUTPUT_EVENT.TOOL_RESULT);

    expect(toolCalls.length).toBe(1);
    expect(toolResults.length).toBe(1);
    // Events are { type, ...data } — toolName is a direct property, not nested under .data
    expect(toolCalls[0]!.toolName).toBe('echo');
  });
});

// ── Agent Lifecycle & State ─────────────────────────────────────────────────

describe('Agent — lifecycle and state', () => {
  it('should expose isRestoring getter', () => {
    const { agent } = createAgentFixture();
    const val = agent.isRestoring;
    expect(val).toBe(false);
  });

  it('should expose toolRegistry getter', () => {
    const { agent } = createAgentFixture();
    const registry = agent.toolRegistry;
    expect(registry).toBeDefined();
    expect(typeof registry.getToolDefs).toBe('function');
  });

  it('should notify hooks when isRestoring changes', () => {
    const { agent, hooks } = createAgentFixture();
    let notified = false;
    hooks.on(HOOKS.SESSION_RESTORE_ACTIVE, () => { notified = true; });

    agent.isRestoring = true;
    expect(agent.isRestoring).toBe(true);
    expect(notified).toBe(true);

    notified = false;
    agent.isRestoring = false;
    expect(agent.isRestoring).toBe(false);
    expect(notified).toBe(true);

    // No notification when set to same value
    notified = false;
    agent.isRestoring = false;
    expect(notified).toBe(false);
  });

  it('should expose currentStreamingContent getter', () => {
    const { agent } = createAgentFixture({ stream: true });
    expect(agent.currentStreamingContent).toBe('');
  });

  it('should expose currentStreamingReasoning getter', () => {
    const { agent } = createAgentFixture({ stream: true });
    expect(agent.currentStreamingReasoning).toBe('');
  });

  it('should accumulate streaming content while running', async () => {
    const slowStream = async function* () {
      yield { type: 'content', content: 'Hello ' };
      await new Promise(r => setTimeout(r, 100));
      yield { type: 'content', content: 'world' };
      yield { type: 'usage', data: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
    };

    const mockLLM = new CustomStreamLLMClient(slowStream);

    const { agent } = createAgentFixture({ mockLLM, stream: true });
    const runPromise = agent.run('Test streaming');

    // Give the stream a moment to accumulate partial content
    await new Promise(r => setTimeout(r, 30));

    // During streaming, content should be accumulating
    const midContent = agent.currentStreamingContent;
    expect(midContent.length).toBeGreaterThan(0);

    await runPromise;

    // After completion, streaming content is reset by stream processor
    expect(agent.currentStreamingContent).toBe('');
  });

  it('should call notifyCompletion on sink with onTaskComplete', () => {
    const { agent } = createAgentFixture();
    let completed = false;
    let resultValue = '';
    const sinkWithCallback = {
      emit: () => {},
      onTaskComplete: (result: string) => {
        completed = true;
        resultValue = result;
      },
    };
    agent.sink = sinkWithCallback;

    agent.notifyCompletion('task done');
    expect(completed).toBe(true);
    expect(resultValue).toBe('task done');
  });

  it('should handle notifyCompletion when sink has no onTaskComplete', () => {
    const { agent } = createAgentFixture();
    const sinkWithoutCallback = {
      emit: () => {},
    };
    agent.sink = sinkWithoutCallback;

    // Should not throw
    expect(() => agent.notifyCompletion('task done')).not.toThrow();
  });

  it('should handle notifyCompletion when sink is null', () => {
    const { agent } = createAgentFixture();
    agent.sink = null;

    // Should not throw
    expect(() => agent.notifyCompletion('task done')).not.toThrow();
  });

  it('should cancel and resetCancel properly', () => {
    const { agent } = createAgentFixture();
    expect(agent.cancelled).toBe(false);

    agent.cancel();
    expect(agent.cancelled).toBe(true);

    agent.resetCancel();
    expect(agent.cancelled).toBe(false);
  });

  it('should respect abortSignal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Should not reach here',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      ],
    });

    const { agent } = createAgentFixture({ mockLLM, abortSignal: controller.signal });

    await expect(agent.run('Test aborted')).rejects.toThrow(/cancelled|abort/i);
  });

  it('should abort when external abortSignal fires during run', async () => {
    const controller = new AbortController();

    // Very slow stream that gives us time to abort
    const slowStream = async function* () {
      yield { type: 'content', content: 'Start ' };
      // Wait long enough for abort
      await new Promise(r => setTimeout(r, 500));
      yield { type: 'content', content: 'End' };
    };

    const mockLLM = new CustomStreamLLMClient(slowStream);

    const { agent } = createAgentFixture({ mockLLM, stream: true, abortSignal: controller.signal });

    const runPromise = agent.run('Test abort mid-stream');

    // Abort after a short delay
    setTimeout(() => controller.abort(), 30);

    await expect(runPromise).rejects.toThrow(/cancelled|abort/i);
  });

  it('should process followQueue messages before LLM call', async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Done.',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      ],
    });

    const { agent } = createAgentFixture({ mockLLM });

    // Add follow-up messages to the queue (normally done by extensions)
    agent.followQueue.push('Follow-up 1');
    agent.followQueue.push('Follow-up 2');

    await agent.run('Initial message');

    // Verify follow-up messages were added to context
    const messages = agent.log.getAll();
    const userMessages = messages.filter(m => m.role === 'user');
    expect(userMessages.length).toBe(3);
    expect((userMessages[0]?.content as string)).toBe('Initial message');
    expect((userMessages[1]?.content as string)).toBe('Follow-up 1');
    expect((userMessages[2]?.content as string)).toBe('Follow-up 2');
  });

  it('should emit output events for followQueue messages', async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: 'Done.',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      ],
    });

    const { agent, outputEvents } = createAgentFixture({ mockLLM });

    agent.followQueue.push('Queued message');

    await agent.run('Initial');

    const userMessageEvents = outputEvents.filter(e => e.type === OUTPUT_EVENT.USER_MESSAGE);
    expect(userMessageEvents.length).toBe(2);
    expect((userMessageEvents[1]?.content as string)).toBe('Queued message');
  });
});
