// Semantic wrapper parts.
//
// A wrapper part is harness structure wrapping a payload. It is one level
// above the markup: core owns the DATA (the part types, shape validation)
// and the field TRUST spec; the WireFormat extension (extensions/
// wire-format-xml is the built-in) owns the model-facing SHAPE. The wire
// serializer (llm-client/serialize.ts) is the only place a wrapper is
// rendered and mangled.
//
// Field trust is fixed per wrapper type (the part's semantics, not its
// message's provenance):
//   - "file-include": the attached file's data. Path and content are file
//     data and are mangled at the wire.
//   - "system-notice": harness-generated notice. Verbatim.
//   - "tool-result": one tool's output. `status` is harness-owned;
//     everything the tool produced (name, metadata keys and values, error,
//     hint, output) is tool data and is mangled at the wire.
//
// WHAT CORE DOES NOT OWN: any markup at all. There is no canonical shape
// here for any wrapper type -- framing belongs to the selected WireFormat
// and is applied by the wire serializer. Serializing ANY wrapper without one
// is an error, not a fallback. At rest (context, session logs, hooks, UI
// handlers) every wrapper part is passed through as DATA (JSON), so no layer
// downstream of the wire has to un-render a format it never chose; a display
// consumer composes its own text (see utils/tool-content.ts).
//
// Wrapper tag names are protected by the marker mangler: core's own tags via
// CORE_PROTECTED_PREFIXES, the active format's tags via its `markers`, so
// untrusted text cannot forge them. The origin of a wrapper part is enforced
// at the queue boundary (message-bus.ts flattens parts arrays arriving
// without harness provenance) and by the fact that INPUT-hook output is
// trusted code: only harness producers ever place wrapper parts in messages,
// so a rendered wrapper tag is a genuine harness marker.

import type { MarkerMangler } from "../marker-mangler.ts";
import { LlmError } from "../error.ts";
import type { WireFormat } from "../extensions/wire-format.ts";

/** Attached-file wrapper: harness framing around untrusted file data. */
export interface FileIncludePart {
  type: "file-include";
  /** Path of the attached file, as referenced (workspace-relative or absolute). */
  path: string;
  /** Raw file content. Mangled at the wire. */
  content: string;
}

/** Harness system-notice wrapper: the text is harness-generated, verbatim. */
export interface SystemNoticePart {
  type: "system-notice";
  text: string;
}

/**
 * Tool-result wrapper: harness framing around one tool's output.
 *
 * Structured data, never pre-rendered markup: the ToolExecutor stores the
 * part, and the session's WireFormat turns it into model-facing text at the
 * wire. Tool code names nothing that reaches the wire -- `tool` is the
 * registered name and `meta` keys come from harness-authored tool code, both
 * of which the wire mangles as data.
 */
export interface ToolResultPart {
  type: "tool-result";
  /** Registered tool name. Tool data: mangled at the wire. */
  tool: string;
  /** Harness-generated outcome ("success" | "failure" | "error"): verbatim. */
  status: string;
  /** Tool metadata, in declaration order. Keys and values are tool data. */
  meta: Array<[string, string]>;
  /** Tool-authored failure text; null on success. */
  error: string | null;
  /** Tool-authored recovery guidance; null when absent. */
  hint: string | null;
  /** The tool's output payload. */
  output: string;
}

export type WrapperPart = FileIncludePart | SystemNoticePart | ToolResultPart;

/**
 * What a tool message's content may hold: harness text (the executor's own
 * messages -- unknown tool, validation error, executor failure) or the
 * tool-result part(s). Nothing in this type is model-facing: a WireFormat
 * shapes the part when the message reaches the wire, and at rest the part
 * travels as data.
 */
export type ToolResultContent = string | ToolResultPart[];

export function isWrapperPart(part: unknown): part is WrapperPart {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  if (p.type === "file-include") {
    return typeof p.path === "string" && typeof p.content === "string";
  }
  if (p.type === "system-notice") {
    return typeof p.text === "string";
  }
  if (p.type === "tool-result") {
    if (typeof p.tool !== "string" || typeof p.status !== "string") return false;
    if (typeof p.output !== "string") return false;
    if (p.error !== null && typeof p.error !== "string") return false;
    if (p.hint !== null && typeof p.hint !== "string") return false;
    if (!Array.isArray(p.meta)) return false;
    return (p.meta as unknown[]).every(
      (e) => Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string",
    );
  }
  return false;
}

/** Narrower check for output surfaces that only handle tool results. */
export function isToolResultPart(part: unknown): part is ToolResultPart {
  return isWrapperPart(part) && part.type === "tool-result";
}

/**
 * The at-rest form of a wrapper part (context, session logs, hooks, display,
 * UI handlers): the part itself, as data -- for EVERY wrapper type. Core
 * prescribes no markup, so consumers get the fields. A consumer that wants
 * prose picks its own rendering (the CLI flattens tool results via
 * utils/tool-content.ts); the model-facing shape is chosen by the session's
 * WireFormat at the wire and nowhere else.
 */
export function renderWrapperAtRest(part: WrapperPart): string {
  return JSON.stringify(part);
}

/**
 * Apply the file-include trust spec: the file's path and content are data
 * and escape; returns a NEW part -- stored content is never mutated.
 */
export function mangleFileIncludeFields(part: FileIncludePart, mangler: MarkerMangler): FileIncludePart {
  const m = (s: string): string => mangler.escape(s) ?? s;
  return { ...part, path: m(part.path), content: m(part.content) };
}

/**
 * Apply the tool-result trust spec: every value the tool produced (name,
 * metadata keys and values, error, hint, payload) is escaped; the
 * harness-generated `status` is verbatim. Returns a NEW part -- the stored
 * message content is never mutated.
 *
 * Escaping happens here, before the part reaches the format, so a format
 * physically cannot emit an unescaped tool payload.
 */
export function mangleToolResultFields(part: ToolResultPart, mangler: MarkerMangler): ToolResultPart {
  const m = (s: string): string => mangler.escape(s) ?? s;
  // A metadata key lands in a markup-NAME position in the built-in shape (and
  // in anything similar a replacement format invents), so it must be mangled as
  // markup rather than as bare text: mangling the bracketed form aliases a
  // protected name hidden inside a tool-authored key
  // (`ToolResult.withEntry("system-notice", ...)`), which text mangling would
  // leave live in the wire markup.
  const mKey = (s: string): string => {
    const wrapped = `<${s}>`;
    return (mangler.escape(wrapped) ?? wrapped).slice(1, -1);
  };
  return {
    ...part,
    tool: m(part.tool),
    meta: part.meta.map(([key, value]): [string, string] => [mKey(key), m(value)]),
    error: part.error === null ? null : m(part.error),
    hint: part.hint === null ? null : m(part.hint),
    output: m(part.output),
  };
}

/**
 * Render a wrapper part for the model, at the wire boundary. The framing
 * comes from the session's WireFormat; with a mangler the fields mangle per
 * the type's trust spec BEFORE the format sees them (file-include: path +
 * content; tool-result: everything the tool produced; system-notice: none --
 * its text is harness-generated). A `null` mangler means mangling is
 * disabled for the session, not that the format is skipped.
 *
 * @param format - The request's WireFormat. REQUIRED for ANY wrapper part:
 *   core ships no shape of its own, so an unconfigured format is a config
 *   error (LlmError, type "config") at the boundary rather than a silent
 *   guess.
 */
export function renderWrapperForWire(
  part: WrapperPart,
  mangler: MarkerMangler | null,
  format: WireFormat | null,
): string {
  if (!format) {
    // A config error, not a bug: classified so formatError() shows the
    // actionable message without a stack (isExpectedError in error.ts).
    throw new LlmError(
      `No wire format is active, so the "${part.type}" wrapper cannot be serialized for the model. ` +
        `Enable a wire-format extension (built-in: wire-format-xml) or set "modelWireFormat".`,
      "config",
    );
  }
  if (part.type === "system-notice") {
    return format.renderSystemNotice(part);
  }
  if (part.type === "file-include") {
    const safe = mangler ? mangleFileIncludeFields(part, mangler) : part;
    return format.renderFileInclude(safe);
  }
  const safe = mangler ? mangleToolResultFields(part, mangler) : part;
  return format.renderToolResult(safe);
}
