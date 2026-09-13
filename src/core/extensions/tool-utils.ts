import { ToolError } from "../error.ts";
import { ToolDef, ToolMetadata } from "./tool-registry.ts";
import type { ToolResultPart } from "../context/wrappers.ts";

export type { ToolMetadata };

// Format-agnostic builders: they produce a structured ToolResultPart
// (context/wrappers.ts), never markup; the request's WireFormat shapes it at
// the wire, so nothing here takes a format name or registry.

// When set on a ToolResult, tells the run loop to stop after this tool (e.g., "wait", "handoff").
export const TOOL_STOP_LOOP = Symbol("TOOL_STOP_LOOP");

export class ToolResult {
  output: string;
  error: string | null;
  metadata: Map<string, string> | null;
  success: boolean;
  images: unknown[] | null;
  /**
   * Recovery guidance for the model (e.g. "use the find tool to locate the
   * file"). Rides the tool-result part as `hint` and is rendered as the
   * format's hint element, right after the error on failures. The
   * model-facing counterpart of AssistantRetryableError.hint for tools that
   * RETURN errors instead of throwing them.
   */
  hint: string | null;
  [TOOL_STOP_LOOP]?: boolean;

  constructor({
    output = "",
    error = null,
    metadata = null,
    success = true,
    images = null,
    hint = null,
  }: {
    output?: string;
    error?: string | null;
    metadata?: Map<string, string> | null;
    success?: boolean;
    images?: unknown[] | null;
    hint?: string | null;
  } = {}) {
    this.output = output;
    this.error = error;
    this.metadata = metadata;
    this.success = success;
    this.images = images;
    this.hint = hint;
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
    images = null,
    hint = null,
  }: {
    output?: string;
    error?: string | null;
    metadata?: Map<string, string> | null;
    success?: boolean;
    images?: unknown[] | null;
    hint?: string | null;
  } = {}): ToolResult {
    if (error !== null && success !== false) {
      success = false;
    }
    return new ToolResult({
      output,
      error,
      metadata,
      success,
      images,
      hint,
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

  withHint(hint: string): this {
    this.hint = hint;
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
    if (this.hint) {
      parts.push(`HINT: ${this.hint}`);
    }
    return parts.join("\n");
  }

  /**
   * The tool-result wrapper part for this result: structured fields, never
   * markup. The session's WireFormat renders it at the wire (with the tool's
   * fields mangled) and the canonical form renders it at rest; the wrapper's
   * own `output` element name is fixed, so tool code names nothing that
   * reaches the wire.
   */
  toApiContent(toolName: string): ToolResultPart {
    const meta: Array<[string, string]> = [];
    for (const [key, value] of this.metadata ?? []) {
      // On failure the error element is this.error; a tool-authored entry
      // with that key is dropped rather than rendered as (or overwriting) it.
      // On success "error" is metadata like any other key.
      if (!this.success && key === "error") continue;
      meta.push([key, value]);
    }

    return {
      type: "tool-result",
      tool: toolName,
      status: this.success ? "success" : "failure",
      meta,
      error: this.success ? null : this.error,
      hint: this.hint,
      output: this.output,
    };
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

export function toolResult(
  result: ToolResult | string | Record<string, unknown> | unknown,
  toolName?: string,
): string | ToolResultPart {
  if (result instanceof ToolResult) {
    if (toolName) {
      return result.toApiContent(toolName);
    }
    return result.toDisplay();
  }

  // Non-ToolResult results carry no metadata: which keys a format rides on its
  // wrapper tag is the format's business (see extensions/wire-format-xml), so
  // nothing here splits them out. Objects become JSON, matching what a plain
  // return value already does on the executor's formatToolResult path.
  const payload =
    typeof result === "string"
      ? result
      : typeof result === "object" && result !== null
        ? JSON.stringify(result)
        : String(result);

  if (!toolName) {
    return payload;
  }

  return {
    type: "tool-result",
    tool: toolName,
    status: "success",
    meta: [],
    error: null,
    hint: null,
    output: payload,
  };
}

export function truncateOutput(text: string, maxLines: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const truncated = lines.slice(0, maxLines).join("\n");
  return `${truncated}\n--- [truncated, ${lines.length - maxLines} more lines] ---`;
}

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

/**
 * The tool-result part for a raw (non-ToolResult) outcome -- a thrown error,
 * a blocked gate call, a plain value returned by a tool. Failure status is
 * "error" here while `ToolResult.toApiContent()` says "failure": that spelling
 * predates the seam and is kept verbatim so the wire bytes don't drift.
 *
 * @param hint - Recovery guidance carried on the part's hint field (the
 *   thrown-error path in ToolExecutor). Only applies to plain payload
 *   results; a ToolResult instance carries its own hint and wins.
 */
export function formatToolResult(
  result: unknown,
  toolName: string,
  success: boolean,
  hint?: string,
): ToolResultPart {
  // Duck-typed rather than instanceof: hooks hand back result objects, and a
  // structurally compatible one is enough.
  if (result && typeof (result as { toApiContent?: (name: string) => ToolResultPart }).toApiContent === "function") {
    return (result as { toApiContent: (name: string) => ToolResultPart }).toApiContent(toolName);
  }

  const payload = typeof result === "object" && result !== null ? JSON.stringify(result) : String(result);
  return {
    type: "tool-result",
    tool: toolName,
    status: success ? "success" : "error",
    meta: [],
    error: null,
    hint: hint ?? null,
    output: payload,
  };
}
