// Tool registry — holds all available tools.

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
  difficulty: number; // 1-5
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
 * Tool registry — holds all available tools.
 */
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

  /**
   * Get metadata for a specific tool.
   */
  getMetadata(name: string): ToolMetadata | undefined {
    const tool = this.tools.get(name);
    return tool?.metadata;
  }

  /**
   * Get all tools with their metadata.
   */
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

    for (const t of this.tools.values()) {
      try {
        const def = await t.toToolDef();
        if (def) defs.push(def);
      } catch (err) {
        // Individual tool def failed — log and skip, don't invalidate the
        // entire cache. The failed tool's individual cache entry will be
        // stale (it may have a cached null from a prior attempt), but the
        // next call to getToolDef(name) will retry because we clear it here.
        const name = (t as { name?: string }).name || "unknown";
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

  /**
   * Clear the tool definition cache.
   */
  clearToolDefs(): void {
    this.#allToolDefsCache = null;
    this.#toolDefCache.clear();
  }

  /**
   * Remove a single tool from the registry by name.
   */
  remove(name: string): boolean {
    const existed = this.tools.delete(name);
    if (existed) {
      this.#toolDefCache.delete(name);
      this.#allToolDefsCache = null;
    }
    return existed;
  }

  /**
   * Remove multiple tools from the registry by name.
   */
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

  /**
   * Clear all tools from the registry.
   */
  clear(): void {
    this.tools.clear();
    this.#toolDefCache.clear();
    this.#allToolDefsCache = null;
  }

  /**
   * Filter tools by whitelist/blacklist.
   */
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

  /**
   * Filter tools by maximum difficulty.
   * @param maxDifficulty - Maximum difficulty score (1-5)
   * @returns New ToolRegistry with only tools at or below the difficulty
   */
  filterByDifficulty(maxDifficulty: number): ToolRegistry {
    const result = new ToolRegistry();
    for (const [name, tool] of this.tools) {
      if (tool.metadata.difficulty <= maxDifficulty) {
        result.register(name, tool);
      }
    }
    return result;
  }

  /**
   * Filter tools by side effects.
   * @param allowSideEffects - If false, only tools with sideEffects: false are included.
   *   If true, returns a new registry with all tools (no filtering, but still a copy).
   * @returns New ToolRegistry with filtered tools
   */
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

  /**
   * Filter tools by both difficulty and side effects.
   * Always returns a new registry (never `this`), even when no filtering is applied.
   * @param options - Filtering options
   * @returns New ToolRegistry with filtered tools
   */
  filterByMetadata(options?: {
    maxDifficulty?: number;
    allowSideEffects?: boolean;
  }): ToolRegistry {
    let result: ToolRegistry;
    if (options?.maxDifficulty !== undefined) {
      result = this.filterByDifficulty(options.maxDifficulty);
    } else {
      // Start with a copy of all tools
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

  /**
   * Validate tool arguments against the tool's JSON Schema.
   */
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

/**
 * Create a new ToolRegistry instance.
 */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}
