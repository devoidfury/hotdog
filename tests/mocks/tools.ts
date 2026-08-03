// Mock tools for testing.

import { ToolResult } from '../../src/core/extensions/tool-utils.ts';
import type { Tool, ToolDef, ToolMetadata } from '../../src/core/extensions/tool-registry.ts';

export class MockTool implements Tool {
  name: string;
  metadata: ToolMetadata;
  _executeFn: (input: string | Record<string, unknown> | null, ctx: unknown) => unknown | Promise<unknown>;
  _toToolDefFn: () => ToolDef;
  _callDisplayFn: ((input: string | Record<string, unknown> | null) => string) | null;
  executeCount: number;
  lastInput: string | Record<string, unknown> | null;
  lastContext: unknown;
  [key: string]: unknown;

  constructor({ name, execute, toToolDef, callDisplay, metadata }: {
    name?: string;
    execute?: (input: string | Record<string, unknown> | null, ctx: unknown) => unknown | Promise<unknown>;
    toToolDef?: () => ToolDef;
    callDisplay?: (input: string | Record<string, unknown> | null) => string;
    metadata?: ToolMetadata;
  } = {}) {
    this.name = name || 'mock-tool';
    this.metadata = metadata || { sideEffects: false, difficulty: 1 };
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

  toToolDef(): ToolDef {
    return this._toToolDefFn();
  }

  async execute(input: string | Record<string, unknown> | null, ctx: unknown): Promise<unknown> {
    this.executeCount++;
    this.lastInput = input;
    this.lastContext = ctx;
    return this._executeFn(input, ctx);
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    if (this._callDisplayFn) return this._callDisplayFn(input);
    return `mock-tool(${JSON.stringify(input)})`;
  }
}

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
  execute: (input: string | Record<string, unknown> | null, ctx: unknown) => unknown | Promise<unknown>,
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
