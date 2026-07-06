// Tool registry — holds all available tools.

import { validateParams, formatValidationErrors } from "../../utils/json-schema.js";

/**
 * Tool registry — holds all available tools.
 */
export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(name, tool) {
    this.tools.set(name, tool);
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

  async getToolDefs() {
    const defs = [];
    for (const t of this.tools.values()) {
      if (t.toToolDef) {
        const def = t.toToolDef();
        if (def) defs.push(def);
      }
    }
    return defs;
  }

  /**
   * Remove a single tool from the registry by name.
   * @param {string} name - Tool name to remove.
   * @returns {boolean} true if the tool existed and was removed.
   */
  remove(name) {
    return this.tools.delete(name);
  }

  /**
   * Remove multiple tools from the registry by name.
   * @param {string[]} names - Tool names to remove.
   * @returns {number} Number of tools removed.
   */
  removeAll(names) {
    let count = 0;
    for (const name of names) {
      if (this.tools.delete(name)) count++;
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

    const def = await tool.toToolDef();
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
