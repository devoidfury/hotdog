import fs from "node:fs/promises";
import {
  toolDef,
  param,
  ToolResult,
} from "@core/extensions/tool-utils.ts";
import type { ToolMetadata } from "@core/extensions/tool-registry.ts";
import { writeWithinWorkspace, detectFileStyleAt, applyFileStyle } from "@utils/file-utils.ts";
import { ToolContext } from "@core/extensions/types.ts";

export class OverwriteTool {
  static readonly TOOL_NAME = "overwrite";
  // Same posture as append (the written `content` renders at call time as
  // pure adds, `path` names the header, the `filesize_after` envelope never
  // competes for the face) with one truth append cannot claim: a rewrite
  // replaces the whole file, so the written text IS lines 1..N -- the add
  // rail numbers from `addStart: 1`. Keys pinned against toToolDef() in
  // tests/extensions/tools-index.test.ts.
  metadata: ToolMetadata = {
    sideEffects: true,
    difficulty: 1,
    display: [{ kind: "diff", source: "args", arg: "content", pathArg: "path", addStart: 1 }],
  };

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
