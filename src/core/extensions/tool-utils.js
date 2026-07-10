// Tool utilities — shared helpers for tool definitions and execution.
//
// Naming: Tool metadata keys use snake_case (total_pages, duration_ms, exit_code)
// for consistency with JSON/persistence format. Short metadata keys become XML
// attributes on the <tool> tag; long keys become child nodes.

import { ToolError } from "../error.js";

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
  "offset",
  "limit",
]);

/**
 * Minimal XML escaping for attribute/text content.
 *
 * @param {string} s - String to escape.
 * @returns {string} Escaped string.
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
  static from({
    output = "",
    error = null,
    metadata = null,
    success = true,
    outputTag = null,
    images = null,
  } = {}) {
    // If an error is provided and success wasn't explicitly set, mark as failure
    if (error !== null && success !== false) {
      success = false;
    }
    return new ToolResult({
      output,
      error,
      metadata,
      success,
      outputTag,
      images,
    });
  }

  /**
   * Add a metadata entry.
   * @param {string} key - Metadata key.
   * @param {*} value - Metadata value (converted to string).
   * @returns {ToolResult} This result for chaining.
   */
  withEntry(key, value) {
    this.metadata = this.metadata || new Map();
    this.metadata.set(key, String(value));
    return this;
  }

  /**
   * Add multiple metadata entries.
   * @param {Object} entries - Object with key-value pairs.
   * @returns {ToolResult} This result for chaining.
   */
  withEntries(entries) {
    this.metadata = this.metadata || new Map();
    for (const [key, value] of Object.entries(entries)) {
      this.metadata.set(key, String(value));
    }
    return this;
  }

  /**
   * Set output XML tag.
   * @param {string|null} tag - Output tag name.
   * @returns {ToolResult} This result for chaining.
   */
  withOutputTag(tag) {
    this.outputTag = tag;
    return this;
  }

  /**
   * Set images.
   * @param {Array|null} images - Array of image objects.
   * @returns {ToolResult} This result for chaining.
   */
  withImages(images) {
    this.images = images;
    return this;
  }

  /**
   * Check if result is successful.
   * @returns {boolean} True if success.
   */
  isOk() {
    return this.success;
  }

  /**
   * Check if result is an error.
   * @returns {boolean} True if error.
   */
  isErr() {
    return !this.success;
  }

  /**
   * Get displayable text (output + error).
   * @returns {string} Display text.
   */
  toDisplay() {
    const parts = this.output ? [this.output] : [];
    if (this.error) {
      parts.push(`Error: ${this.error}`);
    }
    return parts.join("\n");
  }

  /**
   * Get API-serialized content as XML string.
   * @param {string} toolName - Tool name.
   * @returns {string} XML string.
   */
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
 *
 * @param {string} name - Tool name.
 * @param {string} description - Tool description.
 * @param {Object} [parameters] - Parameter schema.
 * @param {Object} [parameters.schema] - JSON Schema.
 * @param {Object} [parameters.properties] - Property definitions.
 * @param {string[]} [parameters.required] - Required property names.
 * @returns {Object} OpenAI-compatible tool definition.
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
 *
 * @param {string} typeName - Parameter type.
 * @param {string} description - Parameter description.
 * @param {Object} [extra] - Additional properties.
 * @returns {Object} Parameter definition.
 */
export function param(typeName, description, extra = {}) {
  return { type: typeName, description: description || "", ...extra };
}

/**
 * Parse tool arguments from JSON input string.
 *
 * @param {string|Object} input - Input argument (string JSON or object).
 * @returns {*} Parsed arguments object or original input if parsing fails.
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
 *
 * @private
 * @param {string} toolName - Tool name.
 * @param {string} status - Status ("success" or "failure").
 * @param {*} content - Content to wrap.
 * @returns {string} XML string.
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
 *
 * @param {string} text - Input text.
 * @param {number} maxLines - Maximum number of lines to keep.
 * @returns {string} Truncated text or original if within limit.
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
 *
 * @param {string|Object|null} input - Input from LLM (JSON string or object).
 * @returns {Object|null} Parsed input object, or null if invalid.
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
 *
 * @param {string|Object|null} input - Tool input from LLM.
 * @param {Function} templateFn - Function to format the display.
 * @param {string|Function|Object} options - Options for display formatting.
 * @returns {string} Formatted display string.
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
 *
 * @param {string} oldText - Original text.
 * @param {string} newText - New text.
 * @param {number} [maxLines=80] - Maximum number of diff lines to return.
 * @returns {string} Unified diff string.
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
 * Extract a required string from a JSON value.
 *
 * @param {Object} value - JSON value object.
 * @param {string} key - Key to extract.
 * @returns {string} Extracted string value.
 * @throws {ToolError} If key is missing or not a string.
 */
export function getRequiredStr(value, key) {
  const v = value?.[key];
  if (typeof v !== "string") {
    throw ToolError.MissingArg(key);
  }
  return v;
}

/**
 * Format a tool result for the LLM API.
 * Handles ToolResult instances, strings, objects, and primitives.
 * ToolResult objects use their own toApiContent() method.
 * Everything else is wrapped in <tool> XML tags.
 *
 * @param {*} result - The tool execution result.
 * @param {string} toolName - The tool name.
 * @param {boolean} success - Whether the tool executed successfully.
 * @returns {string} Formatted result string.
 */
export function formatToolResult(result, toolName, success) {
  // If the result has a toApiContent method, use it (ToolResult)
  if (result && typeof result.toApiContent === "function") {
    return result.toApiContent(toolName);
  }

  const status = success ? "success" : "error";

  // String: wrap in XML
  if (typeof result === "string") {
    return `<tool name="${toolName}" status="${status}">\n  <output>${xmlEscape(result)}</output>\n</tool>`;
  }

  // Object: serialize and wrap
  if (typeof result === "object" && result !== null) {
    const json = JSON.stringify(result);
    return `<tool name="${toolName}" status="${status}">\n  <output>${xmlEscape(json)}</output>\n</tool>`;
  }

  // Primitive: convert to string and wrap
  const str = String(result);
  return `<tool name="${toolName}" status="${status}">\n  <output>${xmlEscape(str)}</output>\n</tool>`;
}
