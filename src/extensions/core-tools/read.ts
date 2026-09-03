import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";
import type { ToolMetadata } from "../../core/extensions/tool-registry.ts";
import { correctCommonPathMistakes } from "../../utils/file-utils.ts";
import { PathEscapeError } from "../../utils/workspace.ts";
import type { Workspace } from "../../utils/workspace.ts";
import { AssistantRetryableError } from "../../core/error.ts";
import { DEFAULT_MAX_IMAGE_SIZE } from "./defaults.ts";
import { ToolContext } from "../../core/extensions/types.ts";

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".base64": "application/octet-stream",
};

interface ReadToolOptions {
  readLimit: number;
  maxImageSize?: number;
}


interface ReadArgs {
  path: string | null;
  limit: number;
  offset: number;
}

export class ReadTool {
  static readonly TOOL_NAME = "read";
  metadata: ToolMetadata = { sideEffects: false, difficulty: 1 };

  private readonly readLimit: number;
  private readonly maxImageSize: number;

  constructor(options: ReadToolOptions) {

    this.readLimit = options.readLimit;
    this.maxImageSize = options.maxImageSize ?? DEFAULT_MAX_IMAGE_SIZE;
  }

  toToolDef() {
    return toolDef(
      ReadTool.TOOL_NAME,
      `Read a file's contents with optional pagination. Supports text files (line-based extraction with offset/limit) and image files (jpeg, png, webp, base64). For directories, returns an error with a depth-1 listing.`,
      {
        properties: {
          path: param(
            "string",
            "Path to the file to read. Path relative to the workspace root, or an absolute path inside a configured workspace root.",
          ),
          limit: param("integer", `Maximum number of lines to return`, {
            minimum: 1,
            default: this.readLimit,
          }),
          offset: param("integer", "Number of lines to skip", {
            minimum: 0,
            default: 0,
          }),
        },
        required: ["path"],
      },
    );
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(input, (args: Record<string, unknown>) => {
      const filePath = args.path as string;
      const limit = args.limit as number;
      const offset = args.offset as number;
      if (!filePath) {
        return typeof input === "string" ? input : "(no path)";
      }
      const end = offset + limit;
      return `${filePath} (lines ${offset}-${end})`;
    }, typeof input === "string" ? input : "(no path)");
  }

  async execute(input: string | Record<string, unknown> | null, ctx: ToolContext): Promise<ToolResult> {
    const args = parseArgs(input, this.readLimit);
    if (!args) {
      return ToolResult.err(
        "Error parsing arguments: expected a JSON object with a required 'path' string (optional: limit, offset)",
      );
    }

    const filePath = args.path;
    const limit = args.limit;
    const offset = args.offset;

    if (!filePath) {
      return ToolResult.err("path is required");
    }

    const workspace = ctx.get("workspace") as Workspace;

    let resolved: string;
    try {
      resolved = workspace.resolveSafe(filePath);
    } catch (e: unknown) {
      if (e instanceof PathEscapeError) {
        return ToolResult.err(e.message);
      }
      return ToolResult.err(`Error resolving path: ${(e as Error).message}`);
    }

    let stat: Stats | null = null;
    try {
      stat = await fs.stat(resolved);
    } catch {
      // stat failed — fall through to file-not-found handling below
    }

    if (stat?.isDirectory()) {
      const listing = await listDirectoryDepth1(resolved);
      return ToolResult.ok(
        `'${filePath}' is a directory. Here's a depth-1 listing:\n${listing}`,
      ).withEntries({
        path: resolved,
        type: "directory",
      });
    }

    try {
      await fs.access(resolved);
    } catch {
      throw AssistantRetryableError.WithHint(
        `File not found: ${filePath}`,
        "Check the path is correct. Maybe try reading the containing directory to list contents.",
      );
    }

    const mimeType = getImageMimeType(resolved);
    if (mimeType) {
      // Size comes from the stat above; if that stat raced and missed, 0
      // just skips the size check and the read below decides.
      return await readImage(resolved, mimeType, filePath, this.maxImageSize, stat?.size ?? 0);
    }

    return await readLines(resolved, offset, limit);
  }
}

function parseArgs(input: string | Record<string, unknown> | null, defaultLimit: number): ReadArgs | null {
  if (!input || (typeof input === "string" && input.trim().length === 0)) {
    return {
      path: null,
      limit: defaultLimit,
      offset: 0,
    };
  }

  const json = parseToolInput(input);
  if (!json) {
    return null; // null signals a parse failure
  }

  let filePath = json.path as string | undefined;
  if (!filePath || typeof filePath !== "string") {
    return null;
  }

  const limit =
    typeof json.limit === "number" && json.limit >= 1
      ? json.limit
      : defaultLimit;
  const offset =
    typeof json.offset === "number" && json.offset >= 0 ? json.offset : 0;

  [filePath] = correctCommonPathMistakes(filePath);

  return { path: filePath, limit, offset };
}

async function readLines(filePath: string, offset: number, limit: number): Promise<ToolResult> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const totalLines = lines.length;

    if (offset >= totalLines) {
      return ToolResult.ok(
        `File has ${totalLines} lines, offset ${offset} is beyond end.\n[empty]`,
      ).withEntries({
        path: filePath,
        total_lines: String(totalLines),
        offset: String(offset),
        limit: String(limit),
      });
    }

    const end = Math.min(offset + limit, totalLines);
    const selected = lines.slice(offset, end);
    const result = selected.length === 0 ? "[empty]" : selected.join("\n");

    return ToolResult.ok(result).withEntries({
      path: filePath,
      total_lines: String(totalLines),
      offset: String(offset),
      limit: String(limit),
      showing: `${offset + 1}-${end} (of ${totalLines} total)`,
    });
  } catch (e: unknown) {
    return ToolResult.err(`Failed to read file: ${(e as Error).message}`);
  }
}

async function listDirectoryDepth1(dirPath: string): Promise<string> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const sorted = entries
      .map((entry) => {
        const suffix = entry.isDirectory() ? "/" : "";
        return `  ${entry.name}${suffix}`;
      })
      .sort();
    return sorted.join("\n");
  } catch {
    return "  (unable to read directory)";
  }
}

function getImageMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS[ext] ?? null;
}

async function readImage(filePath: string, mimeType: string, originalPath: string, maxImageSize: number, size: number): Promise<ToolResult> {
  try {
    if (size > maxImageSize) {
      return ToolResult.err(
        `Image file too large: ${(size / 1024 / 1024).toFixed(1)}MB (max ${maxImageSize / 1024 / 1024}MB)`,
      );
    }

    // Single read: binary images are base64-encoded; .base64 files are
    // already base64 text.
    const buffer = await fs.readFile(filePath);
    const data =
      mimeType === "application/octet-stream"
        ? buffer.toString("utf-8").trim()
        : buffer.toString("base64");

    const image = { type: "image_url", mimeType, data };

    return ToolResult.ok(
      `Image: ${originalPath} (${mimeType}, ${(size / 1024).toFixed(1)}KB)`,
    )
      .withImages([image])
      .withEntries({
        path: filePath,
        mime_type: mimeType,
        size: String(size),
      });
  } catch (e: unknown) {
    return ToolResult.err(`Failed to read image: ${(e as Error).message}`);
  }
}
