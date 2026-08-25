// Measures a string in four units in a single call. The units matter: they
// diverge for emoji (surrogate pairs), CJK, and combining sequences.
// Models are unreliable at counting characters themselves, so this offloads the
// measurement to deterministic code and removes the unit ambiguity.

import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
} from "@core/extensions/tool-utils.ts";
import type { ToolMetadata } from "@core/extensions/tool-registry.ts";
import { HOOKS } from "@core/hooks.ts";
import type {
  CoreContext,
  ExtensionInstance,
  ToolContext,
} from "@core/extensions/types.ts";

export interface StringLengthResult {
  /** JS `.length` — UTF-16 code units (emoji count as 2). */
  utf16: number;
  /** Unicode code points (what most people mean by "characters"). */
  codepoints: number;
  /** UTF-8 encoded byte length. */
  bytes: number;
  /** Visually distinct characters (emoji ZWJ sequences count as 1). */
  graphemes: number;
}

const encoder = new TextEncoder();

let segmenter: Intl.Segmenter | null | undefined;
function getSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    const Ctor = Intl.Segmenter;
    segmenter = typeof Ctor === "function" ? new Ctor(undefined, { granularity: "grapheme" }) : null;
  }
  return segmenter;
}

export function measureString(s: string): StringLengthResult {
  const codepoints = [...s].length;
  let graphemes = codepoints;
  const seg = getSegmenter();
  if (seg) {
    graphemes = 0;
    for (const _ of seg.segment(s)) graphemes++;
  }
  return {
    utf16: s.length,
    codepoints,
    bytes: encoder.encode(s).length,
    graphemes,
  };
}

export class StringLengthTool {
  static readonly TOOL_NAME = "string_length";
  metadata: ToolMetadata = { sideEffects: false, difficulty: 1 };

  toToolDef() {
    return toolDef(
      StringLengthTool.TOOL_NAME,
      "Use to measure length of a string, returns four units: utf16, codepoints, bytes (UTF-8), and graphemes -- these differ for emoji, CJK, and combining marks. Prefer this over counting in your head.",
      {
        properties: {
          string: param("string", "The string to measure."),
        },
        required: ["string"],
      },
    );
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(
      input,
      () => "measuring string length...",
      { fallback: "measuring string length..." },
    );
  }

  async execute(input: string | Record<string, unknown> | null, _ctx?: ToolContext): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args) {
      return ToolResult.err("Error parsing string_length arguments");
    }
    const s = args.string;
    if (typeof s !== "string") {
      return ToolResult.err("'string' is required and must be a string");
    }

    const result = measureString(s);
    return ToolResult.ok(JSON.stringify(result)).withEntries({
      status: "success",
      utf16: String(result.utf16),
      codepoints: String(result.codepoints),
      bytes: String(result.bytes),
      graphemes: String(result.graphemes),
    });
  }
}

// ── Extension Entry Point ───────────────────────────────────────────────────

export function create(_core: CoreContext): ExtensionInstance {
  const tool = new StringLengthTool();

  return {
    hooks: {
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        registry.register(StringLengthTool.TOOL_NAME, tool);
      },
    },

    // Exposed for external use.
    StringLengthTool,
    measureString,
  };
}
