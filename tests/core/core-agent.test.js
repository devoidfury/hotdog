// Tests for the core Agent class — full end-to-end agent loop.

import { Agent, HOOKS } from '../../src/core/index.js';
import { HookSystem, createHooks } from '../../src/core/hooks.js';
import { ToolRegistry, createToolRegistry } from '../../src/core/extensions/tool-registry.js';
import { Message } from '../../src/core/context/message.js';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

// ── Mock LLM Client ─────────────────────────────────────────────────────────
//
// Produces programmable streams of events. Each call to chatStreamCancellable
// returns an async generator that yields a preset sequence of events, then
// optionally waits for a "resume" signal before yielding the next batch.
// This lets us simulate multi-turn tool-calling conversations.

/**
 * Build a tool-call event sequence for a single tool call.
 * Returns [toolName, toolArgument] events.
 */
function buildToolCallEvents({ index, name, arguments: args, id }) {
  return [
    { type: 'toolName', index, name, toolCallId: id || `call_${index}` },
    { type: 'toolArgument', index, arguments: args },
  ];
}

/**
 * Build a complete streaming response sequence.
 */
function buildStreamResponse({
  content = '',
  reasoning = null,
  toolCalls = null,
  usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
}) {
  const events = [];

  // Reasoning before content (typical LLM order)
  if (reasoning) {
    events.push({ type: 'reasoning', content: reasoning });
  }

  // Text content
  if (content) {
    events.push({ type: 'content', content });
  }

  // Tool calls
  if (toolCalls) {
    for (const tc of toolCalls) {
      events.push(...buildToolCallEvents(tc));
    }
  }

  // Usage at the end
  events.push({ type: 'usage', data: usage });

  return events;
}

/**
 * MockLLMClient — simulates streaming LLM responses for testing.
 *
 * Each call to chatStreamCancellable yields events from a preset list.
 * Supports cancellation via AbortSignal: when aborted, the generator
 * stops yielding after the current event.
 */
class MockLLMClient {
  /**
   * @param {Array<Array<Object>>} responseSequences — One array per call.
   *   Each array is a list of stream events.
   * @param {boolean} [cancelable=false] — If true, respects abort signal.
   */
  constructor({ responseSequences = [], cancelable = false } = {}) {
    this._responseSequences = responseSequences;
    this._callIndex = 0;
    this.cancelable = cancelable;
    this.callCount = 0;
    this.lastMessages = null;
    this.lastModelConfig = null;
    this.lastToolDefs = null;
    this.lastCancelSignal = null;
  }

  /**
   * Reset call tracking for a fresh test.
   */
  reset(sequences) {
    this._responseSequences = sequences || this._responseSequences;
    this._callIndex = 0;
    this.callCount = 0;
    this.lastMessages = null;
    this.lastModelConfig = null;
    this.lastToolDefs = null;
    this.lastCancelSignal = null;
  }

  chatStreamCancellable(messages, modelConfig, toolDefs, cancelSignal) {
    this.callCount++;
    this.lastMessages = messages;
    this.lastModelConfig = modelConfig;
    this.lastToolDefs = toolDefs;
    this.lastCancelSignal = cancelSignal;

    const sequence = this._responseSequences[this._callIndex++];
    if (!sequence) {
      // No sequence defined — return empty stream
      return (async function* () {})();
    }

    return this._makeStream(sequence, cancelSignal);
  }

  async *_makeStream(events, cancelSignal) {
    for (const event of events) {
      // Check cancellation
      if (cancelSignal?.aborted) {
        return;
      }
      // Yield a tiny microtask tick so abort listeners can fire
      await Promise.resolve();
      yield event;
    }
  }
}

// ── Mock Tool ───────────────────────────────────────────────────────────────

class MockTool {
  constructor({ name, execute, toToolDef, callDisplay } = {}) {
    this.name = name || 'mock-tool';
    this._executeFn = execute || (async () => 'mock result');
    this._toToolDefFn = toToolDef || (() => ({
      type: 'function',
      function: {
        name: this.name,
        description: 'Mock tool for testing',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    }));
    this._callDisplayFn = callDisplay || null;
    this.executeCount = 0;
    this.lastInput = null;
    this.lastContext = null;
  }

  toToolDef() {
    return this._toToolDefFn();
  }

  async execute(input, ctx) {
    this.executeCount++;
    this.lastInput = input;
    this.lastContext = ctx;
    return this._executeFn(input, ctx);
  }

  callDisplay(input) {
    if (this._callDisplayFn) return this._callDisplayFn(input);
    return `mock-tool(${JSON.stringify(input)})`;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a simple mock tool that returns a fixed result.
 */
function simpleTool(name, result = 'done') {
  return new MockTool({
    name,
    execute: async () => result,
    toToolDef: () => ({
      type: 'function',
      function: {
        name,
        description: `${name} tool`,
        parameters: { type: 'object', properties: {}, required: [] },
      },
    }),
  });
}

/**
 * Create a mock tool that validates its input against a schema.
 */
function validatedTool(name, schema, execute) {
  return new MockTool({
    name,
    execute,
    toToolDef: () => ({
      type: 'function',
      function: {
        name,
        description: `${name} tool`,
        parameters: {
          type: 'object',
          properties: schema.properties || {},
          required: schema.required || [],
        },
      },
    }),
  });
}

/**
 * Create a mock tool that fails on execute.
 */
function failingTool(name, errorMsg = 'intentional failure') {
  return new MockTool({
    name,
    execute: async () => { throw new Error(errorMsg); },
    toToolDef: () => ({
      type: 'function',
      function: {
        name,
        description: `${name} tool`,
        parameters: { type: 'object', properties: {}, required: [] },
      },
    }),
  });
}

/**
 * Create a mock tool that returns a ToolResult with metadata.
 */
function metadataTool(name, metadata) {
  return new MockTool({
    name,
    execute: async () => {
      const { ToolResult } = await import('../../src/core/extensions/tool-utils.js');
      return ToolResult.ok('output').withEntries(metadata);
    },
    toToolDef: () => ({
      type: 'function',
      function: {
        name,
        description: `${name} tool`,
        parameters: { type: 'object', properties: {}, required: [] },
      },
    }),
  });
}

// ── Agent Test Fixture ──────────────────────────────────────────────────────

function createFixture(options = {}) {
  const hooks = options.hooks || createHooks();
  const toolRegistry = options.toolRegistry || createToolRegistry();

  const mockLLM = options.mockLLM || new MockLLMClient({ cancelable: false });

  const agent = new Agent({
    hooks,
    toolRegistry,
    llmClient: mockLLM,
    model: options.model || 'test-model',
    maxIterations: options.maxIterations || 10,
    maxTokens: options.maxTokens || 4096,
    hideTools: options.hideTools ?? true,
    hideThinking: options.hideThinking ?? false,
    showTokenUse: options.showTokenUse ?? false,
    stream: options.stream ?? false,
    sink: options.sink || null,
    modelRegistry: options.modelRegistry || {},
    profileName: options.profileName || 'test',
    role: options.role || 'Test agent',
    profileBody: options.profileBody || '',
    config: options.config || null,
    sessionId: options.sessionId || 'test-session',
    abortSignal: options.abortSignal || null,
    toolWhitelist: options.toolWhitelist || null,
  });

  return { hooks, toolRegistry, mockLLM, agent };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Agent — end-to-end loop', () => {
  let fixture;

  beforeEach(() => {
    fixture = null; // created per-test
  });

  afterEach(() => {
    fixture?.agent.cancel(false);
  });

  // ── Text-only response ─────────────────────────────────────────────────────

  it('should return text response when LLM returns only content', async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [[
        { type: 'content', content: 'Hello! I am an AI assistant.' },
        { type: 'usage', data: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } },
      ]],
    });

    const { agent, hooks } = createFixture({ mockLLM });

    const result = await agent.run('Hi');

    expect(result).toBe('Hello! I am an AI assistant.');
    // Note: agent.context only contains user/assistant/tool messages,
    // NOT the system prompt. The system prompt is prepended at build time.
    expect(agent.context.length).toBe(2); // user + assistant
    expect(agent.context[0].role).toBe('user');
    expect(agent.context[0].content).toBe('Hi');
    expect(agent.context[1].role).toBe('assistant');
    expect(agent.context[1].content).toBe('Hello! I am an AI assistant.');
    expect(mockLLM.callCount).toBe(1);
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

    expect(result).toBe('Here is my answer.');
    expect(agent.context[1].reasoningContent).toBe('I need to think about this carefully.');
  });

  // ── Single tool call ───────────────────────────────────────────────────────

  it('should execute a single tool call and return result to LLM', async () => {
    const tool = simpleTool('calculator', '42');

    const mockLLM = new MockLLMClient({
      responseSequences: [
        // First LLM call: responds with a tool call
        buildStreamResponse({
          content: 'Let me calculate that.',
          toolCalls: [{ index: 0, name: 'calculator', arguments: '{"expr":"2+2"}', id: 'call_calc_1' }],
          usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 },
        }),
        // Second LLM call: responds with final text after tool result
        buildStreamResponse({
          content: 'The answer is 42.',
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
        }),
      ],
    });

    const { agent, toolRegistry } = createFixture({ mockLLM });
    toolRegistry.register('calculator', tool);

    const result = await agent.run('What is 2+2?');

    expect(result).toBe('The answer is 42.');
    expect(tool.executeCount).toBe(1);
    expect(tool.lastInput).toBe('{"expr":"2+2"}');
    expect(mockLLM.callCount).toBe(2);

    // Context after full run:
    //   [0] user → [1] assistant (tool call) → [2] tool result → [3] assistant (final)
    const ctx = agent.context;
    expect(ctx.length).toBe(4);
    expect(ctx[0].role).toBe('user');
    expect(ctx[1].role).toBe('assistant');
    expect(ctx[1].toolCalls.length).toBe(1);
    expect(ctx[2].role).toBe('tool');
    expect(ctx[2].content).toContain('42');
    expect(ctx[3].role).toBe('assistant');
    expect(ctx[3].content).toBe('The answer is 42.');
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

    expect(result).toBe('Both operations completed.');
    expect(readTool.executeCount).toBe(1);
    expect(grepTool.executeCount).toBe(1);
    expect(mockLLM.callCount).toBe(2);

    // Context after full run:
    //   [0] user → [1] assistant (2 tool calls) → [2] tool result → [3] tool result → [4] assistant (final)
    const ctx = agent.context;
    expect(ctx.length).toBe(5);
    expect(ctx[0].role).toBe('user');
    expect(ctx[1].role).toBe('assistant');
    expect(ctx[1].toolCalls.length).toBe(2);
    expect(ctx[2].role).toBe('tool');
    expect(ctx[3].role).toBe('tool');
    expect(ctx[4].role).toBe('assistant');
    expect(ctx[4].content).toBe('Both operations completed.');
  });

  // ── Tool validation error ─────────────────────────────────────────────────

  it('should return validation error when tool input fails schema validation', async () => {
    const tool = validatedTool('greet', {
      properties: { name: { type: 'string', description: 'Name to greet' } },
      required: ['name'],
    }, async (input) => `Hello ${input?.name}!`);

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

    expect(result).toBe('The validation failed as expected.');
    expect(tool.executeCount).toBe(0); // tool was NOT executed
    expect(mockLLM.callCount).toBe(2);

    // Context after full run:
    //   [0] user → [1] assistant (tool call) → [2] tool result (validation error) → [3] assistant (final)
    const ctx = agent.context;
    expect(ctx[2].role).toBe('tool');
    expect(ctx[2].content).toContain('validation');
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

    expect(result).toBe('The tool was not found.');
    expect(mockLLM.callCount).toBe(2);

    // Context after full run:
    //   [0] user → [1] assistant (tool call) → [2] tool result (unknown tool) → [3] assistant (final)
    const ctx = agent.context;
    expect(ctx[2].role).toBe('tool');
    expect(ctx[2].content).toContain('Unknown tool');
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

    expect(result).toBe('The tool reported an error.');
    expect(tool.executeCount).toBe(1);

    // Context after full run:
    //   [0] user → [1] assistant (tool call) → [2] tool result (error) → [3] assistant (final)
    const ctx = agent.context;
    expect(ctx[2].role).toBe('tool');
    expect(ctx[2].content).toContain('Error executing');
  });

  // ── Wait tool (yield control) ─────────────────────────────────────────────

  it('should stop agent loop when wait tool is called', async () => {
    const waitTool = simpleTool('wait', 'nothing to do');

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

    expect(result).toBe('return'); // outcome from _executeTools
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

    expect(result).toBe('One tool was blocked.');
    expect(allowedTool.executeCount).toBe(1);
    expect(blockedTool.executeCount).toBe(0);

    // Context after full run:
    //   [0] user → [1] assistant (2 tool calls) → [2] tool result (allowed) → [3] tool result (blocked) → [4] assistant (final)
    const ctx = agent.context;
    expect(ctx.length).toBe(5);
    expect(ctx[2].role).toBe('tool');
    expect(ctx[2].content).toContain('allowed result');
    expect(ctx[3].role).toBe('tool');
    expect(ctx[3].content).toContain('not available');
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
      })(),
    ],
      cancelable: true,
    });

    const { agent } = createFixture({ mockLLM });

    // Run and cancel concurrently
    const runPromise = agent.run('Cancel me');
    await Promise.resolve(); // let the run start
    agent.cancel(true);

    await expect(runPromise).rejects.toThrow('cancelled');
  });

  it('should abort when abortSignal is fired during streaming', async () => {
    const abortController = new AbortController();

    const mockLLM = new MockLLMClient({
      responseSequences: [
      (async function* () {
        yield { type: 'content', content: 'Starting...' };
        await new Promise(() => {}); // never resolves
      })(),
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
    const requestHookCalls = [];

    hooks.on(HOOKS.PROVIDER_REQUEST, (data) => {
      requestHookCalls.push(data.modelConfig?.name || data.agent.model);
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
    const responseHookCalls = [];

    hooks.on(HOOKS.PROVIDER_RESPONSE, (data) => {
      responseHookCalls.push(data.response.fullText);
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
    const turnEvents = [];

    hooks.on(HOOKS.TURN_START, (data) => {
      turnEvents.push({ type: 'start', index: data.turnIndex });
    });

    hooks.on(HOOKS.TURN_END, (data) => {
      turnEvents.push({ type: 'end', index: data.turnIndex, stopped: data.stopped });
    });

    await agent.run('Hi');

    expect(turnEvents.length).toBe(2);
    expect(turnEvents[0].type).toBe('start');
    expect(turnEvents[0].index).toBe(1);
    expect(turnEvents[1].type).toBe('end');
    expect(turnEvents[1].index).toBe(1);
    expect(turnEvents[1].stopped).toBe(true);
  });

  it('should allow CONTEXT hook to modify messages before LLM call', async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({ content: 'Response', usage: { total_tokens: 10 } }),
      ],
    });

    const { agent, hooks } = createFixture({ mockLLM });

    hooks.on(HOOKS.CONTEXT, ({ messages }) => {
      // Add a system instruction before each LLM call
      return {
        messages: [
          new Message({ role: 'system', content: 'Be concise.' }),
          ...messages,
        ],
      };
    });

    await agent.run('Hi');

    expect(mockLLM.lastMessages[0].role).toBe('system');
    expect(mockLLM.lastMessages[0].content).toBe('Be concise.');
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
    hooks.on(HOOKS.TOOL_CALL, ({ toolName }) => {
      if (toolName === 'sensitive_tool') {
        return { action: 'block', result: 'Blocked: sensitive tool not allowed' };
      }
      return { action: 'continue' };
    });

    const result = await agent.run('Access sensitive data');

    expect(result).toBe('Tool blocked by gate.');
    expect(tool.executeCount).toBe(0); // tool was NOT executed

    // Context after full run:
    //   [0] user → [1] assistant (tool call) → [2] tool result (blocked) → [3] assistant (final)
    const ctx = agent.context;
    expect(ctx[2].role).toBe('tool');
    expect(ctx[2].content).toContain('Blocked');
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
    hooks.on(HOOKS.TOOL_RESULT, ({ result }) => {
      return { result: `[MODIFIED] ${result}` };
    });

    const result = await agent.run('Modify result');

    expect(result).toBe('Modified result received.');
    expect(tool.executeCount).toBe(1);

    // Context after full run:
    //   [0] user → [1] assistant (tool call) → [2] tool result (modified) → [3] assistant (final)
    const ctx = agent.context;
    expect(ctx[2].role).toBe('tool');
    expect(ctx[2].content).toContain('MODIFIED');
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
    agent._followQueue.push('Follow-up message');

    const result = await agent.run('Do work');

    expect(result).toBe('Follow-up processed.');
    expect(mockLLM.callCount).toBe(2);

    // Context should contain the follow-up user message
    const ctx = agent.context;
    const followUpMsg = ctx.find(m => m.role === 'user' && m.content === 'Follow-up message');
    expect(followUpMsg).toBeTruthy();
  });

  // ── Serialize / deserialize full agent state ──────────────────────────────

  it('should serialize and deserialize full agent state', async () => {
    const { agent } = createFixture({});

    agent.context.push(new Message({ role: 'user', content: 'test message' }));
    agent.context.push(new Message({
      role: 'assistant',
      content: 'response',
      reasoningContent: 'thinking...',
      toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }],
    }));
    agent._reasoningEffort = 'high';

    const serialized = agent.serialize();

    expect(serialized.sessionId).toBe('test-session');
    expect(serialized.context.length).toBe(2);
    expect(serialized.reasoningEffort).toBe('high');
    expect(serialized.model).toBe('test-model');

    // Deserialize into a fresh agent
    const freshAgent = new Agent({
      hooks: createHooks(),
      toolRegistry: createToolRegistry(),
      llmClient: new MockLLMClient(),
      model: 'test-model',
    });
    freshAgent.deserialize(serialized);

    expect(freshAgent.sessionId).toBe('test-session');
    expect(freshAgent.context.length).toBe(2);
    expect(freshAgent.context[0].role).toBe('user');
    expect(freshAgent.context[0].content).toBe('test message');
    expect(freshAgent.context[1].role).toBe('assistant');
    expect(freshAgent.context[1].reasoningContent).toBe('thinking...');
    expect(freshAgent.context[1].toolCalls.length).toBe(1);
    expect(freshAgent._reasoningEffort).toBe('high');
    expect(freshAgent.model).toBe('test-model');
  });

  // ── Existing tests (preserved) ────────────────────────────────────────────

  describe('constructor (existing)', () => {
    it('should set default values', () => {
      const { agent } = createFixture({ model: 'test-model' });
      expect(agent.model).toBe('test-model');
      expect(agent.iterationCount).toBe(0);
      expect(agent.hideTools).toBe(true);
      expect(agent.hideThinking).toBe(false);
      expect(agent.cancelled).toBe(false);
    });

    it('should accept custom options', () => {
      const hooks = createHooks();
      const toolRegistry = createToolRegistry();
      const llmClient = new MockLLMClient();
      const a = new Agent({
        hooks,
        toolRegistry,
        llmClient,
        model: 'custom',
        maxIterations: 42,
        hideTools: false,
        hideThinking: true,
      });
      expect(a.model).toBe('custom');
      expect(a.hideTools).toBe(false);
      expect(a.hideThinking).toBe(true);
    });
  });

  describe('context (existing)', () => {
    it('should start with empty context', () => {
      const { agent } = createFixture({});
      expect(agent.context).toEqual([]);
    });

    it('should allow clearing context', async () => {
      const { agent } = createFixture({});
      agent.context.push(new Message({ role: 'user', content: 'hello' }));
      await agent.clearContext();
      expect(agent.context).toEqual([]);
      expect(agent.iterationCount).toBe(0);
    });
  });

  describe('cancel (existing)', () => {
    it('should set cancelled flag', () => {
      const { agent } = createFixture({});
      expect(agent.cancelled).toBe(false);
      agent.cancel(true);
      expect(agent.cancelled).toBe(true);
      agent.cancel(false);
      expect(agent.cancelled).toBe(false);
    });
  });

  describe('tool registry access (existing)', () => {
    it('should return empty tool defs when no tools registered', async () => {
      const { agent } = createFixture({});
      expect(await agent.getToolDefs()).toEqual([]);
      expect(agent.getToolNames()).toEqual([]);
    });

    it('should return registered tools', async () => {
      const { agent, toolRegistry } = createFixture({});
      const tool = {
        toToolDef: () => ({ type: 'function', function: { name: 'test-tool' } }),
        execute: async () => 'result',
      };
      toolRegistry.register('test-tool', tool);

      const defs = await agent.getToolDefs();
      expect(defs).toEqual([
        { type: 'function', function: { name: 'test-tool' } },
      ]);
      expect(agent.getToolNames()).toEqual(['test-tool']);
    });
  });

  describe('executeCommand (existing)', () => {
    it('should handle clear command', async () => {
      const { agent } = createFixture({});
      agent.context.push(new Message({ role: 'user', content: 'hello' }));
      const result = await agent.executeCommand({ type: 'clear' });
      expect(result).toEqual({ content: 'Context cleared.' });
      expect(agent.context).toEqual([]);
    });

    it('should handle reasoning command to set effort', async () => {
      const { agent } = createFixture({});
      const result = await agent.executeCommand({ type: 'reasoning', value: 'high' });
      expect(result).toEqual({ content: 'Reasoning effort set to: high' });
      expect(agent._reasoningEffort).toBe('high');
    });

    it('should delegate to hooks for custom commands', async () => {
      const { agent, hooks } = createFixture({});
      hooks.on(HOOKS.COMMAND_DISPATCH, () => ({ content: 'custom handled' }));
      const result = await agent.executeCommand({ type: 'custom' });
      expect(result).toEqual({ content: 'custom handled' });
    });

    it('should return error for unknown commands', async () => {
      const { agent } = createFixture({});
      const result = await agent.executeCommand({ type: 'unknown-cmd' });
      expect(result).toEqual({ error: 'Unknown command: unknown-cmd' });
    });
  });

  describe('hooks integration (existing)', () => {
    it('should call SYSTEM_PROMPT_BUILD handlers and collect returned chunks', async () => {
      const { agent, hooks } = createFixture({});
      hooks.on(HOOKS.SYSTEM_PROMPT_BUILD, async ({ agent: a }) => {
        return { name: 'test-chunk', priority: 500, content: '\n# Test Chunk' };
      });

      await agent.ensureSystemPrompt();
      expect(agent._systemPrompt).toContain('Test Chunk');
    });
  });

  describe('_resolveModelConfig (existing)', () => {
    it('should include reasoning_effort from model registry', () => {
      const { agent } = createFixture({
        modelRegistry: {
          'test-model': { name: 'test-model', temperature: 0.5, maxTokens: 100, reasoningEffort: 'high' },
        },
      });
      const config = agent._resolveModelConfig();
      expect(config.reasoningEffort).toBe('high');
    });

    it('should override reasoning_effort from runtime setting', () => {
      const { agent } = createFixture({
        modelRegistry: {
          'test-model': { name: 'test-model', temperature: 0.5, maxTokens: 100, reasoningEffort: 'low' },
        },
      });
      agent._reasoningEffort = 'max';
      const config = agent._resolveModelConfig();
      expect(config.reasoningEffort).toBe('max');
    });

    it('should omit reasoning_effort when not set anywhere', () => {
      const { agent } = createFixture({
        modelRegistry: {
          'test-model': { name: 'test-model', temperature: 0.5, maxTokens: 100 },
        },
      });
      const config = agent._resolveModelConfig();
      expect(config.reasoningEffort).toBeUndefined();
    });
  });

  describe('serialize/deserialize (existing)', () => {
    it('should serialize and deserialize reasoning_effort', () => {
      const { agent } = createFixture({});
      agent._reasoningEffort = 'max';
      const serialized = agent.serialize();
      expect(serialized.reasoningEffort).toBe('max');

      const newAgent = new Agent({
        hooks: createHooks(),
        toolRegistry: createToolRegistry(),
        llmClient: new MockLLMClient(),
        model: 'test',
      });
      newAgent.deserialize(serialized);
      expect(newAgent._reasoningEffort).toBe('max');
    });

    it('should handle undefined reasoning_effort in deserialize', () => {
      const { agent } = createFixture({});
      const serialized = agent.serialize();
      expect(serialized.reasoningEffort).toBeUndefined();

      const newAgent = new Agent({
        hooks: createHooks(),
        toolRegistry: createToolRegistry(),
        llmClient: new MockLLMClient(),
        model: 'test',
      });
      newAgent._reasoningEffort = 'high';
      newAgent.deserialize(serialized);
      expect(newAgent._reasoningEffort).toBeUndefined();
    });
  });
});
