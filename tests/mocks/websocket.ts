// Shared mock helpers for websocket server tests.

import { mock } from "bun:test";

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

export function createWsMockAgentFactory(): (config: { model?: string; sessionId?: string }) => Promise<any> {
  return async (config: { model?: string; sessionId?: string }) => ({
    sessionId: config.sessionId || "test",
    model: "test-model",
    profileName: "default",
    modelRegistry: { "test-model": {} },
    log: [],
    sink: null,
    cancel: () => {},
    resetCancel: () => {},
    run: async () => {},
    executeCommand: async () => ({}),
    serialize: () => ({}),
    deserialize: () => {},
  });
}

export function createWsMockWs(): WebSocket & { messages: string[] } {
  const messages: string[] = [];
  return {
    readyState: 1,
    send: (data: string) => { messages.push(data); },
    messages,
    close: mock(() => {}),
  } as unknown as WebSocket & { messages: string[] };
}
