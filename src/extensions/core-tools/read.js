// Read tool — read content from a file.
// Supports text files (line-based) and image files (jpeg, png, webp, base64).

import fs from "node:fs/promises";
import path from "node:path";
import extensionData from "./extension.json";
import {
  toolDef,
  param,
  ToolResult,
  toolResult,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.js";
import { validateCwdBoundary, resolvePath, correctCommonPathMistakes } from "../../utils/file-utils.js";
import { DEFAULT_MAX_IMAGE_SIZE } from "./defaults.js";

/**
 * Supported image extensions mapped to MIME types.
 */
const IMAGE_EXTENSIONS = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".base64": "application/octet-stream",
};

export class ReadTool {
  static TOOL_NAME = "read";

  constructor(options = {}) {
    this.readLimit =
      options.readLimit ??
      extensionData.configSchema.coreTools.properties.readToolLimit.default;
    this.maxImageSize = options.maxImageSize ?? DEFAULT_MAX_IMAGE_SIZE;
  }

  toToolDef() {
    return toolDef(
      ReadTool.TOOL_NAME,
      `Read a file's contents with optional pagination. Supports text files (line-based extraction with offset/limit) and image files (jpeg, png, webp, base64). Returns an error for directories with a depth-1 listing instead.`,
      {
        schema: "https://json-schema.org/draft/2020-12/schema",
        properties: {
          path: param(
            "string",
            "Path to the file to read (relative to workspace root)",
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

  callDisplay(input) {
    return defaultCallDisplay(input, (args) => {
      const { path: filePath, limit, offset } = args;
      if (!filePath) {
        return typeof input === "string" ? input : "(no path)";
      }
      const end = offset + limit;
      return `${filePath} (lines ${offset}-${end})`;
    }, typeof input === "string" ? input : "(no path)");
  }

  async execute(input, ctx) {
    const args = parseArgs(input, this.readLimit);
    if (!args) {
      return ToolResult.err("Error parsing arguments");
    }

    const { path: filePath, limit, offset } = args;
    if (!filePath) {
      return ToolResult.err("path is required");
    }

    const cwdBoundary = ctx?.get('cwdBoundary') || null;
    const workspaceRoot = ctx?.get('workspaceRoot') || null;

    // Resolve path: cwdBoundary takes precedence, falls back to workspaceRoot
    const resolvedPath = resolvePath(filePath, cwdBoundary, workspaceRoot);

    // Validate cwd boundary
    const boundaryError = validateCwdBoundary(resolvedPath, cwdBoundary);
    if (boundaryError) {
      return ToolResult.err(boundaryError);
    }

    const resolved = resolvedPath;

    // Check if it's a directory
    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        const listing = await listDirectoryDepth1(resolved);
        return ToolResult.ok(
          `'${filePath}' is a directory. Here's a depth-1 listing:\n${listing}`,
        ).withEntries({
          path: resolved,
          type: "directory",
        });
      }
    } catch (e) {
      // stat failed — continue to file-not-found handling below
    }

    // Check if file exists
    try {
      await fs.access(resolved);
    } catch {
      return ToolResult.err(`File not found: ${filePath}`);
    }

    // Check if it's an image file
    const mimeType = getImageMimeType(resolved);
    if (mimeType) {
      return await readImage(resolved, mimeType, filePath, this.maxImageSize);
    }

    return await readLines(resolved, offset, limit);
  }
}

/**
 * Parse and validate read tool arguments.
 */
function parseArgs(input, defaultLimit) {
  // Empty input → defaults
  if (!input || (typeof input === "string" && input.trim().length === 0)) {
    return {
      path: null,
      limit: defaultLimit,
      offset: 0,
    };
  }

  const json = parseToolInput(input);
  if (!json) {
    return null; // Invalid JSON — error
  }

  let filePath = json.path;
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

/**
 * Read file by lines with offset/limit pagination.
 */
async function readLines(filePath, offset, limit) {
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
  } catch (e) {
    return ToolResult.err(`Failed to read file: ${e.message}`);
  }
}

/**
 * List directory contents at depth 1, sorted.
 */
async function listDirectoryDepth1(dirPath) {
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

/**
 * Get MIME type for image files based on extension.
 * Returns null if not a recognized image extension.
 */
function getImageMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS[ext] ?? null;
}

/**
 * Read an image file and return it as a ToolResult with images.
 */
async function readImage(filePath, mimeType, originalPath, maxImageSize) {
  try {
    // Check file size
    const stats = await fs.stat(filePath);
    if (stats.size > maxImageSize) {
      return ToolResult.err(
        `Image file too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB (max ${maxImageSize / 1024 / 1024}MB)`,
      );
    }

    // Read file as binary and convert to base64
    const buffer = await fs.readFile(filePath);
    const base64 = buffer.toString("base64");

    // For .base64 files, the content is already base64 text — read as text
    let data;
    if (mimeType === "application/octet-stream") {
      const text = (await fs.readFile(filePath, "utf-8")).trim();
      data = text;
    } else {
      data = base64;
    }

    const size = stats.size;
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
  } catch (e) {
    return ToolResult.err(`Failed to read image: ${e.message}`);
  }
}
