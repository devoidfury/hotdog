import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Lua tokenizer.
 *
 * One pass over code: `--` opens a line comment to the line end; `--[` or
 * `--[=*[` opens a long comment and runs to its matching `]` (or end of input);
 * `[[`/`[=[` opens a long string the same way; single/double quoted strings
 * honor backslash escapes and stop at the newline when unterminated; numbers
 * cover decimal, hex, floats and the common exponent forms; Lua keywords ride
 * "keyword" (except after a member dot), `true`/`false` "boolean", `nil`
 * "null"; a name directly before `(` or following the `function` keyword is
 * "fn"; `...`, `..`, `==`, `~=`, `<=`, `>=`, and the punctuation are
 * "operator". The tokenizer is honest about not being a Lua parser: it does
 * not validate chunk structure, and long strings/comments whose closer never
 * arrives simply run to the end of the input. Nothing is ever dropped or
 * reordered: concatenating every run reproduces the input exactly, for any
 * input. One run per token; adjacent runs may share a type (sinks coalesce as
 * they like).
 */
export function tokenizeLua(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let prevFunction = false;
  let dot = false;

  const setPrev = (type: string, word?: string): void => {
    if (type === "operator") {
      dot = word === "." || word === ":";
    } else {
      dot = false;
    }
    prevFunction = type === "keyword" && word === "function";
  };

  while (i < n) {
    const c = text[i]!;
    if (isWs(c)) {
      let j = i;
      while (j < n && isWs(text[j])) j++;
      push("default", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      const lb = longBracketEnd(text, i + 2);
      if (lb !== -1) {
        push("comment", text.slice(i, lb));
        i = lb;
        setPrev("comment");
        continue;
      }
      let j = i + 2;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      push("comment", text.slice(i, j));
      i = j;
      setPrev("comment");
      continue;
    }
    if (c === '"' || c === "'") {
      const end = endOfString(text, i);
      push("string", text.slice(i, end));
      i = end;
      setPrev("string");
      continue;
    }
    if (c === "[") {
      const lb = longBracketEnd(text, i);
      if (lb !== -1) {
        push("string", text.slice(i, lb));
        i = lb;
        setPrev("string");
        continue;
      }
    }
    if ((c === "+" || c === "-") && text[i + 1] !== undefined && /[0-9]/.test(text[i + 1]!)) {
      const end = scanNumber(text, i);
      const word = text.slice(i, end);
      push(NUM_OK_RE.test(word) ? "number" : "default", word);
      i = end;
      setPrev("number");
      continue;
    }
    if (isNumberStart(c, text[i + 1])) {
      const end = scanNumber(text, i);
      const word = text.slice(i, end);
      push(NUM_OK_RE.test(word) ? "number" : "default", word);
      i = end;
      setPrev("number");
      continue;
    }
    if (NAME_START_RE.test(c)) {
      let j = i;
      while (j < n && NAME_RE.test(text[j]!)) j++;
      const word = text.slice(i, j);
      const type = classifyIdent(text, word, j, prevFunction, dot);
      push(type, word);
      i = j;
      setPrev(type, word);
      continue;
    }
    if (c === "." && text[i + 1] === "." && text[i + 2] === ".") {
      push("operator", "...");
      i += 3;
      setPrev("operator");
      continue;
    }
    if (c === "." && text[i + 1] === ".") {
      push("operator", "..");
      i += 2;
      setPrev("operator");
      continue;
    }
    if (
      text.startsWith("<=", i) ||
      text.startsWith(">=", i) ||
      text.startsWith("==", i) ||
      text.startsWith("~=", i)
    ) {
      push("operator", text.slice(i, i + 2));
      i += 2;
      setPrev("operator");
      continue;
    }
    if (OPERATOR_RE.test(c)) {
      push("operator", c);
      i++;
      setPrev("operator", c);
      continue;
    }
    push("default", c);
    i++;
    setPrev("default");
  }
  return runs;
}

function longBracketEnd(text: string, from: number): number {
  if (text[from] !== "[") return -1;
  let j = from + 1;
  while (j < text.length && text[j] === "=") j++;
  if (text[j] !== "[") return -1;
  const level = j - (from + 1);
  const closer = "]" + "=".repeat(level) + "]";
  const end = text.indexOf(closer, j + 1);
  return end === -1 ? text.length : end + closer.length;
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

function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  if (text[i] === "+" || text[i] === "-") i++;
  if (text[i] === "0" && /[xX]/.test(text[i + 1] ?? "")) {
    i += 2;
    while (i < n && /[0-9a-fA-F]/.test(text[i]!)) i++;
    if (text[i] === ".") {
      i++;
      while (i < n && /[0-9a-fA-F]/.test(text[i]!)) i++;
    }
    if (text[i] === "p" || text[i] === "P") {
      let j = i + 1;
      if (text[j] === "+" || text[j] === "-") j++;
      if (/[0-9]/.test(text[j] ?? "")) {
        i = j;
        while (i < n && /[0-9]/.test(text[i]!)) i++;
      }
    }
    return i;
  }
  while (i < n && /[0-9]/.test(text[i]!)) i++;
  if (text[i] === ".") {
    i++;
    while (i < n && /[0-9]/.test(text[i]!)) i++;
  }
  if (text[i] === "e" || text[i] === "E") {
    let j = i + 1;
    if (text[j] === "+" || text[j] === "-") j++;
    if (/[0-9]/.test(text[j] ?? "")) {
      i = j;
      while (i < n && /[0-9]/.test(text[i]!)) i++;
    }
  }
  return i;
}

function classifyIdent(text: string, word: string, after: number, prevFunction: boolean, dot: boolean): string {
  if (!dot) {
    if (word === "true" || word === "false") return "boolean";
    if (word === "nil") return "null";
    if (KEYWORDS.has(word)) return "keyword";
  }
  if (prevFunction || text[skipWs(text, after)] === "(") return "fn";
  return "default";
}

const skipWs = (text: string, from: number): number => {
  let j = from;
  while (j < text.length && isWs(text[j])) j++;
  return j;
};

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const isNumberStart = (c: string, next: string | undefined): boolean =>
  /[0-9]/.test(c) || (c === "." && next !== undefined && /[0-9]/.test(next));

const NAME_START_RE = /[A-Za-z_]/;
const NAME_RE = /[\w]/;
const OPERATOR_RE = /[+\-*/%^#(){}[\];:,.~=<>]/;
const NUM_OK_RE =
  /^[+-]?(?:0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/;

const KEYWORDS = new Set([
  "and",
  "break",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "goto",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while",
]);

/** The registry entry for this lang (assembly list: index.ts). */
export const LUA_SYNTAX: SyntaxDef = {
  lang: "lua",
  tokenize: tokenizeLua,
  aliases: ["lua"],
  extensions: ["lua"],
};
