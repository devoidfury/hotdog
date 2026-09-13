// WireFormat "xml" — the built-in default presentation protocol.
//
// This extension owns the model-facing SHAPE of every harness wrapper the
// conversation can carry: tool results, file includes, and system notices.
// Core owns the data (`ToolResultPart` et al in context/wrappers.ts) and the
// field-trust spec, and prescribes no markup for anything -- there is no
// shape in core to fall back to.
//
// Selection is by name, like the other llm seams: model -> provider -> the
// global `modelWireFormat` default, which comes from core config
// (core.config.json, "xml"). This extension is autoloaded, so that name
// resolves; disable it and any wrapper -- not just tool results -- throws at
// the wire instead of silently rendering a shape core invented.
//
// `markers` feeds the MarkerMangler union (file-include and system-notice
// protection travels with this format -- it emits their framing), so no tag
// here can be forged from outside: the wire serializer mangles every
// untrusted field before calling the renderers (see wrappers.ts), and tags
// are assembled by concatenation from bare names, so this file holds no
// literal marker either.

import type { WireFormat } from "@core/extensions/wire-format.ts";
import type {
  FileIncludePart,
  SystemNoticePart,
  ToolResultPart,
} from "@core/context/wrappers.ts";
import type { ExtensionInstance, CoreContext } from "@core/extensions/types.ts";
import { xmlEscape } from "@utils/strings.ts";

// Bare names (no brackets): the mangler protects the bracketed form, and
// building the tags at render time keeps literal markers out of this file.
const TOOL_TAG = "tool";
const OUTPUT_TAG = "output";
const ERROR_TAG = "error";
const HINT_TAG = "hint";
const FILE_INCLUDE_TAG = "file-include";
const PATH_TAG = "path";
const CONTENTS_TAG = "contents";
const SYSTEM_NOTICE_TAG = "system-notice";

/**
 * Metadata short enough to ride the wrapper open tag as attributes; anything
 * else becomes a child element. Purely this format's business -- core stores
 * `meta` as a flat list and never consults this set.
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

export const xmlWireFormat: WireFormat = {
  id: "xml",
  markers: [TOOL_TAG, OUTPUT_TAG, ERROR_TAG, HINT_TAG, FILE_INCLUDE_TAG, SYSTEM_NOTICE_TAG],

  renderToolResult(part: ToolResultPart): string {
    const attrs: string[] = [`name="${xmlEscape(part.tool)}"`, `status="${part.status}"`];
    const longMeta: string[] = [];
    for (const [key, value] of part.meta) {
      if (SHORT_META_KEYS.has(key)) {
        attrs.push(`${xmlEscape(key)}="${xmlEscape(value)}"`);
      } else {
        longMeta.push(`  <${xmlEscape(key)}>${value}</${xmlEscape(key)}>`);
      }
    }

    const lines: string[] = [`<${TOOL_TAG} ${attrs.join(" ")}>`];
    if (part.error !== null) lines.push(`  <${ERROR_TAG}>${part.error}</${ERROR_TAG}>`);
    lines.push(...longMeta);
    lines.push(`  <${OUTPUT_TAG}>${part.output}</${OUTPUT_TAG}>`);
    if (part.hint !== null) lines.push(`  <${HINT_TAG}>${part.hint}</${HINT_TAG}>`);
    lines.push(`</${TOOL_TAG}>`);
    return lines.join("\n");
  },

  renderFileInclude(part: FileIncludePart): string {
    return (
      `<${FILE_INCLUDE_TAG}>\n` +
      `<${PATH_TAG}>${part.path}</${PATH_TAG}>\n` +
      `<${CONTENTS_TAG}>\n${part.content}</${CONTENTS_TAG}>\n` +
      `</${FILE_INCLUDE_TAG}>`
    );
  },

  renderSystemNotice(part: SystemNoticePart): string {
    return `<${SYSTEM_NOTICE_TAG}>\n${part.text}\n</${SYSTEM_NOTICE_TAG}>`;
  },
};

export function create(core: CoreContext): ExtensionInstance {
  core.wireFormatRegistry.register(xmlWireFormat);
  return {};
}
