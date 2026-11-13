/**
 * Shared syntax tokenizer registry: pure text -> typed token runs, with no palette and no ANSI.
 * Sinks own the coloring (terminal palettes, webui CSS classes); the tokenizers only classify.
 * Resolve a language through getTokenizer: an unknown or absent lang means the caller renders plain text.
 * A new language drops in as a tokenizer file plus one registry entry (or a runtime registerTokenizer call).
 */

import { tokenizeShell } from "./shell.ts";
import { tokenizeCss } from "./css.ts";
import { tokenizeHtml } from "./html.ts";
import { tokenizeIni } from "./ini.ts";
import { tokenizeJavaScript } from "./javascript.ts";
import { tokenizeJson } from "./json.ts";
import { tokenizePython } from "./python.ts";
import { tokenizeToml } from "./toml.ts";
import { tokenizeTypeScript } from "./typescript.ts";
import { tokenizeXml } from "./xml.ts";
import { tokenizeYaml } from "./yaml.ts";

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

// Lang names match the webui file-view's extension guesses ("yaml" covers
// .yaml and .yml there), so a guessed lang resolves here without aliases.
// jsx/tsx share the JS/TS scanners: tag regions degrade to identifier/
// default noise there, which is the documented ceiling (no JSX parser).
const TOKENIZERS = new Map<string, SyntaxTokenizer>([
  ["shell", tokenizeShell],
  ["yaml", tokenizeYaml],
  ["json", tokenizeJson],
  ["css", tokenizeCss],
  ["html", tokenizeHtml],
  ["toml", tokenizeToml],
  ["ini", tokenizeIni],
  ["xml", tokenizeXml],
  ["python", tokenizePython],
  ["javascript", tokenizeJavaScript],
  ["jsx", tokenizeJavaScript],
  ["typescript", tokenizeTypeScript],
  ["tsx", tokenizeTypeScript],
]);

/** Register (or replace) the tokenizer for a lang name. */
export function registerTokenizer(lang: string, tokenizer: SyntaxTokenizer): void {
  TOKENIZERS.set(lang, tokenizer);
}

/** Look up a tokenizer by lang name; undefined means no tokenizer. */
export function getTokenizer(lang: string): SyntaxTokenizer | undefined {
  return TOKENIZERS.get(lang);
}
