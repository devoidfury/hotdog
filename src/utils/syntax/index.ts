/**
 * Shared syntax tokenizer registry: pure text -> typed token runs, with no palette and no ANSI.
 * Sinks own the coloring (terminal palettes, webui CSS classes); the tokenizers only classify.
 * Resolve a language through getTokenizer: an unknown or absent lang means the caller renders plain text.
 * A new language drops in as a tokenizer file plus one registry entry (or a runtime registerTokenizer call).
 */

import { tokenizeShell } from "./shell.ts";

/** One token run: a contiguous slice of the input sharing a token class. */
export interface SyntaxRun {
  /** Tokenizer-defined class, e.g. "command"/"operator"/"default" for
   * shell. Renderers style the classes they know and pass the rest through
   * unstyled. */
  type: string;
  text: string;
}

/** Splits text into ordered token runs. Contract: concatenating every
 * run's text reproduces the input exactly (lossless, no reordering). */
export type SyntaxTokenizer = (text: string) => SyntaxRun[];

const TOKENIZERS = new Map<string, SyntaxTokenizer>([["shell", tokenizeShell]]);

/** Register (or replace) the tokenizer for a lang name. */
export function registerTokenizer(lang: string, tokenizer: SyntaxTokenizer): void {
  TOKENIZERS.set(lang, tokenizer);
}

/** Look up a tokenizer by lang name; undefined means no tokenizer. */
export function getTokenizer(lang: string): SyntaxTokenizer | undefined {
  return TOKENIZERS.get(lang);
}
