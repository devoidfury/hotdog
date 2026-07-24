// Append tool — append content to a file.

import fs from "node:fs/promises";
import path from "node:path";
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
} from "../../core/extensions/tool-utils.ts";
import { validateCwdBoundary, resolvePath } from "../../utils/file-utils.ts";
import { ToolExecutionContext } from "../../core/extensions/types.ts";

interface AppendArgs {
  path: string;
  content: string;
}

export class AppendTool {
  static readonly TOOL_NAME = "append";

  toToolDef() {
    return toolDef(
      AppendTool.TOOL_NAME,
      "Appends content to a file. Creates the file and parent directories if they don't exist. Content is added after any existing content.",
      {
        properties: {
          path: param("string", "File path relative to workspace root"),
          content: param("string", "Content to append to the file"),
        },
        required: ["path", "content"],
      },
    );
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    let args: Record<string, unknown> | null;
    try {
      args = typeof input === "string" ? JSON.parse(input) : input;
    } catch {
      return typeof input === "string" ? input : "";
    }
    if (!args || !args.path || args.content === undefined) {
      return typeof input === "string" ? input : "";
    }
    const filePath = args.path as string;
    const content = args.content as string;
    const lines = content.split("\n").length;
    return `${filePath} append (${lines} lines)`;
  }

  async execute(
    input: string | Record<string, unknown> | null,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const rawArgs = parseToolInput(input);
    if (!rawArgs || !rawArgs.path || rawArgs.content === undefined) {
      return ToolResult.err("Error parsing arguments");
    }

    const args: AppendArgs = {
      path: rawArgs.path as string,
      content: rawArgs.content as string,
    };

    const { path: filePath, content } = args;
    const cwdBoundary = ctx.get("cwdBoundary") as string | null || null;
    const workspaceRoot = ctx.get("workspaceRoot") as string | null || null;

    const resolvedPath = resolvePath(filePath, cwdBoundary, workspaceRoot);

    const boundaryError = validateCwdBoundary(resolvedPath, cwdBoundary);
    if (boundaryError) {
      return ToolResult.err(boundaryError);
    }

    // Create parent directories
    const dir = path.dirname(resolvedPath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (e: unknown) {
      return ToolResult.err(`Error creating directory: ${(e as Error).message}`);
    }

    // Append to the file
    try {
      await fs.appendFile(resolvedPath, content, "utf-8");
    } catch (e: unknown) {
      return ToolResult.err(`Error appending to file: ${(e as Error).message}`);
    }

    return ToolResult.ok(
      JSON.stringify({
        path: filePath,
        bytes_appended: Buffer.byteLength(content, "utf-8"),
      }),
    );
  }
}
