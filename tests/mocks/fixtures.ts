// Test fixtures for agent, core, and session testing.

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { Agent, ModelRegistry, AgentConfig } from '../../src/core/agent.ts';
import type { LlmClient } from '../../src/core/llm-client/client.ts';
import type { CoreContext } from '../../src/core/extensions/types.ts';
import { MessageLog } from '../../src/core/context/message-log.ts';
import type { Message } from '../../src/core/context/message.ts';
import { HookSystem } from '../../src/core/hooks.ts';
import { ToolRegistry, createToolRegistry } from '../../src/core/extensions/tool-registry.ts';
import { createHooks } from '../../src/core/hooks.ts';
import { createSubcommandRegistry } from '../../src/core/extensions/registries.ts';
import { createServiceRegistry } from '../../src/core/extensions/service-registry.ts';
import { createConfigRegistry } from '../../src/core/extensions/config-registry.ts';
import { MockLLMClient } from './llm.ts';
import type { OutputEvent } from '../../src/core/context/output.ts';

// ── Agent Test Fixture ──────────────────────────────────────────────────────

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

export class MockSink {
  events: OutputEvent[];

  constructor() {
    this.events = [];
  }
  emit(event: OutputEvent): void {
    this.events.push(event);
  }
}

// ── Mock Readline ──────────────────────────────────────────────────────────

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

// ── Mock Core ──────────────────────────────────────────────────────────────

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
