import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * JSON tokenizer (JSONC-tolerant: line and block comments plus trailing
 * commas classify instead of failing -- the house config dialect).
 *
 * Single pass: "key" for a string followed (across any whitespace) by `:`,
 * "string" for every other string (escapes honored; an unterminated string
 * runs to end of input), "number" for well-formed JSON numbers (a numeric
 * lookalike like `1.2.3` rides "default" rather than claim the class),
 * "boolean"/"null" for the bare literals, "comment" for `//` (to EOL) and
 * the block form (to the closer or end of input), "operator" for the
 * structural `{}[]:,`, and "default" for whitespace and any stray byte.
 * Nothing is ever dropped or reordered: concatenating every run reproduces
 * the input exactly, for any input. One run per token; adjacent runs may
 * share a type (sinks coalesce as they like). This is display candy, not a
 * JSON parser: no validation, no duplicate-key verdicts.
 */
export function tokenizeJson(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      let j = i;
      while (j < n && isWs(text[j])) j++;
      push("default", text.slice(i, j));
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      let j = i + 2;
      while (j < n && text[j] !== "\n") j++;
      push("comment", text.slice(i, j));
      i = j;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      push("comment", text.slice(i, j));
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n) {
        const d = text[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === '"') {
          j++;
          break;
        }
        j++;
      }
      if (j > n) j = n; // a trailing escape on an unterminated string
      const isKey = peekColon(text, j);
      push(isKey ? "key" : "string", text.slice(i, j));
      i = j;
    } else if (isDigit(c) || ((c === "+" || c === "-") && (isDigit(text[i + 1]) || text[i + 1] === "."))) {
      let j = i + 1;
      while (j < n && NUM_CHARS.has(text[j]!)) j++;
      const word = text.slice(i, j);
      push(NUM_RE.test(word) ? "number" : "default", word);
      i = j;
    } else if (LETTER_RE.test(c)) {
      let j = i;
      while (j < n && LETTER_RE.test(text[j]!)) j++;
      const word = text.slice(i, j);
      push(word === "true" || word === "false" ? "boolean" : word === "null" ? "null" : "default", word);
      i = j;
    } else if (STRUCTURAL.has(c)) {
      push("operator", c);
      i++;
    } else {
      push("default", c);
      i++;
    }
  }
  return runs;
}

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

/** True when the first non-whitespace byte at `from` is a `:`. */
function peekColon(text: string, from: number): boolean {
  let j = from;
  while (j < text.length && isWs(text[j])) j++;
  return text[j] === ":";
}

const NUM_CHARS = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "+", "-", "e", "E"]);
const NUM_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
const LETTER_RE = /[A-Za-z_$]/;
const STRUCTURAL = new Set(["{", "}", "[", "]", ":", ","]);

/** The registry entry for this lang (assembly list: index.ts). */
export const JSON_SYNTAX: SyntaxDef = {
  lang: "json",
  tokenize: tokenizeJson,
  aliases: ["jsonc"],
  extensions: ["json", "jsonc"],
};
