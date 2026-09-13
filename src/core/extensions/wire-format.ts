// WireFormat — the session's presentation protocol for harness structure.
//
// A WireFormat owns the model-facing SHAPE of every harness wrapper the
// conversation carries: tool results, attached-file includes, system
// notices. One format per session keeps the harness markers following
// one consistent internal logic -- a model that learns to parse this
// session's framing sees the same vocabulary everywhere in it.
//
// It renders a structured wrapper part (context/wrappers.ts) to text and is
// handed PRE-MANGLED fields: core fixes field trust per wrapper type and the
// wire serializer applies it before the format is called
// (renderWrapperForWire in context/wrappers.ts), so a format physically
// cannot emit an unescaped payload and never touches the mangler itself.
// Formats return TEXT; a format that returned content parts would own the
// message, not the shape. Human-facing rendering stays consumer-owned.
//
// CORE HOLDS NO IMPLEMENTATION. Shapes come from extensions; the built-in
// one is the autoloaded `extensions/wire-format-xml`, registered under the
// name the global `modelWireFormat` default carries (core.config.json).
// Selection mirrors the protocol/role-mapping seams: model-level ->
// provider-level -> global default. A configured name nothing registers is a
// config error at request build (LlmClient.#requestWireFormat); with no name
// resolved at all, a wrapper part meeting the wire throws instead of silently
// falling back to a core-invented shape.

import type { ProviderDef } from "../config/providers.ts";
import type { FileIncludePart, SystemNoticePart, ToolResultPart } from "../context/wrappers.ts";

export interface WireFormat {
  id: string;

  /** Marker names this format introduces; fed into the mangler union. */
  markers: string[];

  /** The tool-result wrapper: framing around one tool's (pre-mangled) output. */
  renderToolResult(part: ToolResultPart): string;

  /** The file-include wrapper: framing around (pre-mangled) file data. */
  renderFileInclude(part: FileIncludePart): string;

  /** The system-notice wrapper: harness-generated text, verbatim by trust spec. */
  renderSystemNotice(part: SystemNoticePart): string;
}

// ── Registry ────────────────────────────────────────────────────────────────

export class WireFormatRegistry {
  #formats: Map<string, WireFormat>;

  constructor() {
    this.#formats = new Map();
  }

  register(format: WireFormat): void {
    if (!format || typeof format.id !== "string" || !format.id) {
      throw new Error("WireFormat requires a non-empty id");
    }
    this.#formats.set(format.id, format);
  }

  has(id: string): boolean {
    return this.#formats.has(id);
  }

  get(id: string): WireFormat | undefined {
    return this.#formats.get(id);
  }

  names(): string[] {
    return Array.from(this.#formats.keys());
  }
}

export function createWireFormatRegistry(): WireFormatRegistry {
  return new WireFormatRegistry();
}

// ── Format resolution ───────────────────────────────────────────────────────

/**
 * Resolve the WireFormat id for a model (model -> provider -> global default).
 * `undefined` when nothing is configured: there is no core default to fall
 * back to, so the caller fails (see LlmClient.resolveWireFormat). The global
 * default is the resolved `modelWireFormat` config value -- core.config.json
 * supplies "xml", and the extension of that name registers the shape.
 */
export function resolveWireFormatId(
  modelConfig: { name: string; wireFormat?: string },
  providers: ProviderDef[] | undefined,
  globalDefault: string | undefined,
): string | undefined {
  const providerName = modelConfig.name.split("/")[0];
  const provider = providers?.find((p) => p.name === providerName);
  return modelConfig.wireFormat ?? provider?.wireFormat ?? globalDefault;
}
