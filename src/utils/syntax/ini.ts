import type { SyntaxDef, SyntaxRun } from "./index.ts";
import { tokenizeWithDialect, type ValueSpan } from "./toml.ts";

/**
 * INI tokenizer: the toml scanner core (`tokenizeWithDialect` in toml.ts)
 * over a thinner dialect -- `;` joins `#` as a comment opener, `:` joins
 * `=` as a key/value separator, and `[section]` is the only header shape
 * (`[[x]]` degrades to a `[section]` run plus a stray bracket). Values are
 * the dialect's whole disagreement and live in `readIniValue`: a quoted
 * value runs to its closer or the line end, and a bare value runs to the
 * line end as ONE "string" run (ini holds no typed literals -- numbers and
 * booleans there are strings by definition), split only by a trailing
 * comment: a `#`/`;` opens it when preceded by whitespace, while a glued
 * one (`dsn=a#b`) is value bytes. Nothing else changes: sections, keys and
 * operators read exactly as in toml. See toml.ts for the shared doctrine:
 * pure, lossless (concatenating every run reproduces the input exactly,
 * for any input), sane per line, one run per token. This is display candy,
 * not an INI parser: the dialect zoo (continuations, sub-sections, typed
 * variants) is out of scope.
 */
export function tokenizeIni(text: string): SyntaxRun[] {
  return tokenizeWithDialect(text, {
    comment: new Set(["#", ";"]),
    separators: new Set(["=", ":"]),
    arrayTables: false,
    readValue: readIniValue,
  });
}

function readIniValue(text: string, from: number): ValueSpan {
  const n = text.length;
  const c = text[from];
  if (c === undefined || c === "\n" || c === "\r" || c === "#" || c === ";") return { end: from, type: null };
  if (c === '"' || c === "'") {
    let j = from + 1;
    while (j < n && text[j] !== c && text[j] !== "\n" && text[j] !== "\r") j++;
    return { end: j < n && text[j] === c ? j + 1 : j, type: "string" };
  }
  let end = from; // value bytes, trailing whitespace excluded
  let j = from;
  while (j < n) {
    const d = text[j]!;
    if (d === "\n" || d === "\r") break;
    if ((d === "#" || d === ";") && (j === from || isWs(text[j - 1]!))) break; // trailing comment
    j++;
    if (!isWs(d)) end = j;
  }
  return end > from ? { end, type: "string" } : { end: j, type: null };
}

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

/** The registry entry for this lang (assembly list: index.ts). */
export const INI_SYNTAX: SyntaxDef = {
  lang: "ini",
  tokenize: tokenizeIni,
  extensions: ["ini"],
  // KEY=value lands: these dotfiles are what the ini dialect reads. The
  // `.env` basename now belongs to the dedicated env tokenizer.
  basenames: [".editorconfig", ".gitconfig"],
};
