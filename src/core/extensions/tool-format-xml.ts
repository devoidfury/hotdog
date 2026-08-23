// XML tool format — the built-in default ToolFormat.
//
// Lives in core (not in an extension) because it is the zero-config default:
// every tool result goes through it unless a different format is selected.
// The builtin extension `extensions/tool-format-xml` re-registers this same
// object under EXTENSION_PROVIDES.TOOL_FORMATS so extensions can discover
// and replace it; keeping the implementation in core avoids a load-order
// dependency for the default path (mirrors the OpenAI protocol decision).
//
// Emits `<tool name=... status=...>` wrappers for model-facing tool results.
// Element names (markers) feed the MarkerMangler union so untrusted content
// cannot forge them at the wire. Formats emit raw text; they never mangle --
// the wire serializer is the only mangle point.

import { xmlEscape } from "@utils/strings.ts";
import type { ToolFormat } from "./tool-format.ts";

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

function xmlResult(
  result: string | Record<string, unknown>,
  toolName: string,
  meta?: { status: string; [key: string]: string },
): string {
  const status = meta?.status || "success";

  // ToolResult.toApiContent() passes the full result object (output raw,
  // metadata in the object). Everything else arrives as a plain payload with
  // short metadata already split into `meta`.
  const isObject = typeof result === "object" && result !== null;
  const obj = isObject ? (result as Record<string, unknown>) : {};

  const tag =
    (isObject && typeof obj.outputTag === "string" && obj.outputTag) ||
    (meta && typeof meta.outputTag === "string" && meta.outputTag) ||
    "output";

  const attrs: string[] = [`name="${xmlEscape(toolName)}"`, `status="${status}"`];
  const longMeta: string[] = [];

  // On failure the error text is pulled out and emitted first (pre-seam
  // position); otherwise an "error" key is just metadata like any other.
  const metaEntries: [string, unknown][] = [];
  let errorValue: unknown = null;
  if (isObject) {
    for (const key of Object.keys(obj)) {
      if (key === "output" || key === "outputTag") continue;
      if (key === "error" && status !== "success") { errorValue = obj[key]; continue; }
      metaEntries.push([key, obj[key]]);
    }
  } else if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (key === "status" || key === "outputTag") continue;
      if (key === "error" && status !== "success") { errorValue = value; continue; }
      metaEntries.push([key, value]);
    }
  }

  for (const [key, value] of metaEntries) {
    const v = String(value);
    if (SHORT_META_KEYS.has(key)) {
      attrs.push(`${xmlEscape(key)}="${xmlEscape(v)}"`);
    } else {
      longMeta.push(`  <${xmlEscape(key)}>${v}</${xmlEscape(key)}>`);
    }
  }

  // Error text: always the first child (pre-seam position), raw/unescaped,
  // emitted only on failure -- matching pre-seam XML on both the plain and
  // the toApiContent() object paths.
  if (errorValue != null && status !== "success") {
    longMeta.unshift(`  <error>${String(errorValue)}</error>`);
  }

  // Output: toApiContent() passes the object (output is raw, matching the
  // pre-seam behavior); plain payloads are XML-escaped as before.
  const outputContent = isObject ? String(obj.output ?? "") : xmlEscape(result as string);
  const parts: string[] = [`<tool ${attrs.join(" ")}>`];
  parts.push(...longMeta);
  parts.push(`  <${tag}>${outputContent}</${tag}>`);
  parts.push("</tool>");

  return parts.join("\n");
}

export const xmlToolFormat: ToolFormat = {
  id: "xml",
  markers: ["tool", "output", "error"],
  formatResult(result, toolName, meta) {
    return xmlResult(result, toolName, meta);
  },
};
