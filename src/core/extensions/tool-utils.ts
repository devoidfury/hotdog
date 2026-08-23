import { ToolError } from "../error.ts";
import { ToolDef, ToolMetadata } from "./tool-registry.ts";
import { toolFormatForName, TOOL_FORMAT_DEFAULT_NAME, type ToolFormatRegistry } from "./tool-format.ts";

export type { ToolMetadata };

/**
 * Resolve the ToolFormat for a seam render. The caller (agent loop / session)
 * passes its own registry and resolved name; there is no process-global
 * state here because the active format depends on per-session model/provider
 * config.
 */
function seamToolFormat(
  toolFormatName: string | undefined,
  registry: ToolFormatRegistry | null | undefined,
): ReturnType<typeof toolFormatForName> {
  return toolFormatForName(toolFormatName ?? TOOL_FORMAT_DEFAULT_NAME, registry);
}

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

  toApiContent(toolName: string, toolFormatName?: string, registry?: ToolFormatRegistry | null): string {
    const status = this.success ? "success" : "failure";
    const tag = this.outputTag || "output";

    const meta: Record<string, unknown> = {};
    if (this.metadata) {
      for (const [key, value] of this.metadata) {
        meta[key] = value;
      }
    }
    if (!this.success && this.error) {
      meta["error"] = this.error;
    }

    // The resolved ToolFormat owns model-facing rendering (the agent loop
    // resolves it per model and passes the name + registry explicitly). The
    // wire serializer is still the only mangle point (tool results are
    // source:"tool").
    const content = seamToolFormat(toolFormatName, registry).formatResult(
      { output: this.output, outputTag: tag, ...meta },
      toolName,
      { status },
    );
    return typeof content === "string" ? content : JSON.stringify(content);
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
  toolFormatName?: string,
  registry?: ToolFormatRegistry | null,
): string {
  if (result instanceof ToolResult) {
    if (toolName) {
      return result.toApiContent(toolName, toolFormatName, registry);
    }
    return result.toDisplay();
  }

  // Non-ToolResult results: delegate to the active ToolFormat. Short metadata
  // keys ride in `meta`; everything else becomes the payload (JSON for objects,
  // matching pre-seam behavior).
  let payload: string;
  const meta: Record<string, string> = {};
  if (typeof result === "string") {
    payload = result;
  } else if (typeof result === "object" && result !== null) {
    const remaining = { ...(result as Record<string, unknown>) };
    for (const key of SHORT_META_KEYS) {
      if (key in remaining) {
        meta[key] = String(remaining[key]);
        delete remaining[key];
      }
    }
    payload = JSON.stringify(remaining);
  } else {
    payload = String(result);
  }

  if (!toolName) {
    return payload;
  }

  const content = seamToolFormat(toolFormatName, registry).formatResult(payload, toolName, { status: "success", ...meta });
  return typeof content === "string" ? content : JSON.stringify(content);
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
  toolFormatName?: string,
  registry?: ToolFormatRegistry | null,
): string {
  if (result && typeof (result as { toApiContent?: (name: string, fmt?: string, reg?: unknown) => string }).toApiContent === "function") {
    return (result as { toApiContent: (name: string, fmt?: string, reg?: unknown) => string }).toApiContent(toolName, toolFormatName, registry);
  }

  const status = success ? "success" : "error";
  const payload = typeof result === "object" && result !== null ? JSON.stringify(result) : String(result);
  const content = seamToolFormat(toolFormatName, registry).formatResult(payload, toolName, { status });
  return typeof content === "string" ? content : JSON.stringify(content);
}
