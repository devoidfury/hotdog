// The terminal posture for a declared result-sourced `kind: "file"` part
// (ToolDisplaySpec, resolved server-side from the tool's metadata and handed
// to the sink through its `display` seam). The part itself does not name a
// language -- a read can land on any file -- so the sink guesses the way the
// workbench file viewer does: basename through the shared tokenizer
// registry's table (@utils/syntax/). The declaration decides WHETHER the
// file posture renders; the table decides the language; and an absence
// anywhere on that path (no part, dotless name, unclaimed extension, or a
// guess-only def with no scanner like markdown) resolves null, which is
// today's generic plain box, byte-for-byte. Plain is never a failure.
//
// Every file byte is spoof-neutralized per run BEFORE any ANSI composes
// (ESC is itself a neutralized code point, so styling first would shred the
// escape) -- the same invariant the diff block respects. Colors-off returns
// the input untouched, exactly the legacy byte path.

import { getTokenizer, guessLangForBase } from "@utils/syntax/index.ts";
import { spoofSafe } from "@utils/spoof.ts";
import type { ToolDisplaySpec } from "@core/extensions/tool-registry.ts";
import { applyColor, type ColorPalette } from "./colors.ts";

/** The parsed args object, or null when the call's input is not a JSON object. */
function parseArgs(input: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * The tokenizer lang for this call's file posture, or null meaning "generic
 * box". Cheapest tests first, mirroring resolveCliDiff: an undeclared tool
 * must not pay for parsing what is often a large args JSON. Only the
 * RESULT-sourced file part qualifies (an args-sourced part's body is the
 * written text at call time, a posture this sink does not draw); the failed
 * gate keeps the generic posture's full story (HINT included) on errors.
 * A guessed lang only counts when the registry has a scanner for it:
 * markdown's scanner is stateful and lives outside the registry, so a
 * `.md` read renders plain here (the file viewer drives its doc tokenizer;
 * a print stream keeps the line-scoped contract).
 */
export function resolveCliFileSyntax(
  display: ToolDisplaySpec[] | undefined,
  args: string,
  opts: { failed?: boolean } = {},
): string | null {
  if (!display || opts.failed) return null;
  if (
    !display.some((spec) => spec.kind === "file" && spec.source !== "args" && spec.pathArg !== undefined)
  ) {
    return null;
  }
  const parsed = parseArgs(args);
  if (!parsed) return null;
  // First declared file part decides, skip rules included (no tool declares
  // a second, and falling through past a declared-but-unmatched path would
  // read like the part never existed).
  for (const spec of display) {
    if (spec.kind !== "file" || spec.source === "args" || spec.pathArg === undefined) continue;
    const path = parsed[spec.pathArg];
    if (typeof path !== "string" || path === "") return null;
    const lang = guessLangForBase(path.split(/[/\\]/).pop() ?? "");
    return lang !== undefined && getTokenizer(lang) !== undefined ? lang : null;
  }
  return null;
}

/**
 * The result text as highlighted committed text. One line at a time: the
 * registry's contract is line-scoped stateless tokenizers, and a throwing
 * scanner degrades to one plain run for its line (file-view's `tokenizeLine`
 * posture). Coloring matches the diff block's invariant -- every span
 * re-opens its own SGR and closes with RESET -- because the sink's
 * tool_result mode wash wraps the whole block, and a bare mid-line RESET
 * would strand the rest of the line off any color. Unknown token classes
 * (and the scanner's `default` runs) ride the palette's `tool_result`
 * color, so an unfamiliar class looks exactly like today's flat wash.
 */
export function renderCliCode(text: string, lang: string, palette: ColorPalette): string {
  if (!palette.use_colors || text === "") return text;
  const tokenizer = getTokenizer(lang);
  // resolveCliFileSyntax already proved the scanner exists; the re-check
  // keeps this function honest when called with any lang name.
  if (!tokenizer) return text;
  const base = palette.tool_result;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Empty lines stay empty: the newline buffer downstream owns spacing,
    // and painting "" would commit a bare SGR pair into scrollback.
    if (line === "") continue;
    let runs: { type: string; text: string }[];
    try {
      runs = tokenizer(line);
    } catch {
      runs = [{ type: "default", text: line }];
    }
    let out = "";
    for (const run of runs) {
      if (run.text === "") continue;
      const neutral = spoofSafe(run.text);
      out += applyColor(neutral, palette.syntax[run.type] ?? base, true);
    }
    lines[i] = out;
  }
  return lines.join("\n");
}
