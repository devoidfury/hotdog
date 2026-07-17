// Shared test helpers for extension tests.
// Extracted to reduce duplication across test files.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { ToolResult } from '../src/core/extensions/tool-utils.ts';
import { ToolContext } from '../src/core/extensions/tool-context.ts';
import { Agent, ModelRegistry, AgentConfig } from '../src/core/agent.ts';
import type { Tool, ToolDef } from '../src/core/extensions/tool-registry.ts';
import type { Message } from '../src/core/context/message.ts';
import { MessageLog } from '../src/core/context/message-log.ts';
import type { LlmClient } from '../src/core/llm-client/client.ts';
import type { CoreContext } from '../src/core/extensions/types.ts';
import { createHooks } from '../src/core/hooks.ts';
import { createToolRegistry } from '../src/core/extensions/tool-registry.ts';
import { HookSystem } from '../src/core/hooks.ts';
import { ToolRegistry } from '../src/core/extensions/tool-registry.ts';
import { createSubcommandRegistry } from '../src/core/extensions/registries.ts';
import { createServiceRegistry, ServiceRegistry } from '../src/core/extensions/service-registry.ts';
import { createConfigRegistry, ConfigRegistry } from '../src/core/extensions/config-registry.ts';
import type { OutputEvent } from '../src/core/context/output.ts';

// ── General utilities ──────────────────────────────────────────────────────

/**
 * Extract string output from a tool result (handles ToolResult or plain string).
 * For error results, includes the error message.
 */
export function resultStr(result: unknown): string {
  if (result instanceof ToolResult) {
    if (result.error) {
      return result.error;
    }
    return result.output;
  }
  return String(result);
}

/**
 * Get display string from a tool result (calls toDisplay()).
 */
export function getDisplay(result: unknown): string {
  if (result && typeof result === 'object' && 'toDisplay' in result && typeof (result as any).toDisplay === 'function') {
    return (result as any).toDisplay();
  }
  return String(result);
}

/**
 * Create a temporary directory for file-based tests.
 */
export function tmpDir(prefix = 'hotdog-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Create a ToolContext with optional overrides.
 */
export function toolCtx(opts: Record<string, unknown> = {}) {
  return new ToolContext({
    cwdBoundary: opts.cwdBoundary ?? null,
    workspaceRoot: opts.workspaceRoot ?? null,
    ...opts,
  });
}

/**
 * Clean up a temporary directory recursively.
 */
export function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Run an async test body inside a temporary directory, cleaning up afterward.
 * Eliminates the repeated tmpDir() + rmSync() pattern in every test.
 *
 * @param {Object} [opts]
 * @param {string} [opts.prefix='hotdog-test-'] — Prefix for mkdtemp
 * @param {Function} [opts.cleanup] — Optional extra cleanup function
 */
export function withTempDir(opts: { prefix?: string; cleanup?: () => void } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), opts.prefix || 'hotdog-test-'));
  return {
    dir,
    cleanup() {
      if (opts.cleanup) opts.cleanup();
      cleanupDir(dir);
    },
  };
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
export function buildToolCallEvents({ index, name, arguments: args, id }: {
  index: number;
  name: string;
  arguments: string;
  id?: string;
}): Record<string, unknown>[] {
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
}: {
  content?: string;
  reasoning?: string | null;
  toolCalls?: Array<{ index: number; name: string; arguments: string; id?: string }> | null;
  usage?: Record<string, unknown>;
}): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];

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
  // Required LlmClient properties
  baseUrl: string | null = null;
  apiKey: string | null = null;
  sessionId: string = '';
  loud: boolean = false;
  chatTimeoutSecs: number = 30;
  maxRetries: number = 3;
  stream: boolean = true;
  providers: Array<{ name: string; url: string; apiKey?: string | null }> = [];
  cancelled: boolean = false;

  // Mock-specific properties
  _responseSequences: Record<string, unknown>[][] | undefined;
  _callIndex: number;
  cancelable: boolean;
  callCount: number;
  lastMessages: unknown[] | null;
  lastModelConfig: Record<string, unknown> | null;
  lastToolDefs: Record<string, unknown>[] | null;
  lastCancelSignal: AbortSignal | null;

  /**
   * @param {Array<Array<Object>>} responseSequences — One array per call.
   *   Each array is a list of stream events.
   * @param {boolean} [cancelable=false] — If true, respects abort signal.
   */
  constructor({ responseSequences = [], cancelable = false }: { responseSequences?: Record<string, unknown>[][]; cancelable?: boolean } = {}) {
    this._responseSequences = responseSequences as Record<string, unknown>[][];
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
  reset(sequences?: Record<string, unknown>[][]): void {
    this._responseSequences = sequences || this._responseSequences;
    this._callIndex = 0;
    this.callCount = 0;
    this.lastMessages = null;
    this.lastModelConfig = null;
    this.lastToolDefs = null;
    this.lastCancelSignal = null;
  }

  chatStreamCancellable(
    messages: unknown[],
    modelConfig: Record<string, unknown>,
    toolDefs: Record<string, unknown>[],
    cancelSignal: AbortSignal | null | undefined,
  ): AsyncGenerator<Record<string, unknown>, void, unknown> | (() => AsyncGenerator<Record<string, unknown>, void, unknown>) {
    this.callCount++;
    this.lastMessages = messages;
    this.lastModelConfig = modelConfig;
    this.lastToolDefs = toolDefs;
    this.lastCancelSignal = cancelSignal ?? null;

    const sequence = this._responseSequences?.[this._callIndex++];
    if (!sequence) {
      // No sequence defined — return empty stream
      return (async function* (): AsyncGenerator<Record<string, unknown>> {})();
    }

    return this._makeStream(sequence, cancelSignal);
  }

  async *_makeStream(
    events: Record<string, unknown>[],
    cancelSignal: AbortSignal | null | undefined,
  ): AsyncGenerator<Record<string, unknown>> {
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

export class MockTool implements Tool {
  name: string;
  _executeFn: (input: unknown, ctx: unknown) => unknown | Promise<unknown>;
  _toToolDefFn: () => Record<string, unknown>;
  _callDisplayFn: ((input: unknown) => string) | null;
  executeCount: number;
  lastInput: unknown;
  lastContext: unknown;
  [key: string]: unknown;

  constructor({ name, execute, toToolDef, callDisplay }: {
    name?: string;
    execute?: (input: unknown, ctx: unknown) => unknown | Promise<unknown>;
    toToolDef?: () => Record<string, unknown>;
    callDisplay?: (input: unknown) => string;
  } = {}) {
    this.name = name || 'mock-tool';
    this._executeFn = execute || (async () => 'mock result');
    this._toToolDefFn = toToolDef || (() => ({
      type: 'function' as const,
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

  toToolDef(): ToolDef {
    return this._toToolDefFn() as unknown as ToolDef;
  }

  async execute(input: unknown, ctx: unknown): Promise<unknown> {
    this.executeCount++;
    this.lastInput = input;
    this.lastContext = ctx;
    return this._executeFn(input, ctx);
  }

  callDisplay(input: unknown): string {
    if (this._callDisplayFn) return this._callDisplayFn(input);
    return `mock-tool(${JSON.stringify(input)})`;
  }
}

// ── Tool factory helpers ───────────────────────────────────────────────────

/**
 * Create a simple mock tool that returns a fixed result.
 */
export function simpleTool(name: string, result: unknown = 'done'): MockTool {
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
export function validatedTool(
  name: string,
  schema: { properties?: Record<string, unknown>; required?: string[] },
  execute: (input: unknown, ctx: unknown) => unknown | Promise<unknown>,
): MockTool {
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
export function failingTool(name: string, errorMsg = 'intentional failure'): MockTool {
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
export function metadataTool(name: string, metadata: Record<string, unknown>): MockTool {
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
 * @param {number} [options.contextLimit] — Context window limit (default: 128000)
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
 * @returns {{ hooks: HookSystem; toolRegistry: ToolRegistry; mockLLM: MockLLMClient; agent: Agent }}
 */
export function createFixture(options: {
  hooks?: HookSystem;
  toolRegistry?: ToolRegistry;
  mockLLM?: MockLLMClient;
  model?: string;
  maxIterations?: number;
  contextLimit?: number;
  hideTools?: boolean;
  hideThinking?: boolean;
  showTokenUse?: boolean;
  stream?: boolean;
  sink?: { emit: (event: OutputEvent) => void } | null;
  modelRegistry?: Record<string, unknown>;
  profileName?: string;
  role?: string;
  profileBody?: string;
  config?: Record<string, unknown> | null;
  sessionId?: string;
  abortSignal?: AbortSignal | null;
  toolWhitelist?: string[] | null;
} = {}): { hooks: HookSystem; toolRegistry: ToolRegistry; mockLLM: MockLLMClient; agent: Agent } {
  const hooks = options.hooks || createHooks();
  const toolRegistry = options.toolRegistry || createToolRegistry();

  const mockLLM = options.mockLLM || new MockLLMClient({ cancelable: false });

  const agent = new Agent({
    hooks,
    toolRegistry,
    llmClient: mockLLM as unknown as LlmClient,
    model: options.model || 'test-model',
    maxIterations: options.maxIterations || 10,
    contextLimit: options.contextLimit || 128000,
    hideTools: options.hideTools ?? true,
    hideThinking: options.hideThinking ?? false,
    showTokenUse: options.showTokenUse ?? false,
    stream: options.stream ?? false,
    sink: options.sink || null,
    modelRegistry: (options.modelRegistry || {}) as ModelRegistry,
    profileName: options.profileName || 'test',
    role: options.role || 'Test agent',
    profileBody: options.profileBody || '',
    config: options.config as AgentConfig | undefined,
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
  _cancelled: boolean;
  _runCalled: boolean;
  _runResult: string;
  _runError: Error | null;
  _sessionId: string;
  _log: MessageLog;
  _systemPrompt: string | null;

  constructor(runResult = 'done', sessionId?: string) {
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
  async run(text: string): Promise<string> {
    this._runCalled = true;
    if (this._runError) throw this._runError;
    return this._runResult;
  }
  commandRegistry: null = null;
  addMessage(msg: Message): void {
    this._log.push(msg);
  }
  serialize(): Record<string, unknown> {
    return { sessionId: this._sessionId };
  }
  deserialize(data: Record<string, unknown>): void {
    if (data.sessionId) {
      this._sessionId = data.sessionId as string;
    }
  }
}

// ── Mock Sink ──────────────────────────────────────────────────────────────

/**
 * A mock output sink that captures emitted events for assertion.
 */
export class MockSink {
  events: OutputEvent[];

  constructor() {
    this.events = [];
  }
  emit(event: OutputEvent): void {
    this.events.push(event);
  }
}

/**
 * Create a mock readline interface that queues preset responses.
 * Each call to rl.question consumes the next response from the queue.
 * Tracks handlers added via rl.on("line", ...) for verification.
 *
 * @param {string[]} [responses=[]] — Preset responses to return via question()
 * @returns {{ rl: { removeListener: () => void; question: (prompt: string, cb: (response: string) => void) => void; on: (event: string, handler: (...args: unknown[]) => void) => void }; addedHandlers: unknown[] }}
 */
export function createMockRl(responses: string[] = []): {
  rl: readline.Interface;
  addedHandlers: unknown[];
} {
  let responseIndex = 0;
  const addedHandlers: unknown[] = [];

  const mockRl = {
    removeListener: function () { return mockRl; },
    question: function (_prompt: string, cb: (response: string) => void) {
      if (responseIndex < responses.length) {
        const r = responses[responseIndex];
        if (r !== undefined) cb(r);
        responseIndex++;
      }
      return mockRl as any;
    },
    on: function (event: string, handler: (...args: unknown[]) => void) {
      if (event === "line") addedHandlers.push(handler);
      return mockRl;
    },
    prompt: function () { return mockRl as any; },
    close: function () {},
  } as unknown as readline.Interface;

  return { rl: mockRl, addedHandlers };
}

/**
 * Set up the session log test directory and clean up any existing test file.
 * @param {string} sessionId — Session ID for the test
 */
export function setupSessionTestDir(sessionId: string): void {
  const { mkdirSync, rmSync } = fs;
  const { join } = path;
  const { homedir } = os;
  const dir = join(homedir(), ".cache", "hotdog", "sessions");
  mkdirSync(dir, { recursive: true });
  const testFile = join(dir, `${sessionId}.jsonl`);
  try { rmSync(testFile); } catch { /* doesn't exist yet */ }
}

/**
 * Clean up a session log test file.
 * @param {string} sessionId — Session ID for the test
 */
export function cleanupSessionTest(sessionId: string): void {
  const { rmSync } = fs;
  const { join } = path;
  const { homedir } = os;
  const testFile = join(homedir(), ".cache", "hotdog", "sessions", `${sessionId}.jsonl`);
  try { rmSync(testFile); } catch { /* ignore */ }
}

/**
 * Create a mock core object for testing interactive CLI and related extensions.
 * Provides hooks, toolRegistry, cliSubcommandRegistry, config, resolved, and modelRegistry.
 *
 * @param {Object} [config={}] — Optional overrides for resolved/core config
 * @returns {Object} Mock core object
 */
export function createMockCore(config: {
  resolved?: Record<string, unknown>;
  coreConfig?: Record<string, unknown>;
  modelRegistry?: Record<string, unknown>;
  providers?: unknown[];
  buildConfig?: (cli: Record<string, unknown>) => Promise<{
    resolved: Record<string, unknown>;
    modelRegistry: Record<string, unknown>;
    providers: unknown[];
  }>;
} = {}): CoreContext {
  const hooks = new HookSystem();
  const toolRegistry = new ToolRegistry();
  const cliSubcommandRegistry = createSubcommandRegistry();
  const services = createServiceRegistry();
  const configRegistry = createConfigRegistry();

  const resolved: Record<string, unknown> = {
    baseUrl: "http://localhost:8080",
    apiKey: "test-key",
    model: "test-model",
    stream: false,
    chatTimeout: 30,
    maxRetries: 3,
    maxIterations: 100,
    contextLimit: 128000,
    profileName: "default",
    profile: {},
    hideTools: false,
    hideThinking: false,
    showTokenUse: false,
    role: "",
    profileBody: "",
    activeProvider: null,
    configDir: path.join(os.homedir(), ".config", "hotdog"),
    ...config.resolved,
  };

  return {
    hooks,
    toolRegistry,
    cliSubcommandRegistry,
    services,
    configRegistry,
    service: (name: string) => services.get(name),
    config: {
      theme: "dark",
      maxIterations: 100,
      ...config.coreConfig,
    },
    resolved,
    modelRegistry: config.modelRegistry || {},
    extensions: {
      has: () => false,
      load: async () => null,
      cleanup: async () => {},
    } as unknown as NonNullable<CoreContext["extensions"]>,
    buildConfig:
      config.buildConfig ||
      (async () => ({
        resolved,
        modelRegistry: config.modelRegistry || {},
        providers: config.providers || [],
      })) as CoreContext["buildConfig"],
  } as CoreContext;
}
