// Shared test assertion helpers.
// Import from this file instead of duplicating helpers in each test file.

import { expect, mock } from 'bun:test';
import type { AgentRunResult } from '../src/core/agent.ts';

/** Assert result is a completion and return it narrowed. */
export function expectCompletion(result: AgentRunResult | undefined | null): { type: 'completion'; content: string } {
  expect(result?.type).toBe('completion');
  return result as { type: 'completion'; content: string };
}

/** Assert result is a tool_return and return it narrowed. */
export function expectToolReturn(result: AgentRunResult | undefined | null): { type: 'tool_return'; outcome: string } {
  expect(result?.type).toBe('tool_return');
  return result as { type: 'tool_return'; outcome: string };
}

/**
 * Create a mock command/subcommand registry that captures the first registered entry.
 * Usage:
 *   const registry = createMockRegistry();
 *   await ext.hooks![HOOK](registry);
 *   expect(registry.registeredName).toBe("my-cmd");
 *   await registry.registeredOpts!.handler({}, "arg");
 */
export function createMockRegistry(): {
  register: ReturnType<typeof mock>;
  registeredName: string | null;
  registeredOpts: Record<string, unknown> | null;
} {
  const registry: any = {
    register: mock((name: string, opts: Record<string, unknown>) => {
      registry.registeredName = name;
      registry.registeredOpts = opts;
    }),
    registeredName: null,
    registeredOpts: null,
  };
  return registry;
}

/**
 * Create a mock core context for extension tests.
 * Usage:
 *   const core = createMockCore({ hooks, config: { webui: { port: 3000 } } });
 */
export function createMockCore(overrides: Partial<{
  hooks: { notifyHooks?: () => void; notifyHooksAsync?: () => Promise<void> } | null;
  config: Record<string, unknown>;
  resolved: Record<string, unknown>;
}> = {}): Record<string, unknown> {
  return {
    hooks: overrides.hooks ?? {
      notifyHooks: () => {},
      notifyHooksAsync: async () => {},
    },
    config: overrides.config ?? {},
    resolved: overrides.resolved ?? {
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
      modelRegistry: {},
    },
    toolRegistry: {
      getAll: () => [],
      get: () => null,
      register: () => {},
    },
    extensions: {
      cleanup: async () => {},
    },
    ...overrides,
  };
}

/**
 * Capture console.log output for the duration of a callback.
 * Usage:
 *   const output = await captureConsole(async () => {
 *     await someHandlerThatLogs();
 *   });
 */
export async function captureConsole<T>(fn: () => Promise<T> | T): Promise<{ output: string; result: T }> {
  let captured = "";
  const orig = console.log;
  console.log = (...args: unknown[]) => { captured += args.join(" ") + "\n"; };
  try {
    const result = await fn();
    return { output: captured, result };
  } finally {
    console.log = orig;
  }
}

/**
 * Suppress console.log output for the duration of a callback.
 * Usage:
 *   await withSilentConsole(async () => {
 *     await someHandlerThatLogs();
 *   });
 */
export async function withSilentConsole<T>(fn: () => Promise<T> | T): Promise<T> {
  const orig = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = orig;
  }
}
