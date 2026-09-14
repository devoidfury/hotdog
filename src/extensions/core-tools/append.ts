import fs from "node:fs/promises";
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
} from "@core/extensions/tool-utils.ts";
import type { ToolMetadata } from "@core/extensions/tool-registry.ts";
import { writeWithinWorkspace } from "@utils/file-utils.ts";
import { ToolContext } from "@core/extensions/types.ts";

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
    return writeWithinWorkspace(input, ctx, {
      writeFn: (path, content) => fs.appendFile(path, content, "utf-8"),
      writeErrorLabel: "Error appending to file",
      resultKey: "bytes_appended",
    });
  }
}
