// Shared test helpers for extension tests.
// Extracted to reduce duplication across test files.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ToolResult } from '../src/core/extensions/tool-utils.js';
import { ToolContext } from '../src/core/extensions/tool-context.js';
import { Agent } from '../src/core/agent.js';
import { MessageLog } from '../src/core/context/message-log.js';
import { createHooks } from '../src/core/hooks.js';
import { createToolRegistry } from '../src/core/extensions/tool-registry.js';

// ── General utilities ──────────────────────────────────────────────────────

/**
 * Extract string output from a tool result (handles ToolResult or plain string).
 * For error results, includes the error message.
 */
export function resultStr(result) {
  if (result instanceof ToolResult) {
    if (result.error) {
      return result.error;
    }
    return result.output;
  }
  return result;
}

/**
 * Get display string from a tool result (calls toDisplay()).
 */
export function getDisplay(result) {
  if (result?.toDisplay) {
    return result.toDisplay();
  }
  return String(result);
}

/**
 * Create a temporary directory for file-based tests.
 */
export function tmpDir(prefix = 'oa-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Create a ToolContext with optional overrides.
 */
export function toolCtx(opts = {}) {
  return new ToolContext({
    cwdBoundary: opts.cwdBoundary || null,
    workspaceRoot: opts.workspaceRoot || null,
    ...opts,
  });
}

/**
 * Clean up a temporary directory recursively.
 */
export function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ── Mock LLM Client ────────────────────────────────────────────────────────
//
// Produces programmable streams of events. Each call to chatStreamCancellable
// returns an async generator that yields a preset sequence of events.
// Supports cancellation via AbortSignal.

/**
 * Build a tool-call event sequence for a single tool call.
 * Returns [toolName, toolArgument] events.
 */
export function buildToolCallEvents({ index, name, arguments: args, id }) {
  return [
    { type: 'toolName', index, name, toolCallId: id || `call_${index}` },
    { type: 'toolArgument', index, arguments: args },
  ];
}

/**
 * Build a complete streaming response sequence.
 */
export function buildStreamResponse({
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
export class MockLLMClient {
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

export class MockTool {
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

// ── Tool factory helpers ───────────────────────────────────────────────────

/**
 * Create a simple mock tool that returns a fixed result.
 */
export function simpleTool(name, result = 'done') {
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
export function validatedTool(name, schema, execute) {
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
export function failingTool(name, errorMsg = 'intentional failure') {
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
export function metadataTool(name, metadata) {
  return new MockTool({
    name,
    execute: async () => ToolResult.ok('output').withEntries(metadata),
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

/**
 * Create a complete agent test fixture with hooks, tool registry, mock LLM, and agent.
 *
 * @param {Object} options
 * @param {Object} [options.hooks] — Pre-created hook system (default: fresh createHooks)
 * @param {Object} [options.toolRegistry] — Pre-created tool registry (default: fresh)
 * @param {Object} [options.mockLLM] — MockLLMClient instance (default: empty, non-cancelable)
 * @param {string} [options.model] — Model name (default: 'test-model')
 * @param {number} [options.maxIterations] — Max iterations (default: 10)
 * @param {number} [options.maxTokens] — Max tokens (default: 4096)
 * @param {boolean} [options.hideTools] — Hide tool display (default: true)
 * @param {boolean} [options.hideThinking] — Hide thinking (default: false)
 * @param {boolean} [options.showTokenUse] — Show token usage (default: false)
 * @param {boolean} [options.stream] — Enable streaming (default: false)
 * @param {Object} [options.sink] — Output sink
 * @param {Object} [options.modelRegistry] — Model registry (default: {})
 * @param {string} [options.profileName] — Profile name (default: 'test')
 * @param {string} [options.role] — Role (default: 'Test agent')
 * @param {string} [options.profileBody] — Profile body
 * @param {Object} [options.config] — Config object
 * @param {string} [options.sessionId] — Session ID (default: 'test-session')
 * @param {AbortSignal} [options.abortSignal] — Abort signal
 * @param {string[]} [options.toolWhitelist] — Tool whitelist
 * @returns {{ hooks: Object, toolRegistry: Object, mockLLM: MockLLMClient, agent: Agent }}
 */
export function createFixture(options = {}) {
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

// ── Mock Agent (lightweight) ───────────────────────────────────────────────

/**
 * A lightweight mock agent for tests that don't need a full Agent instance.
 * Provides just enough surface to satisfy SessionManager, MessageBus, etc.
 *
 * @param {string} [runResult='done'] — Value returned by run()
 * @param {string} [sessionId] — Optional explicit session ID (default: random UUID)
 */
export class MockAgent {
  constructor(runResult = 'done', sessionId) {
    this._cancelled = false;
    this._runCalled = false;
    this._runResult = runResult;
    this._runError = null;
    this._sessionId = sessionId || crypto.randomUUID();
    this._log = new MessageLog();
    this._systemPrompt = null;
  }

  get cancelled() { return this._cancelled; }
  get log() { return this._log; }
  get sessionId() { return this._sessionId; }
  get systemPrompt() { return this._systemPrompt; }

  cancel(reset = true) { this._cancelled = reset; }
  async run(text) {
    this._runCalled = true;
    if (this._runError) throw this._runError;
    return this._runResult;
  }
  getCommandRegistry() { return null; }
  addMessage(msg) {
    this._log.push(msg);
  }
}

// ── Mock Sink ──────────────────────────────────────────────────────────────

/**
 * A mock output sink that captures emitted events for assertion.
 */
export class MockSink {
  constructor() {
    this.events = [];
  }
  emit(event) {
    this.events.push(event);
  }
}
