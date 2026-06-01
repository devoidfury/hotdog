/**
 * Refresh tool — hot-reload extensions and modules at runtime.
 *
 * This tool allows the agent to reload its own code without restarting,
 * enabling real-time debugging and self-modification.
 *
 * Features:
 * - Selective reload of specific extensions by name
 * - Full reload of all extensions
 * - Module cache inspection and clearing
 * - Preserves agent state (context, messages, model, etc.)
 * - Auto-re-registers tools after reload
 */

import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/tool-registry.js";

export class RefreshTool {
  static TOOL_NAME = "refresh";

  /**
   * @param {Object} options
   * @param {Object} options.core - The core object (hooks, extensions, etc.)
   * @param {Object} [options.extensionLoader] - The ExtensionLoader instance
   * @param {Function} [options.reRegisterTools] - Callback to re-register all tools
   */
  constructor({ core, extensionLoader, reRegisterTools }) {
    this.core = core;
    this.extensionLoader = extensionLoader ?? null;
    this.reRegisterTools = reRegisterTools ?? null;
  }

  toToolDef() {
    const desc =
      'Hot-reload extensions and modules without restarting. Use "list" to see loaded modules, "all" to reload everything, or provide specific extension names to reload only those. Preserves agent state (context, messages, model, etc).';

    return toolDef(RefreshTool.TOOL_NAME, desc, {
      schema: "https://json-schema.org/draft/2020-12/schema",
      properties: {
        action: param("string", "The action to perform", {
          enum: ["reload", "list", "cache-clear"],
        }),
        target: param(
          "string",
          'Extension name to reload, or "all" for everything, or "list" to see loaded modules, or "cache-clear" to clear the module cache.',
        ),
      },
      required: ["action", "target"],
    });
  }

  callDisplay(input) {
    return defaultCallDisplay(
      input,
      (args) => `-> refresh: ${args.action} ${args.target || ""}`,
    );
  }

  /**
   * Execute the refresh tool.
   * @param {string|Object} input - Tool input
   * @param {Object} ctx - Tool context
   * @returns {Promise<ToolResult>}
   */
  async execute(input, ctx) {
    const args = parseArgs(input);
    if (!args) {
      return ToolResult.err("Invalid JSON input");
    }

    const { action, target } = args;

    switch (action) {
      case "list":
        return this._handleList();
      case "reload":
        return this._handleReload(target);
      case "cache-clear":
        return this._handleCacheClear();
      default:
        return ToolResult.err(
          `Unknown action: ${action}. Use "reload", "list", or "cache-clear".`,
        );
    }
  }

  /**
   * Handle the "list" action — show loaded modules and extensions.
   */
  async _handleList() {
    if (!this.extensionLoader) {
      return ToolResult.ok(
        "Extension loader not available. Refresh tool is not fully initialized.",
      ).withEntries({ extension_count: "0" });
    }

    const lines = [];

    // ── Loaded Extensions ────────────────────────────────────────────────
    const extensions = this.extensionLoader.all();
    const entryPoints = this.extensionLoader.entryPoints();

    lines.push("## Loaded Extensions");
    if (extensions.length === 0) {
      lines.push("  (none)");
    } else {
      for (const [name, instance] of extensions) {
        const path = entryPoints.get(name);
        const pathStr = path ? ` (${path})` : "";
        lines.push(`  ${name}${pathStr}`);
      }
    }
    lines.push("");

    return ToolResult.ok(lines.join("\n")).withEntries({
      extension_count: String(extensions.length),
    });
  }

  /**
   * Handle the "cache-clear" action — clear the module cache.
   */
  async _handleCacheClear() {
    const cacheSize = Object.keys(globalThis.__bun_package_require__.cache || {})
      .length;
    // Clear the module cache
    if (globalThis.__bun_package_require__.cache) {
      globalThis.__bun_package_require__.cache.clear();
    }
    return ToolResult.ok(`Module cache cleared (${cacheSize} modules removed).`).withEntries({
      modules_cleared: String(cacheSize),
    });
  }

  /**
   * Handle the "reload" action — reload specific or all extensions.
   * @param {string} target - Extension name or "all"
   */
  async _handleReload(target) {
    if (!target || target.trim() === "") {
      return ToolResult.err(
        'Target is required. Provide an extension name or "all".',
      );
    }

    if (!this.extensionLoader) {
      return ToolResult.err(
        "Extension loader not available. Cannot reload extensions.",
      );
    }

    // Get all loaded extension names from the ExtensionLoader
    const allNames = this.extensionLoader.all().map(([name]) => name);

    const targets =
      target.trim().toLowerCase() === "all"
        ? allNames
        : [target.trim().toLowerCase()];

    const results = [];
    const errors = [];

    for (const name of targets) {
      // Check if extension is loaded
      if (!this.extensionLoader.has(name)) {
        errors.push(`Extension "${name}" is not loaded`);
        continue;
      }

      // Get the entry point path
      const entryPoint = this.extensionLoader.entryPoints().get(name);
      if (!entryPoint) {
        errors.push(
          `Extension "${name}" was not loaded from a file path (cannot hot-reload)`,
        );
        continue;
      }

      try {
        // Use ExtensionLoader's built-in reload which handles unload + load
        await this.extensionLoader.reload(name, entryPoint);
        results.push(`✓ Reloaded: ${name}`);
      } catch (e) {
        errors.push(`✗ Failed to reload "${name}": ${e.message}`);
      }
    }

    // Re-register tools after reload
    if (results.length > 0) {
      if (this.reRegisterTools) {
        try {
          await this.reRegisterTools();
          results.push("✓ Tools re-registered");
        } catch (e) {
          errors.push(`✗ Failed to re-register tools: ${e.message}`);
        }
      } else {
        results.push("✓ Extensions reloaded (tool re-registration not available)");
      }
    }

    const output = results.join("\n");
    const errorOutput =
      errors.length > 0 ? `\nErrors:\n${errors.join("\n")}` : "";

    return ToolResult.ok(output + errorOutput).withEntries({
      reloaded: String(results.length),
      errors: String(errors.length),
    });
  }
}

/**
 * Parse refresh tool arguments.
 */
function parseArgs(input) {
  const json = parseToolInput(input);
  if (!json) return null;

  const action = json.action;
  const target = json.target;

  if (!action || typeof action !== "string") {
    return null;
  }

  if (!target || typeof target !== "string") {
    return null;
  }

  return { action, target };
}
