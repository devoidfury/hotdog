// Minimal tool registry for the core.
// Extensions register tools via `register(name, tool)`.
// The full registry (with filtering, etc.) lives in the tools extension.

export class ToolRegistry {
  constructor() {
    this._tools = new Map();
  }

  /**
   * Register a tool.
   * @param {string} name
   * @param {Object} tool - Tool instance with `execute(input, ctx)` and optionally `toToolDef()`.
   */
  register(name, tool) {
    this._tools.set(name, tool);
  }

  /**
   * Get a tool by name.
   * @param {string} name
   * @returns {Object|undefined}
   */
  get(name) {
    return this._tools.get(name);
  }

  /**
   * Check if a tool is registered.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this._tools.has(name);
  }

  /**
   * Get all registered tools as [name, tool] pairs.
   * @returns {Array<[string, Object]>}
   */
  getAll() {
    return Array.from(this._tools.entries());
  }

  /**
   * Get tool definitions for the LLM API.
   * @returns {Array<Object>}
   */
  getToolDefs() {
    return Array.from(this._tools.values())
      .filter(t => t.toToolDef)
      .map(t => t.toToolDef());
  }
}

/**
 * Create a new ToolRegistry instance.
 * @returns {ToolRegistry}
 */
export function createToolRegistry() {
  return new ToolRegistry();
}
