// Plain-text view of a tool result, for OUTPUT SURFACES.
//
// The executor stores a tool result as a ToolResultPart (context/wrappers.ts):
// core deliberately renders nothing, because the model-facing shape belongs to
// the session's WireFormat. Sinks (the CLI, the websocket bridge, the browser
// log view) still need text, so they build it here from the part's fields.
// This is display, not a wire format -- nothing downstream of here may use it
// for a model request, and core has no opinion about it.

import { isToolResultPart, isWrapperPart, type ToolResultContent } from "@core/context/wrappers.ts";

export function toolContentText(content: ToolResultContent | Array<unknown> | null | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  const lines: string[] = [];
  for (const part of content) {
    if (!isToolResultPart(part)) continue;
    if (part.output) lines.push(part.output);
    if (part.error !== null) lines.push(`Error: ${part.error}`);
    if (part.hint !== null) lines.push(`HINT: ${part.hint}`);
    // Metadata is part of the result (exit codes, pagination, durations);
    // a display surface that shows the answer shows the facts about it too.
    if (part.meta.length > 0) lines.push(`META: ${JSON.stringify(Object.fromEntries(part.meta))}`);
  }
  return lines.join("\n");
}

/**
 * Plain-text view of ANY message content for display surfaces (session
 * review, web log views). Core renders wrapper parts as JSON at rest; a
 * human-facing view composes prose instead -- this is display, not a wire
 * format, and it is intentionally NOT used for context, logs, or models.
 */
export function wrapperContentText(content: string | Array<unknown> | null | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  const lines: string[] = [];
  for (const part of content) {
    if (part == null || typeof part !== "object") continue;
    if (isToolResultPart(part)) {
      lines.push(toolContentText([part]));
    } else if (isWrapperPart(part) && part.type === "system-notice") {
      lines.push(`[notice] ${part.text}`);
    } else if (isWrapperPart(part) && part.type === "file-include") {
      lines.push(`[file ${part.path}]\n${part.content}`);
    } else {
      const p = part as Record<string, unknown>;
      if ((p.type === "text" || p.type === "untrusted") && typeof p.text === "string") {
        lines.push(p.text);
      }
    }
  }
  return lines.join("\n");
}
