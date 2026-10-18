// Semantic wrapper parts.
//
// A wrapper part is harness structure wrapping a payload -- one level above
// the markup: core owns the DATA (part types, shape validation) and each
// field's TRUST spec; the WireFormat extension (built-in: wire-format-xml)
// owns the model-facing SHAPE. The wire serializer (llm-client/serialize.ts)
// is the only place a wrapper is rendered and mangled.
//
// Field trust is fixed per wrapper type (its semantics, not its message's
// provenance):
//   - "file-include": the attached file's path and content -- file data,
//     mangled at the wire.
//   - "system-notice": harness-generated notice -- verbatim, so any untrusted
//     fragment interpolated into it must pass sanitizeNoticeText() first.
//   - "tool-result": one tool's output. `status` is harness-owned; everything
//     the tool produced (name, metadata keys/values, error, hint, output) is
//     tool data, mangled at the wire.
//
// CORE DOES NOT OWN any markup: there is no canonical shape here. Framing belongs to the selected WireFormat,
// applied by the wire serializer. Serializing ANY wrapper without one is an error, not a fallback. At rest
// (context, session logs, hooks, UI) every wrapper part passes through as DATA (JSON), so no layer downstream
// has to un-render a format it never chose; a display consumer composes its own text (utils/tool-content.ts).
//
// Wrapper tag names are protected by the marker mangler: core's own tags via CORE_PROTECTED_PREFIXES,
// the active format's tags via its `markers`, so untrusted text cannot forge them.
// A wrapper part's origin is enforced at the queue boundary (message-bus.ts flattens parts arrays without harness
// provenance) and by the fact that INPUT-hook output is trusted code: only harness producers ever place wrapper
// parts in messages, so a rendered wrapper tag is a genuine harness marker.

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
 * Neutralize wire-marker bytes in an UNTRUSTED fragment interpolated into a
 * `system-notice` text (a file path, a name -- anything that did not originate
 * in harness code).
 *
 * system-notice renders VERBATIM at harness trust level: the marker mangler
 * never processes this channel, so a hostile fragment carrying an angle-bracket
 * closing sequence -- a cloned repo may name a file whose component spells the
 * live notice tag plus `>` -- would close the element early and forge framing
 * the model is told to trust. Any future notice builder that interpolates
 * environment data MUST route the fragment through here; the notice's own
 * template lines are harness text and stay as written. `<`, `>`, NUL, CR and
 * LF become an ellipsis: a forged tag needs `<>`, a fake notice line needs `\n`.
 */
export function sanitizeNoticeText(fragment: string): string {
  return fragment.replace(/[<>\u0000\r\n]/g, "\u2026");
}

/**
 * Tool-result wrapper: harness framing around one tool's output.
 *
 * Structured data, never pre-rendered markup: the ToolExecutor stores the
 * part, and the session's WireFormat turns it into model-facing text at the
 * wire. Tool code names nothing that reaches the wire -- `tool` is the
 * registered name and `meta` keys come from harness-authored tool code, both
 * which the wire mangles as data.
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
 * tool-result part(s). Nothing here is model-facing: a WireFormat shapes the
 * part when the message reaches the wire, and at rest the part travels as data.
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
 * The at-rest form of a wrapper part (context, session logs, hooks, display):
 * the part itself, as data -- for EVERY wrapper type. Core prescribes no
 * markup, so consumers get the fields. A consumer that wants prose picks its
 * own rendering (the CLI flattens tool results via utils/tool-content.ts); the
 * model-facing shape is chosen by the session's WireFormat at the wire only.
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
 * harness-generated `status` is verbatim. Returns a NEW part -- stored content
 * is never mutated.
 *
 * Escaping happens here, before the part reaches the format, so a format
 * physically cannot emit an unescaped tool payload.
 */
export function mangleToolResultFields(part: ToolResultPart, mangler: MarkerMangler): ToolResultPart {
  const m = (s: string): string => mangler.escape(s) ?? s;
  // A metadata key lands in a markup-NAME position in the built-in shape (and
  // in anything similar a replacement format invents), so it must be mangled as
  // markup rather than bare text: mangling the bracketed form aliases a
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
 * Render a wrapper part for the model, at the wire boundary. The framing comes from the session's WireFormat;
 * with a mangler the fields mangle per the type's trust spec BEFORE the format sees them (file-include: path +
 * content; tool-result: everything the tool produced; system-notice: none -- its text is harness-generated).
 * A `null` mangler means mangling is disabled for the session, not that the format is skipped.
 *
 * @param format - The request's WireFormat. REQUIRED for ANY wrapper part:
 *   core ships no shape of its own, so an unconfigured format is a config
 *   error (LlmError, "config") at the boundary rather than a silent guess.
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
