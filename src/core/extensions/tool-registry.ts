// Tool registry — holds all available tools.

import {
  validateParams,
  formatValidationErrors,
} from "../../utils/json-schema.ts";
import { logger } from "../logger.ts";

export interface ToolDef {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Tool {
  toToolDef?: () => ToolDef | Promise<ToolDef> | null;
  callDisplay?: (input: string | Record<string, unknown> | null) => string;
  execute?: (
    input: string | Record<string, unknown> | null,
    ctx?: unknown,
  ) => Promise<unknown>;
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
    if (!tool || !tool.toToolDef) {
      const nullPromise = Promise.resolve(null);
      this.#toolDefCache.set(name, nullPromise);
      return nullPromise;
    }

    // Normalize: toToolDef() may return a sync ToolDef or a Promise<ToolDef>.
    const defPromise = Promise.resolve(
      tool.toToolDef(),
    ) as Promise<ToolDef | null>;
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
      if (t.toToolDef) {
        try {
          const def = await t.toToolDef();
          if (def) defs.push(def as ToolDef);
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
    whitelist?: string[],
    blacklist?: string[],
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
   * Validate tool arguments against the tool's JSON Schema.
   */
  async validateToolArgs(
    toolName: string,
    input: unknown,
  ): Promise<string | null> {
    const tool = this.get(toolName);
    if (!tool || !tool.toToolDef) return null;

    const def = await this.getToolDef(toolName);
    const params = def?.function?.parameters as Record<string, unknown> | null;
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
