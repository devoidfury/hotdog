// Shared mock helpers for websocket server tests.

import { mock } from "bun:test";
import type { AgentLike } from "../../src/core/session/index.ts";
import type { HookSystem } from "../../src/core/hooks.ts";
import type { MessageLog } from "../../src/core/context/message-log.ts";
import type { HotdogServerSocket } from "../../src/extensions/websocket/server.ts";

const mockHooks = {
  notifyHooks: () => {},
  runHookPipeline: async () => undefined,
  registerHook: () => {},
  unregisterHook: () => {},
} as unknown as HookSystem;

const mockLog: MessageLog = {
  push: () => 0,
  replace: () => {},
  get: () => undefined,
  getAll: () => [],
  toJSON: () => [],
  length: 0,
  clear: () => {},
  pop: () => undefined,
  slice: () => [],
  *[Symbol.iterator]() {},
} as unknown as MessageLog;

function makeMockAgent(overrides: Partial<AgentLike> = {}): AgentLike {
  return {
    sessionId: "test",
    model: "test-model",
    profileName: "default",
    hooks: mockHooks,
    log: mockLog,
    sink: null,
    toolWhitelist: null,
    role: undefined,
    profileBody: undefined,
    enqueueCallback: null,
    serialize: () => ({}),
    deserialize: () => {},
    run: async () => undefined,
    clearContext: async () => {},
    cancel: () => {},
    resetCancel: () => {},
    executeCommand: async () => null,
    addMessage: () => {},
    ...overrides,
  };
}

export function createWsMockCore(): any {
  return {
    hooks: {
      notifyHooks: () => {},
      notifyHooksAsync: async () => {},
    },
    config: {},
    resolved: {
      baseUrl: "http://localhost:8000",
      apiKey: "test-key",
      model: "test-model",
      stream: true,
      chatTimeout: 30,
      maxRetries: 3,
      maxIterations: 100,
      contextLimit: 128000,
      hideTools: false,
      hideThinking: true,
      showTokenUse: true,
      profileName: "default",
      modelRegistry: { "test-model": {} },
    },
    toolRegistry: {
      getAll: () => [],
      get: () => null,
      register: () => {},
    },
    extensions: {
      cleanup: async () => {},
    },
  };
}

export function createWsMockAgentFactory(): (config: { model?: string; sessionId?: string }) => Promise<AgentLike> {
  return async (config: { model?: string; sessionId?: string }) =>
    makeMockAgent({
      sessionId: config.sessionId || "test",
      model: config.model || "test-model",
    });
}

export function makeWsMockAgent(overrides?: Partial<AgentLike>): AgentLike {
  return makeMockAgent(overrides);
}

export function createWsMockWs(): HotdogServerSocket & { messages: string[] } {
  const messages: string[] = [];
  return {
    readyState: 1,
    send: (data: string) => { messages.push(data); },
    sendText: (data: string) => { messages.push(data); },
    sendBinary: () => {},
    close: mock(() => {}),
    terminate: mock(() => {}),
    ping: mock(() => true),
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    data: undefined,
    url: "",
    protocol: "",
    extensions: "",
    binaryType: "arraybuffer",
    messages,
  } as unknown as HotdogServerSocket & { messages: string[] };
}
