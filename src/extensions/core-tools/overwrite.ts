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

interface OverwriteArgs {
  path: string;
  content: string;
}

export class OverwriteTool {
  static readonly TOOL_NAME = "overwrite";
  metadata: ToolMetadata = { sideEffects: true, difficulty: 1 };

  toToolDef() {
    return toolDef(
      OverwriteTool.TOOL_NAME,
      "Writes content to a file, replacing all existing content. Creates parent directories if needed. Use this to create new files or completely replace an existing file.",
      {
        properties: {
          path: param("string", "File path relative to workspace root"),
          content: param("string", "Content to write to the file"),
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
    return `${filePath} overwrite (${lines} lines)`;
  }

  async execute(
    input: string | Record<string, unknown> | null,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const rawArgs = parseToolInput(input);
    if (!rawArgs || !rawArgs.path || rawArgs.content === undefined) {
      return ToolResult.err("Error parsing arguments");
    }

    const args: OverwriteArgs = {
      path: rawArgs.path as string,
      content: rawArgs.content as string,
    };

    const { path: filePath, content } = args;
    const workspace = ctx.get("workspace") as Workspace | null || null;
    const workspaceRoot = ctx.get("workspaceRoot") as string | null || null;

    let resolvedPath: string;
    try {
      if (workspace) {
        resolvedPath = workspace.resolveSafe(filePath);
      } else {
        resolvedPath = path.resolve(workspaceRoot || ".", filePath);
      }
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

    const writeError = await safeWriteFile(resolvedPath, content);
    if (writeError) {
      return writeError;
    }

    return ToolResult.ok(
      JSON.stringify({
        path: filePath,
        filesize_after: Buffer.byteLength(content, "utf-8"),
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

async function safeWriteFile(path: string, content: string): Promise<ToolResult | null> {
  try {
    await fs.writeFile(path, content, "utf-8");
    return null;
  } catch (e: unknown) {
    return ToolResult.err(`Error writing file: ${(e as Error).message}`);
  }
}
