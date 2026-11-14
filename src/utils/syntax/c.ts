import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * C tokenizer.
 *
 * The shared scan of the C family: cpp.ts grew from this file and carries
 * the C++ spellings now (cc/cpp/cxx/hpp/hh/hxx/ipp). `.h` stays HERE, the
 * honest ruling of the re-split: a header's dialect (C or C++) is
 * undecidable display-wise, and this scanner reads a C++ header honestly
 * enough either way.
 *
 * One pass over code: a line-leading `#` (past any indentation) is one
 * "preproc" run through the line end -- C has no `#` comment, so the
 * directives (#include, #define, #ifdef) read whole, trailing comment or
 * angle-bracket header included; no macro-expression parsing, and a
 * directive whose backslash continuation carries it to the next physical
 * line just stops there (the continuation tail re-tokenizes on its own,
 * the line-wise family). `//` opens a "comment" to EOL and the block form
 * runs to its closer or end of input (never nested, the language is not
 * either); "string" covers both quote forms -- char literals ride the same
 * scan, display has no need of a class of their own -- with the wide prefixes
 * L/u8/u/U glued to the opening quote joining the run, escapes honored, an
 * unterminated literal stopping at the newline, and a backslash before it
 * splicing past (the line-splice keeps scanning to the closer or end of
 * input, like the js family); "number" for hex/binary/octal/decimal and
 * floats with exponent and the u/l/ll/f suffixes (C octal `07` is a legal
 * literal here -- the json.ts distrust list is json's, not C's -- while a
 * lookalike like `1.2.3` rides "default"; the C++14 `'` digit separators
 * and hex floats degrade); "keyword" for the reserved words (struct/union/
 * enum are keywords, and the name directly after them is a "type"); "type"
 * for the primitive keywords, that struct/union/enum name, and Capitalized
 * names (`Widget` reads as a typedef, `MAX_SIZE` stays a plain word); "fn"
 * for any name directly before `(`; `->` is one "operator" run; the rest
 * of the punctuation is "operator"; everything else "default". After a `.`
 * or `->`, the keyword and type readings are refused (a member name rides
 * default or the call reading). Honest limits: a colon glued to a word
 * (bitfield, label) gets no "key" reading; `bool`/`size_t` (the stdbool/
 * stddef typedefs) are plain words; a `#` at the start of a line inside a
 * multi-line block comment reads as a directive when the file view
 * tokenizes that line alone. Nothing is ever dropped or reordered:
 * concatenating every run reproduces the input exactly, for any input.
 * One run per token; adjacent runs may share a type (sinks coalesce as
 * they like). This is display candy, not a C parser.
 */
export function tokenizeC(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let lineStart = true; // nothing significant pushed since the last newline
  let dot = false; // the previous token was `.` or `->`
  let prevDecl = false; // the previous token was struct/union/enum
  let prevType: string | undefined;

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
      if (sawNewline) lineStart = true; // a newline arms the next directive; spaces never spend it
      continue;
    }
    if (c === "#" && lineStart) {
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      push("preproc", text.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      push("comment", text.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      push("comment", text.slice(i, j));
      i = j;
      lineStart = false;
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
      // A wide-string prefix glued to an opening quote (`L"wide"`,
      // `u8"utf8"`): the prefix joins the string run.
      if ((text[j] === '"' || text[j] === "'") && STRING_PREFIXES.has(text.slice(i, j))) {
        const end = endOfString(text, j);
        push("string", text.slice(i, end));
        i = end;
        setPrev("string");
        continue;
      }
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
    if (c === "-" && text[i + 1] === ">") {
      push("operator", "->");
      i += 2;
      setPrev("operator");
      dot = true; // a member access: `p->next` is not the word `next` of any class
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
    lineStart = false; // any significant token spends the directive arm
    if (type !== "operator") dot = false;
    prevDecl = word !== undefined && DECL_KW.has(word);
  }

  /** Primitives -> keywords -> the name after struct/union/enum -> fn
   * (name before `(`) -> Capitalized type. After a dot, every reading but
   * the call peek is refused. */
  function classifyIdent(word: string, after: number): string {
    if (!dot) {
      if (PRIMITIVES.has(word)) return "type";
      if (KEYWORDS.has(word)) return "keyword";
      if (prevDecl) return "type";
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

/** `struct`/`union`/`enum`: the name right after one is a "type". */
const DECL_KW = new Set(["struct", "union", "enum"]);

/** String and char literals (one scan, one class): escapes honored, an
 * unterminated literal stops before an unescaped newline -- but a backslash
 * before that newline splices the line, so the scan carries on to the
 * closer or end of input (the js/python family). */
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

/** Prefixes glued to an opening quote (case-sensitive per the standard). */
const STRING_PREFIXES = new Set(["L", "u", "U", "u8"]);

/** Capitalized name (`Widget`, `Thing2`), NOT an all-caps macro constant
 * (`MAX_SIZE`) and not a mixed-prefix name (`GtkWidget`) -- the honest
 * typedef heuristic. */
const CAPITALIZED_RE = /^[A-Z][a-z0-9_]*$/;

/** The numeric dialect: radix forms, octal (legal here, distrusted in
 * json), floats with exponent, and the suffix zoo. Shape validation at the
 * call site sends `0x`, `1e`-tails and lookalikes back to default. */
const NUM_OK_RE =
  /^(?:0[xX][0-9a-fA-F]+[uUlL]*|0[bB][01]+[uUlL]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[fFuUlL]*)$/;

const isNumberStart = (c: string, next: string | undefined): boolean =>
  /[0-9]/.test(c) || (c === "." && next !== undefined && /[0-9]/.test(next));

function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  if (text[i] === "0" && /[xXbB]/.test(text[i + 1] ?? "")) {
    i += 2;
    while (i < n && /[0-9a-fA-F]/.test(text[i]!)) i++;
    while (i < n && /[uUlL]/.test(text[i]!)) i++;
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
  while (i < n && /[fFuUlL]/.test(text[i]!)) i++;
  return i;
}

/** Primitive keywords ride "type" (the ts batch's class). `bool`/`size_t`
 * are stdbool/stddef typedefs, not keywords -- plain words here. */
const PRIMITIVES: ReadonlySet<string> = new Set([
  "char",
  "double",
  "float",
  "int",
  "long",
  "short",
  "signed",
  "unsigned",
  "void",
  "_Bool",
]);

/** The reserved words (struct/union/enum included; the name after them is
 * what the DECL_KW peek looks for). */
const KEYWORDS: ReadonlySet<string> = new Set([
  "auto",
  "break",
  "case",
  "const",
  "continue",
  "default",
  "do",
  "else",
  "enum",
  "extern",
  "for",
  "goto",
  "register",
  "restrict",
  "return",
  "sizeof",
  "static",
  "struct",
  "switch",
  "typedef",
  "union",
  "volatile",
  "while",
]);

/** The registry entry for this lang (assembly list: index.ts). The C++
 * spellings (cc/cpp/cxx/hpp/hh/hxx/ipp) belong to the cpp def since the
 * re-split; this list is C plus `.h` -- whose dialect is undecidable
 * display-wise (see cpp.ts, documented in both places) -- and CUDA and
 * the shading dialects, which are C-shaped enough that the c scanner is
 * the honest display for them (no per-dialect parsing -- the documented
 * ceiling: `__global`, `varying` etc. ride plain words). */
export const C_SYNTAX: SyntaxDef = {
  lang: "c",
  tokenize: tokenizeC,
  extensions: ["c", "h", "cu", "cuh", "glsl", "hlsl"],
};
