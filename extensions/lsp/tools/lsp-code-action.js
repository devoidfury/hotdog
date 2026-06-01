// LSP Code Action tool — textDocument/codeAction

import fs from "node:fs";
import {
  LspBaseTool,
  CompletionKind,
  SymbolKind,
  DiagnosticSeverity,
} from "./base.js";
import { toolDef, param, ToolResult } from "../../core-tools/registry.js";
import { formatError } from "../../../src/context/error.js";

export class LspCodeActionTool extends LspBaseTool {
  static TOOL_NAME = "lsp-code-action";
  static DESCRIPTION =
    "Get available code actions (quick fixes, refactoring options) at a given position. Returns actions with titles, descriptions, and edit operations.";

  toToolDef() {
    return toolDef(LspCodeActionTool.TOOL_NAME, LspCodeActionTool.DESCRIPTION, {
      schema: "https://json-schema.org/draft/2020-12/schema",
      properties: {
        file: param("string", "Path to the file."),
        line: param("integer", "1-indexed line number."),
        character: param(
          "integer",
          "0-indexed character offset (UTF-16).",
        ),
      },
      required: ["file", "line", "character"],
    });
  }

  callDisplay(input) {
    const args = typeof input === "string" ? JSON.parse(input) : input;
    return `codeAction(${args.file}:${args.line}:${args.character})`;
  }

  async execute(input, ctx) {
    const args = typeof input === "string" ? JSON.parse(input) : input;
    const filePath = args.file;
    const line = args.line;
    const character = args.character;

    if (filePath === undefined || filePath === null) {
      return ToolResult.err("file is required");
    }
    if (line === undefined || line === null) {
      return ToolResult.err("line is required");
    }
    if (character === undefined || character === null) {
      return ToolResult.err("character is required");
    }

    // Resolve path
    const resolvedPath = this._resolvePath(filePath, ctx);

    // Check file exists
    if (!fs.existsSync(resolvedPath)) {
      return ToolResult.err(`File not found: ${resolvedPath}`);
    }

    // Convert 1-indexed line to 0-indexed for LSP server
    const lspLine = line - 1;

    // Get language ID and client
    const languageId = this._getLanguageId(resolvedPath);
    const client = await this._getClient(languageId, ctx, this.lspConfig);

    if (!client) {
      return ToolResult.err(
        `No language server configured for '${languageId}'. ` +
          "Configure an LSP server in your profile or defaults.json.",
      );
    }

    try {
      // Ensure document is open
      const uri = await this._ensureDocumentOpen(
        client,
        resolvedPath,
        languageId,
      );

      // Check server supports code actions
      const caps = client.getCapabilities();
      if (!caps?.codeActionProvider) {
        return ToolResult.err(
          `Server does not support code actions (codeActionProvider not in capabilities)`,
        );
      }

      // Send code action request
      const result = await client.request("textDocument/codeAction", {
        textDocument: { uri },
        range: {
          start: { line: lspLine, character },
          end: { line: lspLine, character },
        },
        context: {
          diagnostics: [],
          only: ["quickfix", "refactor"],
        },
      });

      if (!result || result.length === 0) {
        return ToolResult.ok("No code actions available at this position.");
      }

      // Format code actions
      const lines = result
        .map((action, index) => {
          const title = action.title || action.command?.title || "Untitled";
          const kind = action.kind ? ` [${action.kind}]` : "";
          const edit = action.edit ? " [has edit]" : "";
          const command = action.command ? " [has command]" : "";
          return `  ${index + 1}. ${title}${kind}${edit}${command}`;
        })
        .join("\n");

      const metadata = new Map();
      metadata.set("file", resolvedPath);
      metadata.set("position", `${line}:${character}`);
      metadata.set("total_actions", String(result.length));
      metadata.set("language", languageId);

      return ToolResult.ok(
        `Found ${result.length} code action(s):\n${lines}`,
      ).withEntries(metadata);
    } catch (e) {
      return ToolResult.err(`Code action failed: ${formatError(e)}`);
    }
  }
}
