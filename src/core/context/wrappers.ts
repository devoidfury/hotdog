// Semantic wrapper parts.
//
// A wrapper part is harness structure wrapping a payload. It is one level
// above the XML: the emitting extension (or harness code) names the wrapper
// and its fields, and the wire serializer (llm-client/serialize.ts) is the
// only place the wrapper is rendered and mangled. `contentToText()` renders
// the same shape unmangled for context, session logs, and display.
//
// Field trust is fixed per wrapper type (the part's semantics, not its
// message's provenance):
//   - "file-include": the attached file's data. Wrapper tag verbatim; path
//     and content are file data and are mangled at the wire.
//   - "system-notice": harness-generated notice. Verbatim.
//
// Wrapper tag names are protected by the marker mangler
// (CORE_PROTECTED_PREFIXES in marker-mangler.ts), so untrusted text cannot
// forge them. The origin of a wrapper part is enforced at the queue
// boundary (message-bus.ts flattens parts arrays arriving without harness
// provenance) and by the fact that INPUT-hook output is trusted code: only
// harness producers ever place wrapper parts in messages, so a rendered
// wrapper tag is a genuine harness marker.

import type { MarkerMangler } from "../marker-mangler.ts";

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

export type WrapperPart = FileIncludePart | SystemNoticePart;

// Bare tag names (no brackets): the mangler protects the bracketed form,
// and assembling the tag at render time keeps this file free of literal
// protected markers.
const FILE_INCLUDE_TAG = "file-include";
const SYSTEM_NOTICE_TAG = "system-notice";

export function isWrapperPart(part: unknown): part is WrapperPart {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  if (p.type === "file-include") {
    return typeof p.path === "string" && typeof p.content === "string";
  }
  if (p.type === "system-notice") {
    return typeof p.text === "string";
  }
  return false;
}

/** XML form of a file-include wrapper with given (already-mangled) field text. */
function fileIncludeXml(pathText: string, contentText: string): string {
  const t = FILE_INCLUDE_TAG;
  return `<${t}>\n<path>${pathText}</path>\n<contents>\n${contentText}</contents>\n</${t}>`;
}

/** XML form of a system-notice wrapper. */
function systemNoticeXml(text: string): string {
  const t = SYSTEM_NOTICE_TAG;
  return `<${t}>\n${text}\n</${t}>`;
}

/**
 * Render a wrapper part to its XML form.
 *
 * @param mangler - Session mangler, or null for the at-rest form (context,
 *   logs, display): no mangling anywhere.
 *
 * The wrapper tag is emitted verbatim in both forms; with a mangler, the
 * fields mangled per the type's trust spec (file-include: path + content;
 * system-notice: none).
 */
export function renderWrapper(part: WrapperPart, mangler: MarkerMangler | null): string {
  if (part.type === "system-notice") {
    return systemNoticeXml(part.text);
  }
  const m = (s: string) => (mangler ? (mangler.escape(s) ?? s) : s);
  return fileIncludeXml(m(part.path), m(part.content));
}
