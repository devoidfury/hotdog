import {
  validateParams,
  formatValidationErrors,
} from "../../utils/json-schema.ts";
import { logger } from "../logger.ts";
import type { ToolContext, DefaultToolContext } from "./tool-context.ts";

/**
 * Metadata describing a tool's behavior characteristics.
 * Used for sandbox mode filtering and difficulty-based tool hiding.
 */
export interface ToolMetadata {
  /** True if the tool can perform writes or network access. */
  sideEffects: boolean;
  /** Difficulty score 1-5: how hard this tool is to use correctly. */
  difficulty: number;
}

export interface ToolDef {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Base Tool interface — all tools must implement these methods.
 *
 * - `toToolDef()` returns the tool's OpenAI function-calling schema.
 * - `callDisplay()` formats a human-readable description of a tool call.
 * - `execute()` runs the tool and returns a result.
 * - `metadata` describes tool characteristics (sideEffects, difficulty).
 *
 * Generic parameter T allows tools to declare the context keys they need.
 * Default is DefaultToolContext for backward compatibility.
 */
export interface Tool<TCtx extends Record<string, unknown> = DefaultToolContext> {
  toToolDef(): ToolDef | Promise<ToolDef> | null;
  callDisplay(input: string | Record<string, unknown> | null): string;
  execute(
    input: string | Record<string, unknown> | null,
    ctx?: ToolContext<TCtx>,
  ): Promise<unknown>;
  /**
   * Tool metadata for filtering and sandbox mode. Required on all tools.
   */
  metadata: ToolMetadata;
}

/**
 * Character set allowed in tool names. Tool names are sent to the model as
 * OpenAI function names, which strict APIs (OpenAI itself) validate against
 * `^[a-zA-Z0-9_-]+$`; a name with other characters fails the whole request.
 */
export const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export class ToolRegistry {
  tools: Map<string, Tool>;
  #toolDefCache: Map<string, Promise<ToolDef | null>>;
  #allToolDefsCache: Promise<ToolDef[]> | null;

  constructor() {
    this.tools = new Map();
    this.#toolDefCache = new Map();
    this.#allToolDefsCache = null;
  }

  register(name: string, tool: Tool): void {
    if (!TOOL_NAME_RE.test(name)) {
      throw new Error(
        `Tool name "${name}" is invalid: only letters, digits, "-" and "_" are allowed ` +
          "(tool names are sent to the model API as OpenAI function names, which reject other characters)",
      );
    }
    if (!tool.metadata) {
      throw new Error(`Tool "${name}" is missing required metadata`);
    }
    if (tool.metadata.sideEffects !== true && tool.metadata.sideEffects !== false) {
      throw new Error(`Tool "${name}" metadata.sideEffects must be explicitly defined as true or false`);
    }
    if (tool.metadata.difficulty < 1 || tool.metadata.difficulty > 5) {
      throw new Error(`Tool "${name}" metadata.difficulty must be between 1 and 5, got ${tool.metadata.difficulty}`);
    }
    this.tools.set(name, tool);
    this.#toolDefCache.delete(name);
    this.#allToolDefsCache = null;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  getMetadata(name: string): ToolMetadata | undefined {
    const tool = this.tools.get(name);
    return tool?.metadata;
  }

  getAllWithMetadata(): Array<{ name: string; tool: Tool; metadata: ToolMetadata }> {
    return Array.from(this.tools.entries()).map(([name, tool]) => ({
      name,
      tool,
      metadata: tool.metadata,
    }));
  }

  getAll(): [string, Tool][] {
    return Array.from(this.tools.entries());
  }

  /**
   * Get the tool definition for a single tool, with caching.
   */
  async getToolDef(name: string): Promise<ToolDef | null> {
    const cached = this.#toolDefCache.get(name);
    if (cached) return cached;

    const tool = this.tools.get(name);
    if (!tool) {
      const nullPromise = Promise.resolve(null);
      this.#toolDefCache.set(name, nullPromise);
      return nullPromise;
    }

    // Normalize: toToolDef() may return a sync ToolDef or a Promise<ToolDef>.
    const defPromise = Promise.resolve(tool.toToolDef()) as Promise<ToolDef | null>;
    this.#toolDefCache.set(name, defPromise);
    return defPromise;
  }

  /**
   * Get all tool definitions, with caching.
   */
  async getToolDefs(): Promise<ToolDef[]> {
    const cached = this.#allToolDefsCache;
    if (cached) return cached;

    const defs: ToolDef[] = [];
    let hadError = false;

    for (const [name, t] of this.tools.entries()) {
      try {
        const def = await t.toToolDef();
        if (def) defs.push(def);
      } catch (err) {
        // Individual tool def failed — log and skip. The all-defs cache is
        // left unset below so the next call retries every tool; per-tool
        // cache entries are untouched here (we called toToolDef() directly),
        // so a failed tool's stale getToolDef() entry stays until register()/
        // remove() clears it.
        logger.warn(
          `[tools] Failed to get tool def for "${name}": ${(err as Error).message}`,
        );
        hadError = true;
      }
    }

    if (!hadError) {
      defs.sort((a, b) => a.function.name.localeCompare(b.function.name));
      this.#allToolDefsCache = Promise.resolve(defs);
    }
    return defs;
  }

  clearToolDefs(): void {
    this.#allToolDefsCache = null;
    this.#toolDefCache.clear();
  }

  remove(name: string): boolean {
    const existed = this.tools.delete(name);
    if (existed) {
      this.#toolDefCache.delete(name);
      this.#allToolDefsCache = null;
    }
    return existed;
  }

  removeAll(names: string[]): number {
    let count = 0;
    for (const name of names) {
      if (this.tools.delete(name)) {
        this.#toolDefCache.delete(name);
        count++;
      }
    }
    if (count > 0) {
      this.#allToolDefsCache = null;
    }
    return count;
  }

  clear(): void {
    this.tools.clear();
    this.#toolDefCache.clear();
    this.#allToolDefsCache = null;
  }

  filter(
    whitelist?: string[] | null,
    blacklist?: string[] | null,
    _managerToolsEnabled = false,
  ): ToolRegistry {
    const result = new ToolRegistry();
    for (const [name, tool] of this.tools) {
      if (blacklist && blacklist.includes(name)) continue;
      if (whitelist && !whitelist.includes(name)) continue;
      result.register(name, tool);
    }
    return result;
  }

  filterByDifficulty(maxDifficulty: number): ToolRegistry {
    const result = new ToolRegistry();
    for (const [name, tool] of this.tools) {
      if (tool.metadata.difficulty <= maxDifficulty) {
        result.register(name, tool);
      }
    }
    return result;
  }

  /** Even with allowSideEffects: true the result is a copy, never `this`. */
  filterBySideEffects(allowSideEffects: boolean): ToolRegistry {
    const result = new ToolRegistry();
    for (const [name, tool] of this.tools) {
      if (allowSideEffects) {
        result.register(name, tool);
      } else if (!tool.metadata.sideEffects) {
        result.register(name, tool);
      }
    }
    return result;
  }

  /** Always returns a new registry (never `this`), even when no filtering is applied. */
  filterByMetadata(options?: {
    maxDifficulty?: number;
    allowSideEffects?: boolean;
  }): ToolRegistry {
    let result: ToolRegistry;
    if (options?.maxDifficulty !== undefined) {
      result = this.filterByDifficulty(options.maxDifficulty);
    } else {
      result = new ToolRegistry();
      for (const [name, tool] of this.tools) {
        result.register(name, tool);
      }
    }
    if (options?.allowSideEffects === false) {
      result = result.filterBySideEffects(false);
    }
    return result;
  }

  async validateToolArgs(
    toolName: string,
    input: unknown,
  ): Promise<string | null> {
    const tool = this.get(toolName);
    if (!tool) return null;

    const def = await this.getToolDef(toolName);
    const params = def?.function?.parameters;
    if (!params) return null;

    let args: unknown;
    if (typeof input === "string") {
      try {
        args = JSON.parse(input);
      } catch {
        args = input;
      }
    } else {
      args = input;
    }

    if (
      args === null ||
      args === undefined ||
      typeof args !== "object" ||
      Array.isArray(args)
    ) {
      const typeName =
        args === null ? "null" : Array.isArray(args) ? "array" : typeof args;
      return `Tool '${toolName}' expects an object with parameters, got ${typeName}`;
    }

    const result = validateParams(args as Record<string, unknown>, params);
    if (!result.valid) {
      return formatValidationErrors(result.errors);
    }
    return null;
  }
}

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}
