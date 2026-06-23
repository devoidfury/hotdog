// Tool utilities — shared helpers for tool definitions and execution.
//
// Naming: Tool metadata keys use snake_case (total_pages, duration_ms, exit_code)
// for consistency with JSON/persistence format. Short metadata keys become XML
// attributes on the <tool> tag; long keys become child nodes.

import fsPromises from "node:fs/promises";
import path from "node:path";

/**
 * Metadata keys rendered as XML attributes on the root <tool> tag.
 * Everything else becomes a child node.
 */
const SHORT_META_KEYS = new Set([
  "truncated",
  "page",
  "total_pages",
  "total_lines",
  "showing",
  "duration_ms",
  "timeout",
  "exit_code",
  "path",
  "pattern",
]);

/**
 * Minimal XML escaping for attribute/text content.
 */
export function xmlEscape(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Tool result — structured result for tool execution.
 * Supports success/failure status, metadata, and XML serialization for API output.
 */
export class ToolResult {
  constructor({
    output = "",
    error = null,
    metadata = null,
    success = true,
    outputTag = null,
    images = null,
  } = {}) {
    this.output = output;
    this.error = error;
    this.metadata = metadata;
    this.success = success;
    this.outputTag = outputTag;
    this.images = images;
  }

  static ok(output) {
    return new ToolResult({ output, success: true });
  }

  static err(message) {
    return new ToolResult({
      output: "",
      error: String(message),
      success: false,
    });
  }

  /**
   * Build a ToolResult from an options object.
   * Convenience factory for tools that construct results from scratch.
   *
   * @param {Object} opts
   * @param {string} [opts.output=""] — Output text.
   * @param {string|null} [opts.error=null] — Error message (sets success to false).
   * @param {Map|Object|null} [opts.metadata=null] — Metadata entries.
   * @param {boolean} [opts.success=true] — Override success flag.
   * @param {string|null} [opts.outputTag=null] — Custom XML tag for output.
   * @param {Array|null} [opts.images=null] — Image attachments.
   * @returns {ToolResult}
   */
  static from({ output = "", error = null, metadata = null, success = true, outputTag = null, images = null } = {}) {
    // If an error is provided and success wasn't explicitly set, mark as failure
    if (error !== null && success !== false) {
      success = false;
    }
    return new ToolResult({ output, error, metadata, success, outputTag, images });
  }

  withEntry(key, value) {
    this.metadata = this.metadata || new Map();
    this.metadata.set(key, String(value));
    return this;
  }

  withEntries(entries) {
    this.metadata = this.metadata || new Map();
    for (const [key, value] of Object.entries(entries)) {
      this.metadata.set(key, String(value));
    }
    return this;
  }

  withOutputTag(tag) {
    this.outputTag = tag;
    return this;
  }

  withImages(images) {
    this.images = images;
    return this;
  }

  isOk() {
    return this.success;
  }

  isErr() {
    return !this.success;
  }

  toDisplay() {
    const parts = this.output ? [this.output] : [];
    if (this.error) {
      parts.push(`Error: ${this.error}`);
    }
    return parts.join("\n");
  }

  toApiContent(toolName) {
    const status = this.success ? "success" : "failure";
    const tag = this.outputTag || "output";

    const attrs = [`name="${xmlEscape(toolName)}"`, `status="${status}"`];
    const longMeta = [];

    if (this.metadata) {
      for (const [key, value] of this.metadata) {
        if (SHORT_META_KEYS.has(key)) {
          attrs.push(`${xmlEscape(key)}="${xmlEscape(value)}"`);
        } else {
          longMeta.push(`  <${xmlEscape(key)}>${value}</${xmlEscape(key)}>`);
        }
      }
    }

    if (!this.success && this.error) {
      longMeta.unshift(`  <error>${this.error}</error>`);
    }

    const outputNode = `  <${tag}>${this.output}</${tag}>`;

    const parts = [`<tool ${attrs.join(" ")}>`];
    parts.push(...longMeta);
    parts.push(outputNode);
    parts.push("</tool>");

    return parts.join("\n");
  }
}

/**
 * Tool definition (OpenAI function-calling schema).
 */
export function toolDef(name, description, parameters) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        ...(parameters?.schema ? { schema: parameters.schema } : {}),
        type: "object",
        properties: parameters?.properties || {},
        required: parameters?.required || [],
      },
    },
  };
}

/**
 * Create a parameter definition.
 */
export function param(typeName, description, extra = {}) {
  return { type: typeName, description: description || "", ...extra };
}

/**
 * Parse tool arguments from JSON input string.
 */
export function parseToolArgs(input) {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return { input };
    }
  }
  return input;
}

/**
 * Resolve a tool result string.
 */
export function toolResult(result, toolName) {
  if (result instanceof ToolResult) {
    if (toolName) {
      return result.toApiContent(toolName);
    }
    return result.toDisplay();
  }
  if (typeof result === "string") {
    if (toolName) {
      return xmlWrap(toolName, "success", result);
    }
    return result;
  }
  if (typeof result === "object" && result !== null) {
    if (toolName) {
      return xmlWrap(toolName, "success", result);
    }
    return JSON.stringify(result);
  }
  const str = String(result);
  if (toolName) {
    return xmlWrap(toolName, "success", str);
  }
  return str;
}

/**
 * Wrap content in XML tool tags for API output.
 */
function xmlWrap(toolName, status, content) {
  const attrs = [`name="${xmlEscape(toolName)}"`, `status="${status}"`];

  let outputContent = content;
  if (typeof content === "object" && content !== null) {
    const shortMeta = [];
    const remaining = { ...content };
    for (const key of SHORT_META_KEYS) {
      if (key in remaining) {
        shortMeta.push(
          `${xmlEscape(key)}="${xmlEscape(String(remaining[key]))}"`,
        );
        delete remaining[key];
      }
    }
    if (shortMeta.length > 0) {
      attrs.push(...shortMeta);
    }
    outputContent = JSON.stringify(remaining);
  }

  const attrsStr = attrs.join(" ");
  return `<tool ${attrsStr}>\n  <output>${outputContent}</output>\n</tool>`;
}

/**
 * Truncate output to max lines.
 */
export function truncateOutput(text, maxLines) {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const truncated = lines.slice(0, maxLines).join("\n");
  return `${truncated}\n--- [truncated, ${lines.length - maxLines} more lines] ---`;
}

/**
 * Parse and validate tool input from the LLM.
 */
export function parseToolInput(input) {
  if (!input || (typeof input === "string" && input.trim().length === 0)) {
    return null;
  }

  let json;
  if (typeof input === "string") {
    try {
      json = JSON.parse(input);
    } catch {
      return null;
    }
  } else {
    json = input;
  }

  return json;
}

/**
 * Default callDisplay implementation.
 */
export function defaultCallDisplay(input, templateFn, options) {
  let fallback,
    returnRawOnParseError = false;
  if (typeof options === "string") {
    fallback = options;
  } else if (typeof options === "function") {
    fallback = options;
  } else if (typeof options === "object" && options !== null) {
    fallback = options.fallback;
    returnRawOnParseError = options.returnRawOnParseError === true;
  }

  if (!input || (typeof input === "string" && input.trim().length === 0)) {
    return typeof fallback === "function"
      ? fallback(input)
      : (fallback ?? (typeof input === "string" ? input : ""));
  }

  const args = parseToolInput(input);
  if (!args) {
    if (returnRawOnParseError) {
      return typeof input === "string" ? input : "";
    }
    return typeof fallback === "function"
      ? fallback(input)
      : (fallback ?? (typeof input === "string" ? input : ""));
  }
  return templateFn(args);
}

/**
 * Generate a simple unified diff between old and new text.
 */
export function generateDiff(oldText, newText, maxLines = 80) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const diff = [];

  let oldIdx = 0,
    newIdx = 0;
  while (oldIdx < oldLines.length && newIdx < newLines.length) {
    if (oldLines[oldIdx] === newLines[newIdx]) {
      oldIdx++;
      newIdx++;
    } else {
      diff.push(`- ${oldLines[oldIdx]}`);
      diff.push(`+ ${newLines[newIdx]}`);
      oldIdx++;
      newIdx++;
      if (diff.length > maxLines * 2) break;
    }
  }

  while (oldIdx < oldLines.length) {
    diff.push(`- ${oldLines[oldIdx]}`);
    oldIdx++;
  }
  while (newIdx < newLines.length) {
    diff.push(`+ ${newLines[newIdx]}`);
    newIdx++;
  }

  return diff.join("\n");
}

/**
 * Write a file, creating parent directories as needed.
 */
export async function writeFileWithParents(filePath, content) {
  const parentDir = path.dirname(filePath);
  if (parentDir && parentDir !== ".") {
    await fsPromises.mkdir(parentDir, { recursive: true });
  }
  await fsPromises.writeFile(filePath, content);
}

/**
 * Validate that a path is within the cwd boundary.
 */
export function validateCwdBoundary(filePath, cwdBoundary) {
  if (!cwdBoundary) return null;
  const boundaryResolved = path.resolve(cwdBoundary);
  const fileResolved = path.resolve(filePath);
  if (
    !fileResolved.startsWith(boundaryResolved + path.sep) &&
    fileResolved !== boundaryResolved
  ) {
    return `Error: path ${filePath} is outside cwd boundary ${cwdBoundary}`;
  }
  return null;
}

/**
 * Resolve a path against cwdBoundary or workspaceRoot.
 */
export function resolvePath(filePath, cwdBoundary, workspaceRoot) {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  if (cwdBoundary) {
    return path.resolve(cwdBoundary, filePath);
  }
  if (workspaceRoot) {
    return path.resolve(workspaceRoot, filePath);
  }
  return path.resolve(filePath);
}

/**
 * Resolve a path and verify it stays within the cwd boundary.
 */
export async function resolvePathAndValidate(requested, cwdBoundary = null) {
  const resolved = path.resolve(requested);

  try {
    await fsPromises.access(resolved);
  } catch {
    throw new Error(`Path not found: ${requested}`);
  }

  if (cwdBoundary) {
    const boundaryResolved = path.resolve(cwdBoundary);
    if (
      !resolved.startsWith(boundaryResolved + path.sep) &&
      resolved !== boundaryResolved
    ) {
      throw new Error(
        `Path '${requested}' is outside the allowed directory '${cwdBoundary}'. ` +
          "File operations are restricted to the boundary directory.",
      );
    }
  }

  return resolved;
}

/**
 * Get file size in bytes.
 */
export async function fileSize(filePath) {
  const stats = await fsPromises.stat(filePath);
  return stats.size;
}

/**
 * Check if a path is writable.
 */
export async function checkWritable(filePath) {
  const parentDir = path.dirname(filePath);

  if (parentDir && parentDir !== ".") {
    const tempPath = path.join(parentDir, ".oa-agent-permission-test");
    try {
      await fsPromises.writeFile(tempPath, "");
      await fsPromises.unlink(tempPath);
    } catch (e) {
      throw new Error(`Directory '${parentDir}' is not writable: ${e.message}`);
    }
  }

  try {
    await fsPromises.access(filePath, fsPromises.constants.W_OK);
  } catch {
    // File doesn't exist — that's OK, we can create it
  }

  return true;
}

/**
 * Check if a path is readable.
 */
export async function checkReadable(filePath) {
  try {
    await fsPromises.access(filePath, fsPromises.constants.R_OK);
  } catch {
    throw new Error(`Path '${filePath}' does not exist or is not readable`);
  }
  return true;
}

/**
 * Extract a required string from a JSON value.
 */
export function getRequiredStr(value, key) {
  const v = value?.[key];
  if (typeof v !== "string") {
    throw new Error(`Missing required argument: ${key}`);
  }
  return v;
}

