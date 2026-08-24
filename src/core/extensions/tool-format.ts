// ToolFormat — pluggable model-facing rendering of tool results.
//
// A ToolFormat owns only the *model-facing* content for tool results (and, as
// an optional seam, system-prompt chunks for tool definitions). Human-facing
// rendering stays core-owned (ToolResult.toDisplay()). Formats emit raw text;
// they never mangle -- the wire serializer is the only mangle point.
//
// Selection mirrors WireFormat: provider-level -> model-level fallback chain,
// with a global core-config default ("xml" unless overridden).

import { ToolDef } from "./tool-registry.ts";
import { LlmError } from "../error.ts";
import type { ProviderDef } from "../config/providers.ts";
import { xmlToolFormat } from "./tool-format-xml.ts";

export interface ToolFormat {
  id: string;

  /** Marker names this format introduces; fed into the mangler union. */
  markers: string[];

  /**
   * Model-facing content for a tool result message (string or content parts).
   * `meta` carries at least `{ status }` plus any short metadata entries.
   */
  formatResult(
    result: string | Record<string, unknown>,
    toolName: string,
    meta?: { status: string; [key: string]: string },
  ): string | Array<Record<string, unknown>>;

  /**
   * System-prompt chunk rendering tool definitions; unused by the default path (native `tools` transport is in use).
   */
  renderToolDefs?(toolDefs: ToolDef[]): string;
}

// ── Registry ────────────────────────────────────────────────────────────────

export class ToolFormatRegistry {
  #formats: Map<string, ToolFormat>;

  constructor() {
    this.#formats = new Map();
  }

  register(format: ToolFormat): void {
    if (!format || typeof format.id !== "string" || !format.id) {
      throw new Error("ToolFormat requires a non-empty id");
    }
    this.#formats.set(format.id, format);
  }

  has(id: string): boolean {
    return this.#formats.has(id);
  }

  get(id: string): ToolFormat | undefined {
    return this.#formats.get(id);
  }

  names(): string[] {
    return Array.from(this.#formats.keys());
  }
}

export function createToolFormatRegistry(): ToolFormatRegistry {
  return new ToolFormatRegistry();
}

// ── Format resolution ───────────────────────────────────────────────────────

export const TOOL_FORMAT_DEFAULT_NAME = "xml";

/** Resolve ToolFormat by name from the given registry. */
export function toolFormatForName(name: string, registry?: ToolFormatRegistry | null): ToolFormat {
  const format = registry?.get(name) ?? (name === TOOL_FORMAT_DEFAULT_NAME ? xmlToolFormat : undefined);
  if (!format) {
    throw new LlmError(`Unknown tool format "${name}"`, "config");
  }
  return format;
}

/** Resolve the ToolFormat id for a model. */
export function resolveToolFormatId(
  modelConfig: { name: string; toolFormat?: string },
  providers: ProviderDef[] | undefined,
  globalDefault: string | undefined,
): string {
  const providerName = modelConfig.name.split("/")[0];
  const provider = providers?.find((p) => p.name === providerName);
  return modelConfig.toolFormat ?? provider?.toolFormat ?? globalDefault ?? TOOL_FORMAT_DEFAULT_NAME;
}
