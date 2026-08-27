import fs from "node:fs/promises";
import path from "node:path";
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
} from "../../core/extensions/tool-utils.ts";
import type { ToolMetadata } from "../../core/extensions/tool-registry.ts";
import { PathEscapeError } from "../../utils/workspace.ts";
import type { Workspace } from "../../utils/workspace.ts";
import { ToolContext } from "../../core/extensions/types.ts";

interface AppendArgs {
  path: string;
  content: string;
}

export class AppendTool {
  static readonly TOOL_NAME = "append";
  metadata: ToolMetadata = { sideEffects: true, difficulty: 1 };

  toToolDef() {
    return toolDef(
      AppendTool.TOOL_NAME,
      "Appends content to a file. Creates the file and parent directories if they don't exist. Content is added after any existing content.",
      {
        properties: {
          path: param("string", "File path. Path relative to the workspace root, or an absolute path inside a configured workspace root."),
          content: param("string", "Content to append to the file"),
        },
        required: ["path", "content"],
      },
    );
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    const args = parseToolInput(input);
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
    ctx: ToolContext,
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
    const workspace = ctx.get("workspace") as Workspace;

    let resolvedPath: string;
    try {
      resolvedPath = workspace.resolveSafe(filePath);
    } catch (e: unknown) {
      if (e instanceof PathEscapeError) {
        return ToolResult.err(e.message);
      }
      return ToolResult.err(`Error resolving path: ${(e as Error).message}`);
    }

    const dir = path.dirname(resolvedPath);
    const mkdirError = await safeMkdir(dir);
    if (mkdirError) {
      return mkdirError;
    }

    const appendError = await safeAppendFile(resolvedPath, content);
    if (appendError) {
      return appendError;
    }

    return ToolResult.ok(
      JSON.stringify({
        path: filePath,
        bytes_appended: Buffer.byteLength(content, "utf-8"),
      }),
    );
  }
}

async function safeMkdir(dir: string): Promise<ToolResult | null> {
  try {
    await fs.mkdir(dir, { recursive: true });
    return null;
  } catch (e: unknown) {
    return ToolResult.err(`Error creating directory: ${(e as Error).message}`);
  }
}

async function safeAppendFile(path: string, content: string): Promise<ToolResult | null> {
  try {
    await fs.appendFile(path, content, "utf-8");
    return null;
  } catch (e: unknown) {
    return ToolResult.err(`Error appending to file: ${(e as Error).message}`);
  }
}
