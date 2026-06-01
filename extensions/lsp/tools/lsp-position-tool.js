// Generic LSP Position Tool — shared execution logic for all position-based LSP tools.
// Subclasses only need to define: TOOL_NAME, DESCRIPTION, LSP_METHOD,
// REQUIRED_CAPABILITY, and implement _formatResult().

import fs from "node:fs";
import { LspBaseTool } from "./base.js";
import { toolDef, param, ToolResult, parseToolInput } from "../../core-tools/registry.js";
import { formatError } from "../../../src/context/error.js";

/**
 * Base class for LSP tools that operate on a position in a file.
 * Handles argument parsing, validation, client setup, and error handling.
 *
 * Subclasses must implement:
 *   - _buildRequestParams(args, uri, lspLine) — build the LSP request params
 *   - _formatResult(result, args, resolvedPath, languageId, lspLine) — format the response
 *
 * Subclasses may override:
 *   - PARAMS — additional parameters beyond the standard file/line/character
 *   - REQUIRED — additional required parameters beyond the standard
 */
export class LspPositionTool extends LspBaseTool {
  static TOOL_NAME = "lsp-position-base";
  static DESCRIPTION = "Generic LSP position tool";
  static LSP_METHOD = ""; // e.g., 'textDocument/hover'
  static REQUIRED_CAPABILITY = ""; // e.g., 'hoverProvider'
  static HAS_POSITION = true; // whether this tool needs line/character
  static HAS_FILE = true; // whether this tool needs a file
  static SUCCESS_RESPONSE = null; // default success message (null = no result)

  // Standard parameters for position-based tools — subclasses may extend
  static PARAMS = {
    file: { type: "string", description: "Path to the file." },
    line: { type: "integer", description: "1-indexed line number." },
    character: { type: "integer", description: "0-indexed character offset (UTF-16)." },
  };
  static REQUIRED = ["file", "line", "character"];

  /**
   * Generate tool definition from PARAMS/REQUIRED declarations.
   * Subclasses can override to add custom parameters.
   */
  toToolDef() {
    return toolDef(
      this.constructor.TOOL_NAME,
      this.constructor.DESCRIPTION,
      {
        schema: "https://json-schema.org/draft/2020-12/schema",
        properties: this.constructor.PARAMS,
        required: this.constructor.REQUIRED,
      },
    );
  }

  /**
   * Generate a display string for tool calls from arguments.
   */
  callDisplay(input) {
    const args = typeof input === "string" ? JSON.parse(input) : input;
    const parts = [];
    if (this.constructor.HAS_FILE) parts.push(args.file ?? "");
    if (this.constructor.HAS_POSITION) {
      parts.push(args.line ?? "", args.character ?? "");
    }
    // Include any extra params
    for (const key of Object.keys(args)) {
      if (!["file", "line", "character"].includes(key) && args[key] !== undefined) {
        parts.push(`${key}=${args[key]}`);
      }
    }
    return `${this.constructor.TOOL_NAME}(${parts.join(":")})`;
  }

  /**
   * Parse and validate arguments.
   * @param {string|object} input
   * @returns {object|null}
   */
  _parseArgs(input) {
    const json = parseToolInput(input);
    if (!json) return null;

    const args = {};
    if (this.constructor.HAS_FILE) args.file = json.file;
    if (this.constructor.HAS_POSITION) {
      args.line = json.line;
      args.character = json.character;
    }
    // Pass through any extra params defined by subclasses
    for (const key of Object.keys(json)) {
      if (!(key in args)) args[key] = json[key];
    }
    return args;
  }

  /**
   * Validate required arguments and return error or null.
   * @param {object} args
   * @returns {string|null} Error message or null
   */
  _validateArgs(args) {
    if (this.constructor.HAS_FILE && (args.file === undefined || args.file === null)) {
      return "file is required";
    }
    if (this.constructor.HAS_POSITION) {
      if (args.line === undefined || args.line === null) return "line is required";
      if (args.character === undefined || args.character === null) return "character is required";
    }
    return null;
  }

  /**
   * Prepare and validate: resolve path, get client, ensure document open.
   * Returns { resolvedPath, languageId, client, lspLine, args } or an error ToolResult.
   */
  async _prepareAndValidate(input, ctx) {
    const args = this._parseArgs(input);
    if (!args) return { error: ToolResult.err("Error parsing arguments") };

    const validationError = this._validateArgs(args);
    if (validationError) return { error: ToolResult.err(validationError) };

    const resolvedPath = this._resolvePath(args.file, ctx);
    if (!fs.existsSync(resolvedPath)) {
      return { error: ToolResult.err(`File not found: ${resolvedPath}`) };
    }

    // Convert 1-indexed line to 0-indexed for LSP server
    const lspLine = this.constructor.HAS_POSITION ? args.line - 1 : 0;
    const posError = this.constructor.HAS_POSITION
      ? this._validatePosition(resolvedPath, lspLine, args.character)
      : null;
    if (posError) return { error: ToolResult.err(`Invalid position: ${posError}`) };

    const languageId = this._getLanguageId(resolvedPath);
    const client = await this._getClient(languageId, ctx, this.lspConfig);
    if (!client) {
      return {
        error: ToolResult.err(
          `No language server configured for '${languageId}'. ` +
            "Configure an LSP server in your profile or defaults.json."
        ),
      };
    }

    const uri = await this._ensureDocumentOpen(client, resolvedPath, languageId);

    // Check server capability
    const caps = client.getCapabilities();
    if (!caps?.[this.constructor.REQUIRED_CAPABILITY]) {
      return {
        error: ToolResult.err(
          `Server does not support ${this.constructor.LSP_METHOD} (${this.constructor.REQUIRED_CAPABILITY} not in capabilities)`
        ),
      };
    }

    return { resolvedPath, languageId, client, lspLine, args, uri };
  }

  /**
   * Execute the LSP request and format the result.
   */
  async execute(input, ctx) {
    const { resolvedPath, languageId, client, lspLine, args, uri, error } =
      await this._prepareAndValidate(input, ctx);

    if (error) return error;

    try {
      // Build request params
      const requestParams = this._buildRequestParams(args, uri, lspLine);

      // Execute LSP request
      const result = await client.request(this.constructor.LSP_METHOD, requestParams);

      // Handle null/empty results
      if (result === null || result === undefined) {
        if (this.constructor.SUCCESS_RESPONSE) {
          return ToolResult.ok(this.constructor.SUCCESS_RESPONSE);
        }
        return ToolResult.ok("No result from language server.");
      }

      // Format and return
      return this._formatResult(result, args, resolvedPath, languageId, lspLine);
    } catch (e) {
      const msg = e.message || String(e);
      if (
        msg.includes("computePositionOfLineAndCharacter") ||
        msg.includes("Debug Failure")
      ) {
        return ToolResult.err(
          `Language server crashed at this position. ` +
            `Try placing the cursor directly on the symbol name.`
        );
      }
      return ToolResult.err(`${this.constructor.TOOL_NAME.replace("lsp-", "")} failed: ${formatError(e)}`);
    }
  }

  /**
   * Build LSP request parameters. Override in subclasses.
   * @param {object} args — Parsed arguments
   * @param {string} uri — Document URI
   * @param {number} lspLine — 0-indexed line number
   * @returns {object} Request params
   */
  _buildRequestParams(args, uri, lspLine) {
    const params = {
      textDocument: { uri },
    };
    if (this.constructor.HAS_POSITION) {
      params.position = { line: lspLine, character: args.character };
    }
    return params;
  }

  /**
   * Format the LSP result for display. Override in subclasses.
   * @param {any} result — Raw LSP response
   * @param {object} args — Parsed arguments
   * @param {string} resolvedPath — Resolved file path
   * @param {string} languageId — Language identifier
   * @param {number} lspLine — 0-indexed line number
   * @returns {ToolResult}
   */
  _formatResult(result, args, resolvedPath, languageId, lspLine) {
    return ToolResult.ok("Not implemented — override in subclass");
  }
}

/**
 * LSP tool that only needs a file (no position), e.g., document symbols, diagnostics.
 */
export class LspFileTool extends LspPositionTool {
  static HAS_POSITION = false;
  static HAS_FILE = true;
  static PARAMS = {
    file: { type: "string", description: "Path to the file." },
  };
  static REQUIRED = ["file"];

  _buildRequestParams(args, uri, lspLine) {
    return { textDocument: { uri } };
  }
}

/**
 * LSP tool that only needs a query (no file), e.g., workspace symbols.
 */
export class LspQueryTool extends LspBaseTool {
  static HAS_QUERY = true;
  static PARAMS = {
    query: { type: "string", description: "Search query string. Empty string returns all symbols." },
  };
  static REQUIRED = ["query"];

  /**
   * Generate tool definition from PARAMS/REQUIRED declarations.
   */
  toToolDef() {
    return toolDef(
      this.constructor.TOOL_NAME,
      this.constructor.DESCRIPTION,
      {
        schema: "https://json-schema.org/draft/2020-12/schema",
        properties: this.constructor.PARAMS,
        required: this.constructor.REQUIRED,
      },
    );
  }

  /**
   * Generate a display string for tool calls from arguments.
   */
  callDisplay(input) {
    const args = typeof input === "string" ? JSON.parse(input) : input;
    return `${this.constructor.TOOL_NAME}('${args.query ?? ""}')`;
  }

  async execute(input, ctx) {
    const json = parseToolInput(input);
    if (!json) {
      return ToolResult.err("Error parsing arguments");
    }

    const query = json?.query;
    if (query === undefined || query === null) {
      return ToolResult.err("query is required");
    }

    // Get language ID from context
    const languageId = ctx?.currentFile
      ? this._getLanguageId(ctx.currentFile)
      : "typescript";

    const client = await this._getClient(languageId, ctx, this.lspConfig);
    if (!client) {
      return ToolResult.err(
        `No language server configured for '${languageId}'. ` +
          "Configure an LSP server in your profile or defaults.json."
      );
    }

    try {
      const caps = client.getCapabilities();
      if (!caps?.[this.constructor.REQUIRED_CAPABILITY]) {
        return ToolResult.err(
          `Server does not support ${this.constructor.LSP_METHOD}`
        );
      }

      const result = await client.request(this.constructor.LSP_METHOD, {
        query,
      });

      if (!result || result.length === 0) {
        return ToolResult.ok(`No symbols found matching '${query}'.`);
      }

      return this._formatResult(result, { query }, languageId);
    } catch (e) {
      return ToolResult.err(
        `${this.constructor.TOOL_NAME.replace("lsp-", "")} failed: ${formatError(e)}`
      );
    }
  }

  _formatResult(result, args, languageId) {
    return ToolResult.ok("Not implemented — override in subclass");
  }
}
