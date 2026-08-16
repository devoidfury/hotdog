import { ToolError } from "../error.ts";
import { ToolDef, ToolMetadata } from "./tool-registry.ts";

export type { ToolMetadata };

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

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// When set on a ToolResult, tells the run loop to stop after this tool (e.g., "wait", "handoff").
export const TOOL_STOP_LOOP = Symbol("TOOL_STOP_LOOP");

export class ToolResult {
  output: string;
  error: string | null;
  metadata: Map<string, string> | null;
  success: boolean;
  outputTag: string | null;
  images: unknown[] | null;
  [TOOL_STOP_LOOP]?: boolean;

  constructor({
    output = "",
    error = null,
    metadata = null,
    success = true,
    outputTag = null,
    images = null,
  }: {
    output?: string;
    error?: string | null;
    metadata?: Map<string, string> | null;
    success?: boolean;
    outputTag?: string | null;
    images?: unknown[] | null;
  } = {}) {
    this.output = output;
    this.error = error;
    this.metadata = metadata;
    this.success = success;
    this.outputTag = outputTag;
    this.images = images;
  }

  static ok(output: string): ToolResult {
    return new ToolResult({ output, success: true });
  }

  static err(message: string | unknown): ToolResult {
    return new ToolResult({
      output: "",
      error: String(message),
      success: false,
    });
  }

  static stop(output: string): ToolResult {
    const result = new ToolResult({ output, success: true });
    result[TOOL_STOP_LOOP] = true;
    return result;
  }

  static from({
    output = "",
    error = null,
    metadata = null,
    success = true,
    outputTag = null,
    images = null,
  }: {
    output?: string;
    error?: string | null;
    metadata?: Map<string, string> | null;
    success?: boolean;
    outputTag?: string | null;
    images?: unknown[] | null;
  } = {}): ToolResult {
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

  withEntry(key: string, value: unknown): this {
    this.metadata = this.metadata || new Map();
    this.metadata.set(key, String(value));
    return this;
  }

  withEntries(entries: Record<string, unknown>): this {
    this.metadata = this.metadata || new Map();
    for (const [key, value] of Object.entries(entries)) {
      this.metadata.set(key, String(value));
    }
    return this;
  }

  withOutputTag(tag: string | null): this {
    this.outputTag = tag;
    return this;
  }

  withImages(images: unknown[] | null): this {
    this.images = images;
    return this;
  }

  withStopLoop(): this {
    this[TOOL_STOP_LOOP] = true;
    return this;
  }

  isOk(): boolean {
    return this.success;
  }

  isErr(): boolean {
    return !this.success;
  }

  toDisplay(): string {
    const parts: string[] = this.output ? [this.output] : [];
    if (this.error) {
      parts.push(`Error: ${this.error}`);
    }
    return parts.join("\n");
  }

  toApiContent(toolName: string): string {
    const status = this.success ? "success" : "failure";
    const tag = this.outputTag || "output";

    const attrs: string[] = [`name="${xmlEscape(toolName)}"`, `status="${status}"`];
    const longMeta: string[] = [];

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

    const parts: string[] = [`<tool ${attrs.join(" ")}>`];
    parts.push(...longMeta);
    parts.push(outputNode);
    parts.push("</tool>");

    return parts.join("\n");
  }
}

export function toolDef(
  name: string,
  description: string,
  parameters?: {
    properties?: Record<string, unknown>;
    required?: string[];
  },
): ToolDef {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: parameters?.properties || {},
        required: parameters?.required || [],
      },
    },
  };
}

export function param(
  typeName: string,
  description: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: typeName, description: description || "", ...extra };
}

export function parseToolArgs(
  input: string | Record<string, unknown>,
): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return { input };
    }
  }
  return input;
}

export function toolResult(
  result: ToolResult | string | Record<string, unknown> | unknown,
  toolName?: string,
): string {
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
      return xmlWrap(toolName, "success", result as Record<string, unknown>);
    }
    return JSON.stringify(result);
  }
  const str = String(result);
  if (toolName) {
    return xmlWrap(toolName, "success", str);
  }
  return str;
}

function xmlWrap(
  toolName: string,
  status: string,
  content: string | Record<string, unknown>,
): string {
  const attrs: string[] = [`name="${xmlEscape(toolName)}"`, `status="${status}"`];

  let outputContent: string = content as string;
  if (typeof content === "object" && content !== null) {
    const shortMeta: string[] = [];
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

export function truncateOutput(text: string, maxLines: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const truncated = lines.slice(0, maxLines).join("\n");
  return `${truncated}\n--- [truncated, ${lines.length - maxLines} more lines] ---`;
}

/** Parse tool input from the LLM. */
export function parseToolInput(
  input: string | Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!input || (typeof input === "string" && input.trim().length === 0)) {
    return null;
  }

  let json: unknown;
  if (typeof input === "string") {
    try {
      json = JSON.parse(input);
    } catch {
      return null;
    }
  } else {
    json = input;
  }

  return json as Record<string, unknown>;
}

export function defaultCallDisplay(
  input: string | Record<string, unknown> | null,
  templateFn: (args: Record<string, unknown>) => string,
  options?:
    | string
    | ((input: string | Record<string, unknown> | null) => string)
    | { fallback?: string | ((input: string | Record<string, unknown> | null) => string); returnRawOnParseError?: boolean }
    | undefined,
): string {
  let fallback: string | ((input: string | Record<string, unknown> | null) => string) | undefined;
  let returnRawOnParseError = false;
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
      : ((fallback as string) ?? (typeof input === "string" ? input : ""));
  }
  return templateFn(args);
}

export function generateDiff(
  oldText: string,
  newText: string,
  maxLines = 80,
): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const diff: string[] = [];

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

export function getRequiredStr(
  value: Record<string, unknown>,
  key: string,
): string {
  const v = value?.[key];
  if (typeof v !== "string") {
    throw ToolError.MissingArg(key);
  }
  return v;
}

export function formatToolResult(
  result: unknown,
  toolName: string,
  success: boolean,
): string {
  if (result && typeof (result as { toApiContent?: (name: string) => string }).toApiContent === "function") {
    return (result as { toApiContent: (name: string) => string }).toApiContent(toolName);
  }

  const status = success ? "success" : "error";

  if (typeof result === "string") {
    return `<tool name="${toolName}" status="${status}">\n  <output>${xmlEscape(result)}</output>\n</tool>`;
  }

  if (typeof result === "object" && result !== null) {
    const json = JSON.stringify(result);
    return `<tool name="${toolName}" status="${status}">\n  <output>${xmlEscape(json)}</output>\n</tool>`;
  }

  const str = String(result);
  return `<tool name="${toolName}" status="${status}">\n  <output>${xmlEscape(str)}</output>\n</tool>`;
}
