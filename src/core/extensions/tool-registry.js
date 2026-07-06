// Tool registry — holds all available tools.

import { validateParams, formatValidationErrors } from "../../utils/json-schema.js";

/**
 * Tool registry — holds all available tools.
 */
export class ToolRegistry {
  constructor() {
    this.tools = new Map();
    /** @type {Map<string, Promise<any>>} tool name → cached tool def promise */
    this._toolDefCache = new Map();
  }

  register(name, tool) {
    this.tools.set(name, tool);
    // Invalidate caches for this tool and the all-tools cache
    this._toolDefCache.delete(name);
    this._allToolDefsCache = null;
  }

  get(name) {
    return this.tools.get(name);
  }

  has(name) {
    return this.tools.has(name);
  }

  getAll() {
    return Array.from(this.tools.entries());
  }

  /**
   * Get the tool definition for a single tool, with caching.
   * The first call computes and caches the result; subsequent calls return the cached value.
   * Cache is invalidated when the tool is re-registered, removed, or when clearToolDefs() is called.
   *
   * @param {string} name - Tool name.
   * @returns {Promise<any|null>} Tool definition or null.
   */
  async getToolDef(name) {
    const cached = this._toolDefCache.get(name);
    if (cached) return cached;

    const tool = this.tools.get(name);
    if (!tool || !tool.toToolDef) {
      const nullPromise = Promise.resolve(null);
      this._toolDefCache.set(name, nullPromise);
      return nullPromise;
    }

    const defPromise = tool.toToolDef();
    this._toolDefCache.set(name, defPromise);
    return defPromise;
  }

  /**
   * Get all tool definitions, with caching.
   * Returns cached definitions unless the cache has been cleared.
   *
   * @returns {Promise<Array>} Array of tool definitions.
   */
  async getToolDefs() {
    const cached = this._allToolDefsCache;
    if (cached) return cached;

    try {
      const defs = [];
      for (const t of this.tools.values()) {
        if (t.toToolDef) {
          const def = t.toToolDef();
          if (def) defs.push(def);
        }
      }
      this._allToolDefsCache = Promise.resolve(defs);
      return defs;
    } catch (err) {
      // Clear the cache on error so a transient failure doesn't poison
      // future calls. The next call to getToolDefs() will re-attempt.
      this._allToolDefsCache = null;
      this._toolDefCache.clear();
      throw err;
    }
  }

  /**
   * Clear the tool definition cache.
   * Call this when tools change dynamically (e.g., MCP server reconnect).
   */
  clearToolDefs() {
    this._allToolDefsCache = null;
    this._toolDefCache.clear();
  }

  /**
   * Remove a single tool from the registry by name.
   * Invalidates caches so stale definitions are not returned.
   * @param {string} name - Tool name to remove.
   * @returns {boolean} true if the tool existed and was removed.
   */
  remove(name) {
    const existed = this.tools.delete(name);
    if (existed) {
      this._toolDefCache.delete(name);
      this._allToolDefsCache = null;
    }
    return existed;
  }

  /**
   * Remove multiple tools from the registry by name.
   * Invalidates caches so stale definitions are not returned.
   * @param {string[]} names - Tool names to remove.
   * @returns {number} Number of tools removed.
   */
  removeAll(names) {
    let count = 0;
    for (const name of names) {
      if (this.tools.delete(name)) {
        this._toolDefCache.delete(name);
        count++;
      }
    }
    if (count > 0) {
      this._allToolDefsCache = null;
    }
    return count;
  }

  /**
   * Clear all tools from the registry.
   */
  clear() {
    this.tools.clear();
  }

  /**
   * Filter tools by whitelist/blacklist.
   */
  filter(whitelist, blacklist, managerToolsEnabled = false) {
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
   * Returns an error string if validation fails, or null if valid.
   */
  async validateToolArgs(toolName, input) {
    const tool = this.get(toolName);
    if (!tool || !tool.toToolDef) return null;

    const def = await this.getToolDef(toolName);
    const params = def?.function?.parameters || null;
    if (!params) return null;

    let args;
    if (typeof input === "string") {
      try {
        args = JSON.parse(input);
      } catch {
        // If JSON parsing fails, treat as raw string input.
        // validateParams expects an object; a bare string will fail
        // validation with a clear type error rather than a confusing crash.
        args = input;
      }
    } else {
      args = input;
    }

    // Non-object input (null, number, boolean, etc.) can't satisfy an object
    // schema — return a clear error rather than letting the validator produce
    // a confusing message about missing properties.
    if (args === null || args === undefined || typeof args !== "object" || Array.isArray(args)) {
      const typeName = args === null ? "null" : Array.isArray(args) ? "array" : typeof args;
      return `Tool '${toolName}' expects an object with parameters, got ${typeName}`;
    }

    const result = validateParams(args, params);
    if (!result.valid) {
      return formatValidationErrors(result.errors);
    }
    return null;
  }
}

/**
 * Create a new ToolRegistry instance.
 *
 * @returns {ToolRegistry} New tool registry.
 */
export function createToolRegistry() {
  return new ToolRegistry();
}
