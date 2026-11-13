import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Go tokenizer.
 *
 * One pass over code (the c.ts family): `//` opens a "comment" to EOL and
 * the block form runs to its closer or end of input (Go block comments do
 * not nest, and neither does this scan); "string" covers all three forms
 * -- interpreted double quotes and rune literals share one scan with
 * escapes honored and an unterminated literal stopping at the newline
 * (backslash splicing past it, the js family), raw backtick strings run to
 * their closer or end of input with NO escape processing because Go gives
 * the backslash no power there -- and raw strings ride "string", not the
 * js "template" class, since Go interpolates nothing; "keyword" for the
 * 25 reserved words; "type" for the predeclared primitives and Capitalized
 * names (`Widget` reads as a type, `MAX_SIZE` stays a plain word -- the
 * c.ts heuristic, with its documented limit: a bare exported func used as
 * a value paints type, though the dot refusal spares selectors); "fn"
 * for any name directly before
 * `(` and for the name directly after `func`; "number" for hex/binary/
 * octal (legacy `0755` is legal here) decimals and floats with exponent
 * (`1.2.3` degrades to number plus a default `.3` tail; the `_` digit
 * separators degrade to number + identifier, the c.ts ruling); `:=`, `<-`
 * and `->` are one "operator" run each (Go never emits the arrow, but it
 * scans as one gesture for free), the rest of the punctuation is single-
 * char "operator". After a `.` or arrow, the keyword and type readings are
 * refused (a field or package-selector name rides default or the call
 * reading). Honest limits: no newline-lookahead constructs need it -- the
 * scanner is line-agnostic; imaginary literals (`3.14i`) read as number +
 * word. Nothing is ever dropped or reordered: concatenating every run
 * reproduces the input exactly, for any input. One run per token; adjacent
 * runs may share a type (sinks coalesce as they like). This is display
 * candy, not a Go parser.
 */
export function tokenizeGo(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let dot = false; // the previous token was `.` or an arrow
  let prevFunc = false; // the previous token was `func`
  let prevType: string | undefined;

  while (i < n) {
    const c = text[i]!;
    if (isWs(c)) {
      let j = i;
      while (j < n && isWs(text[j])) j++;
      push("default", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      push("comment", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      push("comment", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "`") {
      // Raw string: no escapes, runs to the closer or end of input.
      const end = text.indexOf("`", i + 1);
      const j = end === -1 ? n : end + 1;
      push("string", text.slice(i, j));
      i = j;
      setPrev("string");
      continue;
    }
    if (c === '"' || c === "'") {
      const end = endOfString(text, i);
      push("string", text.slice(i, end));
      i = end;
      setPrev("string");
      continue;
    }
    if (IDENT_START_RE.test(c)) {
      let j = i;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      const word = text.slice(i, j);
      const type = classifyIdent(word, j);
      push(type, word);
      i = j;
      setPrev(type, word);
      continue;
    }
    if (isNumberStart(c, text[i + 1])) {
      const end = scanNumber(text, i);
      const word = text.slice(i, end);
      // `.5` right after a number (`1.2.3`) is a lookalike, not a literal.
      const lookalike = c === "." && prevType === "number";
      const type = !lookalike && NUM_OK_RE.test(word) ? "number" : "default";
      push(type, word);
      i = end;
      setPrev(type);
      continue;
    }
    const twoChar = text.slice(i, i + 2);
    if (twoChar === ":=" || twoChar === "<-" || twoChar === "->") {
      push("operator", twoChar);
      i += 2;
      setPrev("operator");
      dot = twoChar === "->"; // the arrow is a member gesture; := binds a name
      continue;
    }
    if (OPERATOR_RE.test(c)) {
      push("operator", c);
      i++;
      setPrev("operator");
      dot = c === ".";
      continue;
    }
    push("default", c);
    i++;
    setPrev("default");
  }
  return runs;

  function setPrev(type: string, word?: string): void {
    prevType = type;
    if (type !== "operator") dot = false;
    prevFunc = word === "func";
  }

  /** Primitives -> keywords -> the name after func -> fn (name before `(`)
   * -> Capitalized type. After a dot, every reading but the call peek is
   * refused. */
  function classifyIdent(word: string, after: number): string {
    if (!dot) {
      if (PRIMITIVES.has(word)) return "type";
      if (KEYWORDS.has(word)) return "keyword";
      if (prevFunc) return "fn";
    }
    if (text[skipWs(text, after)] === "(") return "fn";
    if (!dot && CAPITALIZED_RE.test(word)) return "type";
    return "default";
  }
}

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

const skipWs = (text: string, from: number): number => {
  let j = from;
  while (j < text.length && isWs(text[j])) j++;
  return j;
};

/** Interpreted string and rune literals (one scan, one class): escapes
 * honored, an unterminated literal stops before an unescaped newline --
 * but a backslash before that newline splices the line (the c.ts/js
 * family). Raw backtick strings never reach this scan. */
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

const IDENT_START_RE = /[A-Za-z_\u00a0-\uffff]/;
const IDENT_RE = /[\w\u00a0-\uffff]/;
const OPERATOR_RE = /[{}()[\];,.:?+\-*/%&|^!~=<>]/;

/** Capitalized name (`Widget`, `Thing2`), NOT an all-caps constant
 * (`MAX_SIZE`) and not a mixed-prefix name (`myThing`) -- the c.ts
 * typedef heuristic with its documented exported-func-as-value miss. */
const CAPITALIZED_RE = /^[A-Z][a-z0-9_]*$/;

/** Radix forms (0x/0b/0o plus the legacy leading-zero octal), floats with
 * exponent. Underscore separators are not scanned into the literal, so
 * `1_000` rides number + identifier (the documented degradation). */
const NUM_OK_RE =
  /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/;

const isNumberStart = (c: string, next: string | undefined): boolean =>
  /[0-9]/.test(c) || (c === "." && next !== undefined && /[0-9]/.test(next));

function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  if (text[i] === "0" && /[xXbBoO]/.test(text[i + 1] ?? "")) {
    i += 2;
    while (i < n && /[0-9a-fA-F]/.test(text[i]!)) i++;
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

/** The predeclared types ride "type" (the ts/c class). `any` and
 * `comparable` are predeclared type identifiers too. */
const PRIMITIVES: ReadonlySet<string> = new Set([
  "any",
  "bool",
  "byte",
  "comparable",
  "complex64",
  "complex128",
  "error",
  "float32",
  "float64",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "rune",
  "string",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uintptr",
]);

/** The 25 reserved words (a reserved word can never be an identifier). */
const KEYWORDS: ReadonlySet<string> = new Set([
  "break",
  "case",
  "chan",
  "const",
  "continue",
  "default",
  "defer",
  "else",
  "fallthrough",
  "for",
  "func",
  "go",
  "goto",
  "if",
  "import",
  "interface",
  "map",
  "package",
  "range",
  "return",
  "select",
  "struct",
  "switch",
  "type",
  "var",
]);

/** The registry entry for this lang (assembly list: index.ts). */
export const GO_SYNTAX: SyntaxDef = {
  lang: "go",
  tokenize: tokenizeGo,
  extensions: ["go"],
};
