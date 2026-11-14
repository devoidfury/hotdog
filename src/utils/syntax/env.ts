import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Env/dotenv tokenizer.
 *
 * One pass, line-aware: a line-leading `export` is "keyword" only when it
 * reaches a following `KEY=` assignment; `=` is "operator"; a bare word before
 * the separator is "key" (across inline spaces, because real files get
 * `KEY = value`); values are "string" whether quoted or bare, because dotenv
 * values are strings by definition; a `#` is "comment" at line start or when
 * whitespace precedes it, while a glued `#` inside a bare value (`A=b#c`) stays
 * value bytes. Double and single quoted values honor backslash escapes and
 * stop at the newline when unterminated, the line-wise family. Honest limits:
 * variable interpolation (`${FOO}`) rides the string, shell line continuations
 * beyond a backslash escape are not modeled, and a value beginning with `#`
 * after a tight `=` (`A=#b`) is deliberately not a comment. Nothing is ever
 * dropped or reordered: concatenating every run reproduces the input exactly,
 * for any input. One run per token; adjacent runs may share a type (sinks
 * coalesce as they like). This is display candy, not a dotenv parser.
 */
export function tokenizeEnv(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let lineStart = true;
  let prevSpace = true;

  while (i < n) {
    const c = text[i]!;
    if (isWs(c)) {
      let j = i;
      let sawNewline = false;
      while (j < n && isWs(text[j])) {
        if (text[j] === "\n") sawNewline = true;
        j++;
      }
      push("default", text.slice(i, j));
      i = j;
      if (sawNewline) lineStart = true;
      prevSpace = true;
      continue;
    }
    if (c === "#" && (lineStart || prevSpace)) {
      const end = endOfLine(text, i);
      push("comment", text.slice(i, end));
      i = end;
      lineStart = false;
      prevSpace = false;
      continue;
    }
    if (KEY_START_RE.test(c)) {
      let j = i;
      while (j < n && KEY_RE.test(text[j]!)) j++;
      const word = text.slice(i, j);
      if (word === "export" && lineStart && hasAssignmentAhead(text, j)) {
        push("keyword", word);
        i = j;
        lineStart = false;
        prevSpace = false;
        continue;
      }
      push(hasSeparatorAhead(text, j) ? "key" : "default", word);
      i = j;
      lineStart = false;
      prevSpace = false;
      continue;
    }
    if (c === "=") {
      push("operator", c);
      i++;
      const start = i;
      let j = i;
      while (j < n && isInlineWs(text[j]!)) j++;
      push("default", text.slice(i, j));
      i = j;
      if (i < n && text[i] === "#" && (j > start || lineStart)) {
        const end = endOfLine(text, i);
        push("comment", text.slice(i, end));
        i = end;
        lineStart = false;
        prevSpace = false;
        continue;
      }
      const v = readEnvValue(text, i);
      if (v.type !== null && v.end > i) push(v.type, text.slice(i, v.end));
      i = v.end;
      lineStart = false;
      prevSpace = false;
      continue;
    }
    if (c === '"' || c === "'") {
      const v = readEnvValue(text, i);
      if (v.end === i) {
        push("default", c);
        i++;
      } else {
        push(hasSeparatorAhead(text, v.end) ? "key" : (v.type ?? "string"), text.slice(i, v.end));
        i = v.end;
      }
      lineStart = false;
      prevSpace = false;
      continue;
    }
    push("default", c);
    i++;
    lineStart = false;
    prevSpace = false;
  }
  return runs;
}

function readEnvValue(text: string, from: number): { end: number; type: string | null } {
  const n = text.length;
  const c = text[from];
  if (c === undefined || c === "\n" || c === "\r") return { end: from, type: null };
  if (c === '"' || c === "'") return { end: endOfString(text, from), type: "string" };

  let j = from;
  let end = from;
  while (j < n) {
    const d = text[j]!;
    if (d === "\n" || d === "\r") break;
    if (d === "#" && j > from && isWs(text[j - 1]!)) break;
    j++;
    if (!isWs(d)) end = j;
  }
  return end > from ? { end, type: "string" } : { end: j, type: null };
}

function endOfString(text: string, from: number): number {
  const quote = text[from]!;
  let j = from + 1;
  while (j < text.length) {
    const d = text[j]!;
    if (d === "\\") {
      j += 2;
      continue;
    }
    if (d === "\n" || d === "\r") return j;
    if (d === quote) return j + 1;
    j++;
  }
  return text.length;
}

function endOfLine(text: string, from: number): number {
  let j = from;
  while (j < text.length && text[j] !== "\n" && text[j] !== "\r") j++;
  return j;
}

function hasAssignmentAhead(text: string, from: number): boolean {
  const j = skipInlineWs(text, from);
  if (j >= text.length || !KEY_START_RE.test(text[j]!)) return false;
  let k = j;
  while (k < text.length && KEY_RE.test(text[k]!)) k++;
  return hasSeparatorAhead(text, k);
}

function hasSeparatorAhead(text: string, from: number): boolean {
  return text[skipInlineWs(text, from)] === "=";
}

const skipInlineWs = (text: string, from: number): number => {
  let j = from;
  while (j < text.length && isInlineWs(text[j]!)) j++;
  return j;
};

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const isInlineWs = (c: string): boolean => c === " " || c === "\t";
const KEY_START_RE = /[A-Za-z_]/;
const KEY_RE = /[A-Za-z0-9_]/;

/** The registry entry for this lang (assembly list: index.ts). */
export const ENV_SYNTAX: SyntaxDef = {
  lang: "env",
  tokenize: tokenizeEnv,
  aliases: ["dotenv", "envfile"],
  extensions: ["env"],
  basenames: [".env"],
};
