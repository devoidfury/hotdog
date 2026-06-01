// Tool registry — re-exported from extensions/core-tools.
// This consolidates the two ToolRegistry classes into one source of truth.

import { ToolRegistry } from "../../extensions/core-tools/registry.js";

export { ToolRegistry, toolResult, toolDef, param } from "../../extensions/core-tools/registry.js";

/**
 * Create a new ToolRegistry instance.
 * @returns {ToolRegistry}
 */
export function createToolRegistry() {
  return new ToolRegistry();
}
