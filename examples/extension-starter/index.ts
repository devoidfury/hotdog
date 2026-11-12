// Starter extension: registers one tool (word_count) and reads one config knob.
// Imports ONLY "@read-receipt/hotdog/sdk" — that module is the whole authoring
// contract, spelled identically in-tree and from an installed hotdog package.
// From defaults.json: { "extensionPaths": ["@extensions", "examples/extension-starter"] }

import {
  getExtensionConfig,
  HOOKS,
  param,
  parseToolInput,
  ToolResult,
  toolDef,
} from "@read-receipt/hotdog/sdk";
import type { CoreContext, ExtensionInstance, ToolContext, ToolMetadata } from "@read-receipt/hotdog/sdk";

const WORD_RE = /\S+/g;

export interface WordCount {
  words: number;
  lines: number;
  characters: number;
  uniqueWords: number;
  /** Case-insensitive frequency ranking: [word, count], count desc then lexicographic. */
  ranked: [string, number][];
}

export function countWords(text: string): WordCount {
  const words = text.match(WORD_RE) ?? [];
  const counts = new Map<string, number>();
  for (const w of words) {
    const key = w.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  return {
    words: words.length,
    lines: text === "" ? 0 : text.split("\n").length,
    characters: text.length,
    uniqueWords: counts.size,
    ranked,
  };
}

export class WordCountTool {
  static readonly TOOL_NAME = "word_count";
  #core: CoreContext;

  // sideEffects/difficulty are required on every tool; tags name the domain
  // for listings and future profile access rules.
  metadata: ToolMetadata = { sideEffects: false, difficulty: 1, tags: ["utility"] };

  constructor(core: CoreContext) {
    this.#core = core;
  }

  toToolDef() {
    return toolDef(
      WordCountTool.TOOL_NAME,
      "Count words, lines, and characters in a text, plus the N most frequent words (case-insensitive).",
      {
        properties: { text: param("string", "The text to analyze.") },
        required: ["text"],
      },
    );
  }

  async execute(
    input: string | Record<string, unknown> | null,
    _ctx?: ToolContext,
  ): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args) {
      return ToolResult.err("Error parsing word_count arguments");
    }
    if (typeof args.text !== "string") {
      return ToolResult.err("'text' is required and must be a string");
    }

    // Config is read at the point of use: no create()-time capture, no backup
    // defaults. The schema in extension.json owns the default value; the live
    // config store answers with whatever the current generation holds.
    const { topWords } = getExtensionConfig<{ topWords: number }>(this.#core, "extensionStarter");

    const { words, lines, characters, uniqueWords, ranked } = countWords(args.text);
    const top = ranked.slice(0, topWords);
    return ToolResult.ok(
      JSON.stringify({ words, lines, characters, uniqueWords, top }),
    ).withEntries({ words: String(words) });
  }
}

export function create(core: CoreContext): ExtensionInstance {
  // No `enabled` check here: the loader gates on extension.json + config, so
  // a disabled extension never reaches create().
  return {
    hooks: {
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        registry.register(WordCountTool.TOOL_NAME, new WordCountTool(core));
      },
    },
  };
}
