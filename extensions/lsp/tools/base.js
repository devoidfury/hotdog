// Base LSP tool class — common functionality for all LSP tools.

import fs from "node:fs";
import path from "node:path";
import { LspClient } from "../client.js";
import { pathToUri, uriToPath, getLanguageId } from "../utils.js";
import { getServerByLanguageId } from "../config.js";
import {
  lspClientCache,
  getCachedClient,
  deleteCachedClient,
} from "../client-cache.js";
import { toolDef, param, ToolResult, defaultCallDisplay } from "../../core-tools/registry.js";
import { formatError } from "../../../src/context/error.js";

/**
 * Base class for all LSP tools.
 */
export class LspBaseTool {
  /** @type {string} */
  static TOOL_NAME = "lsp-base";

  /** @type {string} */
  static DESCRIPTION = "";

  /** @type {string[]} */
  static REQUIRED_CAPABILITIES = [];

  /** @type {object} */
  static PARAMS = {};

  /** @type {string[]} */
  static REQUIRED = [];

  constructor(options = {}) {
    this.lspClient = options.lspClient || null;
    this.languageId = options.languageId || null;
    this.uri = options.uri || null;
    this.maxOutputLines = options.maxOutputLines || 800;
    this.lspConfig = options.lspConfig || null;
  }

  /**
   * Get the tool definition for OpenAI function-calling.
   * Auto-generates from PARAMS/REQUIRED static properties.
   * Subclasses can override to customize.
   */
  toToolDef() {
    return toolDef(
      this.constructor.TOOL_NAME,
      this.constructor.DESCRIPTION || "LSP tool",
      {
        schema: "https://json-schema.org/draft/2020-12/schema",
        properties: this.constructor.PARAMS,
        required: this.constructor.REQUIRED,
      },
    );
  }

  /**
   * Generate a display string for tool calls from arguments.
   * Default implementation shows the first few args.
   */
  callDisplay(input) {
    return defaultCallDisplay(input, (args) => {
      const parts = Object.entries(args)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${typeof v === "string" ? `"${v}"` : v}`);
      return `${this.constructor.TOOL_NAME}(${parts.join(", ")})`;
    });
  }

  /**
   * Execute the tool with the given input.
   * Override in subclasses.
   */
  async execute(input, ctx) {
    return ToolResult.err("Not implemented");
  }

  // ── Shared Helpers ──────────────────────────────────────────────────

  /**
   * Validate that a position is within document bounds.
   * Returns null if valid, or an error message string if invalid.
   * This prevents TypeScript server crashes from invalid positions.
   * @param {string} filePath - Absolute file path
   * @param {number} line - Line number (1-indexed, will be converted to 0-indexed for LSP)
   * @param {number} character - Zero-based character offset (UTF-16)
   * @returns {string|null} Error message or null if valid
   */
  _validatePosition(filePath, line, character) {
    if (line < 0) return `Line must be >= 0, got ${line}.`;
    if (character < 0) return `Character must be >= 0, got ${character}.`;

    let content;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (e) {
      return `Cannot read file for position validation: ${e.message}`;
    }

    const lines = content.split("\n");
    if (line >= lines.length) {
      return `Line ${line} is out of range (file has ${lines.length} lines, 1-indexed: 1–${lines.length}).`;
    }

    const lineContent = lines[line];
    if (character > lineContent.length) {
      return `Character ${character} is out of range for line ${line} (line has ${lineContent.length} characters).`;
    }

    return null;
  }

  /**
   * Resolve a file path against workspace root or cwd boundary.
   * @param {string} filePath - The file path to resolve
   * @param {object} ctx - Tool context with cwdBoundary and workspaceRoot
   * @returns {string} Resolved absolute path
   */
  _resolvePath(filePath, ctx) {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    if (ctx?.cwdBoundary) {
      return path.resolve(ctx.cwdBoundary, filePath);
    }
    if (ctx?.workspaceRoot) {
      return path.resolve(ctx.workspaceRoot, filePath);
    }
    return path.resolve(filePath);
  }

  /**
   * Get or create an LSP client for the given language.
   * Initializes the client with server config before returning.
   * @param {string} languageId - Language identifier
   * @param {object} ctx - Tool context
   * @param {object} [lspConfig] - LSP configuration
   * @returns {Promise<LspClient|null>}
   */
  async _getClient(languageId, ctx, lspConfig) {
    // Use cached client if available
    const cached = getCachedClient(languageId);
    if (cached && cached.isReady()) {
      return cached;
    }
    // Client is dead or not found — clear
    if (cached) {
      deleteCachedClient(languageId);
    }

    // Look up server config
    let serverConfig;
    if (this.lspConfig) {
      serverConfig = getServerByLanguageId(languageId, this.lspConfig);
    }
    if (!serverConfig && ctx?.lspConfig) {
      serverConfig = getServerByLanguageId(languageId, ctx.lspConfig);
    }
    if (!serverConfig) {
      return null;
    }

    // Create new client
    const client = new LspClient({
      requestTimeoutMs: serverConfig.timeoutMs || 30000,
      serverStartupTimeoutMs: 60000,
    });

    // Initialize the client with server config
    try {
      await client.initialize({
        command: serverConfig.command,
        args: serverConfig.args || [],
        initializationOptions: serverConfig.initializationOptions,
        rootPath: ctx?.workspaceRoot || process.cwd(),
        env: serverConfig.env,
        timeoutMs: serverConfig.timeoutMs,
      });
    } catch (e) {
      formatError(e); // Log the error
      return null;
    }

    lspClientCache.set(languageId, client);
    return client;
  }

  /**
   * Get the language ID for a file path.
   * @param {string} filePath - File path
   * @returns {string}
   */
  _getLanguageId(filePath) {
    return getLanguageId(filePath);
  }

  /**
   * Convert a file path to a file:// URI.
   * @param {string} filePath - File path
   * @returns {string}
   */
  _pathToUri(filePath) {
    return pathToUri(filePath);
  }

  /**
   * Convert a file:// URI to a file path.
   * @param {string} uri - File URI
   * @returns {string}
   */
  _uriToPath(uri) {
    return uriToPath(uri);
  }

  /**
   * Ensure a document is open in the LSP client.
   * @param {LspClient} client - LSP client
   * @param {string} filePath - File path
   * @param {string} languageId - Language ID
   * @returns {Promise<void>}
   */
  async _ensureDocumentOpen(client, filePath, languageId) {
    const uri = this._pathToUri(filePath);
    const doc = client.documentStore.get(uri);

    if (!doc || doc.content === undefined) {
      // Read file content
      let content;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch (e) {
        throw new Error(`Cannot read file: ${filePath} — ${e.message}`);
      }

      await client.didOpen(uri, content, languageId);
    }

    return uri;
  }

  /**
   * Calculate byte offset for a position in a document.
   * Uses UTF-16 position encoding as per LSP spec.
   * @param {string} uri - Document URI (unused but kept for API compatibility)
   * @param {object} position - { line, character } position
   * @param {string} content - Document content
   * @returns {number} Byte offset
   */
  _offsetAt(uri, position, content) {
    let offset = 0;
    const lines = content.split("\n");

    // Add bytes for complete lines
    for (let i = 0; i < position.line && i < lines.length; i++) {
      offset += lines[i].length + 1; // +1 for newline
    }

    // Add bytes for characters in current line
    const lineContent = lines[position.line] || "";
    offset += Math.min(position.character || 0, lineContent.length);

    return offset;
  }

  /**
   * Format a hover result for display.
   * @param {object} hover - LSP hover result
   * @param {number} [maxLines] - Maximum lines to display
   * @returns {string}
   */
  _formatHover(hover, maxLines) {
    if (!hover) return "No hover information available.";

    let text = "";
    const contents = hover.contents;

    if (typeof contents === "string") {
      text = contents;
    } else if (Array.isArray(contents)) {
      text = contents
        .map((c) => {
          if (typeof c === "string") return c;
          if (c.value) {
            const lang = c.language ? `\`${c.language}\`` : "";
            return `${lang}\n\`\`\`${lang}\n${c.value}\n\`\`\``;
          }
          return String(c);
        })
        .join("\n\n");
    } else if (contents && typeof contents === "object") {
      if (contents.value) {
        text = contents.value;
      } else {
        text = JSON.stringify(contents, null, 2);
      }
    }

    if (hover.range) {
      const start = hover.range.start;
      text = `[Line ${start.line + 1}] ${text}`;
    }

    // Truncate if needed
    if (maxLines && text) {
      const lines = text.split("\n");
      if (lines.length > maxLines) {
        text =
          lines.slice(0, maxLines).join("\n") +
          `\n--- [truncated, ${lines.length - maxLines} more lines] ---`;
      }
    }

    return text || "No hover information available.";
  }

  /**
   * Format a location result for display.
   * @param {object} location - LSP location or LocationLink
   * @returns {string}
   */
  _formatLocation(location) {
    if (!location) return null;

    const uri = location.uri;
    const filePath = this._uriToPath(uri);
    let range;

    if ("range" in location) {
      range = location.range;
    } else if ("targetRange" in location) {
      // LocationLink
      range = location.targetRange;
    } else {
      range = location;
    }

    const start = range?.start || { line: 0, character: 0 };
    return `${filePath}:${start.line + 1}:${start.character + 1}`;
  }

  /**
   * Format completion items for display.
   * @param {object[]} items - Completion items
   * @param {number} [maxItems] - Maximum items to display
   * @returns {string}
   */
  _formatCompletions(items, maxItems) {
    if (!items || items.length === 0) return "No completions available.";

    const limit = maxItems || items.length;
    const display = items
      .slice(0, limit)
      .map((item, index) => {
        const kind = CompletionKind[item.kind] || "Unknown";
        const detail = item.detail ? ` ${item.detail}` : "";
        const insertText = item.insertText
          ? ` [insert: ${item.insertText}]`
          : "";
        const sortText = item.sortText ? ` [sort: ${item.sortText}]` : "";
        return `  ${index + 1}. ${item.label}${detail}${insertText}${sortText} (${kind})`;
      })
      .join("\n");

    const remaining = items.length - limit;
    return remaining > 0
      ? `${display}\n--- [${remaining} more completions not shown] ---`
      : display;
  }

  /**
   * Format diagnostics for display.
   * @param {object[]} diagnostics - LSP diagnostics
   * @param {number} [maxItems] - Maximum items to display
   * @returns {string}
   */
  _formatDiagnostics(diagnostics, maxItems) {
    if (!diagnostics || diagnostics.length === 0) return "No diagnostics.";

    const limit = maxItems || diagnostics.length;
    const display = diagnostics
      .slice(0, limit)
      .map((diag, index) => {
        const severity = DiagnosticSeverity[diag.severity] || "Unknown";
        const source = diag.source ? `[${diag.source}] ` : "";
        const location = this._formatLocation({
          uri: diag.uri,
          range: diag.range,
        });
        return `  ${index + 1}. ${severity}: ${source}${diag.message} (${location})`;
      })
      .join("\n");

    const remaining = diagnostics.length - limit;
    return remaining > 0
      ? `${display}\n--- [${remaining} more diagnostics not shown] ---`
      : display;
  }

  /**
   * Format symbol information for display.
   * @param {object} symbol - LSP symbol
   * @param {number} [indent] - Indentation level
   * @returns {string}
   */
  _formatSymbol(symbol, indent = 0) {
    if (!symbol) return "";

    const prefix = "  ".repeat(indent);
    const kind = SymbolKind[symbol.kind] || "Unknown";
    const location = this._formatLocation(symbol.location || symbol.range);
    const detail = symbol.detail ? ` — ${symbol.detail}` : "";

    let result = `${prefix}${kind}: ${symbol.name}${detail} (${location})`;

    // Recurse into children
    if (symbol.children && symbol.children.length > 0) {
      result +=
        "\n" +
        symbol.children
          .map((child) => this._formatSymbol(child, indent + 1))
          .join("\n");
    }

    return result;
  }
}

// ── LSP Constants ────────────────────────────────────────────────────────

/** Completion item kind enum */
export const CompletionKind = {
  1: "Text",
  2: "Method",
  3: "Function",
  4: "Constructor",
  5: "Field",
  6: "Variable",
  7: "Class",
  8: "Interface",
  9: "Module",
  10: "Property",
  11: "Unit",
  12: "Value",
  13: "Enum",
  14: "Keyword",
  15: "Snippet",
  16: "Color",
  17: "File",
  18: "Reference",
  19: "Folder",
  20: "EnumMember",
  21: "Constant",
  22: "Struct",
  23: "Event",
  24: "Operator",
  25: "TypeParameter",
};

/** Symbol kind enum */
export const SymbolKind = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

/** Diagnostic severity enum */
export const DiagnosticSeverity = {
  1: "Error",
  2: "Warning",
  3: "Information",
  4: "Hint",
};
