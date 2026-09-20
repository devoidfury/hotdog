import fs from "node:fs/promises";
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
} from "@core/extensions/tool-utils.ts";
import type { ToolMetadata } from "@core/extensions/tool-registry.ts";
import { writeWithinWorkspace, detectFileStyleAt, applyFileStyle } from "@utils/file-utils.ts";
import { ToolContext } from "@core/extensions/types.ts";

export class OverwriteTool {
  static readonly TOOL_NAME = "overwrite";
  metadata: ToolMetadata = { sideEffects: true, difficulty: 1 };

  toToolDef() {
    return toolDef(
      OverwriteTool.TOOL_NAME,
      "Writes content to a file, replacing all existing content. Creates parent directories if needed. Use this to create new files or completely replace an existing file.",
      {
        properties: {
          path: param("string", "File path. Path relative to the workspace root, or an absolute path inside a configured workspace root."),
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
    return writeWithinWorkspace(input, ctx, {
      writeFn: (path, content) => fs.writeFile(path, content, "utf-8"),
      writeErrorLabel: "Error writing file",
      resultKey: "filesize_after",
      // A rewrite must not silently change the file's line endings or drop
      // its BOM; new files (no style to detect) keep exactly what was given.
      prepareContent: async (path, content) => {
        const style = await detectFileStyleAt(path);
        return style ? applyFileStyle(content, style) : content;
      },
    });
  }
}
