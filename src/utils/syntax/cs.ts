import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * C# tokenizer.
 *
 * One pass over code (the java.ts family, which it mirrors closely):
 * `//` opens a "comment" to EOL and the block form runs to its closer or
 * end of input, NEVER nested (the language is not); XML doc comments are
 * just ordinary block comments. "string" is rich here: double-quoted
 * literals with escapes honored (unterminated stops at the newline, a
 * backslash before it splices the line, the c.ts endOfString); interpolated
 * `$"...{x}..."` literals stay ONE string run with the holes riding inside
 * (the rust format-string ruling -- the holes are not parsed, so a quote
 * inside a hole closes the literal, the pre-C#-11 reading); verbatim
 * `@"..."` literals take NO escape processing (the only escape is the
 * doubled `""`) and run across newlines to their closer or end of input;
 * and the combined `$@"..."`/`@$"..."` spellings ride the verbatim scan
 * with the interpolation braces inside the run. Char literals follow the
 * java.ts simple rule: quote, one escape (the `\uXXXX` spelling included)
 * or plain char, closer -> "string"; anything else is not a literal and
 * the quote rides default. `[Name(...)]` is the attribute form, and the
 * honest part is the ARRMS: `[` opens a "decorator" run only where an
 * attribute can legally begin (start of input, after a newline, `;`, `{`
 * or `}`, or immediately after another attribute -- attributes stack) AND
 * when glued to a name; balanced to the matching `]` with strings and
 * comments skipped so their brackets cannot cut the run short, no closer
 * anywhere runs to end of input. Every other `[` is the plain array-index
 * operator it usually is: `x[0]` after a word, `Foo[]` after a type name,
 * `arr[i][j]`; a `[` at an armed position that is NOT glued to a name is
 * plain too (a collection-expression `[1, 2, 3]` after `=`, a stray
 * `[key]`), so no lookahead state is invented. The documented cost: a
 * line-leading `[key]` that indexes the PREVIOUS line's expression (legal
 * but uncanny C#) washes as an attribute. "keyword" for the reserved
 * words CASE-SENSITIVELY (like java, unlike php), with lowercase-only
 * `true`/`false` riding "boolean" and `null` riding "null"; the
 * contextual words -- var, dynamic, async, await, nameof, yield, partial,
 * get/set, value, required, file -- ride default (`nameof(` simply takes
 * the call peek as fn, honestly). "type" for the primitive keywords (int,
 * long, short, byte, float, double, decimal, bool, char, string, object,
 * void and the unsigned family -- note the `bool`/`string` spellings,
 * unlike java), the name directly after class/interface/enum/record/
 * struct/namespace, and Capitalized names (`Widget` reads as a class,
 * `MAX_SIZE` stays a plain word -- the c.ts heuristic); generics angle
 * brackets ride plain operators. "fn" for any name directly before `(`
 * (the peek survives the dot); in `class Foo` the declaration arm claims
 * the name as "type" before the peek sees it, so a constructor
 * declaration `public Foo(...)` reads "fn" exactly like a `Widget(...)`
 * call. `.` and the null-conditional `?.` and the alias qualifier `::`
 * are member positions and set the dot flag (so `x?.ToString` keeps its
 * call peek while `x?.true` refuses the boolean reading); `->` (pointer
 * member access, unsafe code) is one "operator" run and also a member
 * position. `=>`, `??=`, `?.=` and `..` are NOT operator runs here (they
 * degrade to singles -- `=>` is equals-then-greater, no fat arrow run),
 * while `??` (null-coalescing), `==`, `!=`, `<=`, `>=`, `&&`, `||` are
 * one run each; the rest is single-char "operator", and the nullable
 * marker `T?` rides that plain `?`. "number" for decimal/hex/binary with
 * `_` separators (NO octal spelling in C# -- the legacy `0NNN` is NOT
 * octal, so `0777` is an ordinary decimal and `0o7` reads as the number
 * `0` plus the word `o7`), floats with exponent (no leading-dot float:
 * `.5` is a dot operator plus a number, so the c.ts lookalike rule is
 * unnecessary and `1.2.3` reads number, dot, number) and the suffix zoo
 * u/U/l/L/ul/UL/f/F/m/M/d/D; shape validation sends the half-literals
 * (`0x`, a trailing `_`) back to default. `$` is not an identifier char
 * here (unlike java): a lone `$` is not a string prefix and rides
 * default; verbatim identifiers (`@class`) degrade to a default `@` plus
 * the ordinary word scan. Nothing is ever dropped or reordered:
 * concatenating every run reproduces the input exactly, for any input.
 * One run per token; adjacent runs may share a type (sinks coalesce as
 * they like). This is display candy, not a C# parser.
 */
export function tokenizeCs(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let dot = false; // the previous token was `.`, `?.`, `::` or `->`
  let prevDecl = false; // the previous token was class/interface/enum/record/struct/namespace
  let prevAttr = true; // an attribute may legally begin here (start/newline/;/}/{/after an attribute)

  while (i < n) {
    const c = text[i]!;
    if (isWs(c)) {
      let j = i;
      let sawNewline = false;
      while (j < n && isWs(text[j])) {
        if (text[j] === "\n" || text[j] === "\r") sawNewline = true;
        j++;
      }
      push("default", text.slice(i, j));
      i = j;
      if (sawNewline) prevAttr = true; // a newline arms the attribute reading; spaces never spend it
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      push("comment", text.slice(i, j));
      i = j;
      setPrev("comment");
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      push("comment", text.slice(i, j));
      i = j;
      setPrev("comment");
      continue;
    }
    if (c === "@" && text[i + 1] === '"') {
      const end = endOfVerbatim(text, i + 1);
      push("string", text.slice(i, end));
      i = end;
      setPrev("string");
      continue;
    }
    if (c === "$" && (text[i + 1] === '"' || (text[i + 1] === "@" && text[i + 2] === '"'))) {
      const verbatim = text[i + 1] === "@";
      const quote = verbatim ? i + 2 : i + 1;
      const end = verbatim ? endOfVerbatim(text, quote) : endOfString(text, quote);
      push("string", text.slice(i, end));
      i = end;
      setPrev("string");
      continue;
    }
    if (c === "@" && text[i + 1] === "$" && text[i + 2] === '"') {
      const end = endOfVerbatim(text, i + 2);
      push("string", text.slice(i, end));
      i = end;
      setPrev("string");
      continue;
    }
    if (c === '"') {
      const end = endOfString(text, i);
      push("string", text.slice(i, end));
      i = end;
      setPrev("string");
      continue;
    }
    if (c === "'") {
      const end = endOfCharLiteral(text, i);
      if (end !== -1) {
        push("string", text.slice(i, end));
        i = end;
        setPrev("string");
        continue;
      }
      // not a char literal: the quote rides default below
    }
    if (c === "[" && prevAttr && IDENT_START_RE.test(text[i + 1] ?? "")) {
      const end = endOfAttribute(text, i);
      push("decorator", text.slice(i, end));
      i = end;
      setPrev("decorator"); // stacked attributes stay armed
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
    if (isNumberStart(c)) {
      const end = scanNumber(text, i);
      push(NUM_OK_RE.test(text.slice(i, end)) ? "number" : "default", text.slice(i, end));
      i = end;
      setPrev("number");
      continue;
    }
    if (c === "-" && text[i + 1] === ">") {
      push("operator", "->");
      i += 2;
      setPrev("operator", undefined, c);
      dot = true; // pointer member access (`p->x`) IS a member position (unlike java's arrow)
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push("operator", two);
      i += 2;
      setPrev("operator", undefined, c);
      dot = two === "::" || two === "?."; // null-conditional and alias refs ARE member positions
      continue;
    }
    if (OPERATOR_RE.test(c)) {
      push("operator", c);
      i++;
      setPrev("operator", undefined, c);
      dot = c === ".";
      continue;
    }
    push("default", c);
    i++;
    setPrev("default", undefined, c);
  }
  return runs;

  function setPrev(type: string, word?: string, opChar?: string): void {
    if (type !== "operator") dot = false;
    prevDecl = word !== undefined && DECL_KW.has(word);
    // `;`, `{` and `}` arm the attribute reading (with the whitespace arm's
    // newline and the decorator arm's stacking); everything else spends it.
    prevAttr = opChar !== undefined ? opChar === ";" || opChar === "{" || opChar === "}" : type === "decorator";
  }

  /** Booleans/null (lowercase only) -> primitives -> keywords (case-
   * sensitive) -> the name after class/interface/... -> fn (name before
   * `(`, the peek surviving the dot) -> Capitalized type. After a dot,
   * every reading but the call peek is refused. */
  function classifyIdent(word: string, after: number): string {
    if (!dot) {
      if (word === "true" || word === "false") return "boolean";
      if (word === "null") return "null";
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

/** `class`/`interface`/`enum`/`record`/`struct`/`namespace` (exact case):
 * the name right after one is a "type". */
const DECL_KW = new Set(["class", "interface", "enum", "record", "struct", "namespace"]);

/** Interpreted strings (interpolated ones ride the same scan -- the holes
 * stay inside the run, the rust format-string ruling): escapes honored, an
 * unterminated literal stops before an unescaped newline -- but a backslash
 * before that newline splices the line and the scan carries on to the
 * closer or end of input (the c.ts/js family). */
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

/** Verbatim `@"..."` from the opening quote: NO escape processing -- the
 * only escape is the doubled `""`; runs across newlines to the closer or
 * end of input. */
function endOfVerbatim(text: string, quoteIdx: number): number {
  let j = quoteIdx + 1;
  while (j < text.length) {
    if (text[j] === '"') {
      if (text[j + 1] === '"') {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return text.length;
}

/** Char literal: exactly one character or escape (the `\uXXXX` form
 * included) between the quotes. Returns the end index, or -1 when the
 * shape fails -- the caller then lets the quote ride default. */
function endOfCharLiteral(text: string, from: number): number {
  let j = from + 1;
  if (text[j] === "\\") {
    if (text[j + 1] === "u") {
      let k = j + 2;
      while (k < text.length && k < j + 6 && /[0-9a-fA-F]/.test(text[k]!)) k++;
      j = k;
    } else {
      j += 2;
    }
  } else {
    j++;
  }
  return text[j] === "'" ? j + 1 : -1;
}

/** `[Name(...)]` through the bracket-balanced closer: strings (verbatim and
 * interpolated spellings included) and comments inside are skipped so
 * their brackets cannot cut the run short; no closer anywhere runs to the
 * end of input. Only reached at an armed position -- this scan is
 * position-blind. */
function endOfAttribute(text: string, from: number): number {
  let j = from;
  let depth = 0;
  while (j < text.length) {
    const d = text[j]!;
    if (d === "[") {
      depth++;
      j++;
    } else if (d === "]") {
      depth--;
      j++;
      if (depth === 0) return j;
    } else if (d === "@" && text[j + 1] === '"') {
      j = endOfVerbatim(text, j + 1);
    } else if (d === "$" && text[j + 1] === '"') {
      j = endOfString(text, j + 1);
    } else if ((d === "$" && text[j + 1] === "@" && text[j + 2] === '"') || (d === "@" && text[j + 1] === "$" && text[j + 2] === '"')) {
      j = endOfVerbatim(text, j + 2);
    } else if (d === '"') {
      j = endOfString(text, j);
    } else if (d === "'") {
      const end = endOfCharLiteral(text, j);
      j = end === -1 ? j + 1 : end;
    } else if (d === "/" && text[j + 1] === "/") {
      while (j < text.length && text[j] !== "\n" && text[j] !== "\r") j++;
    } else if (d === "/" && text[j + 1] === "*") {
      const end = text.indexOf("*/", j + 2);
      j = end === -1 ? text.length : end + 2;
    } else j++;
  }
  return text.length;
}

const IDENT_START_RE = /[A-Za-z_\u00a0-\uffff]/;
const IDENT_RE = /[\w\u00a0-\uffff]/;
const OPERATOR_RE = /[{}()[\];,.:?+\-*/%&|^!~=<>]/;

/** Two-char operators. `=>` (equals-then-greater: no fat arrow run),
 * `??=`, `?.=` and `..` are deliberately absent. `?.` IS a member
 * position; `?:` is NOT an operator here (there is no elvis in C#). */
const TWO_CHAR_OPS = new Set(["::", "?.", "??", "==", "!=", "<=", ">=", "&&", "||"]);

/** Capitalized name (`Widget`, `Thing2`), NOT an all-caps constant
 * (`MAX_SIZE`) and not a mixed-case name (`GtkWidget`) -- the c.ts
 * typedef heuristic. */
const CAPITALIZED_RE = /^[A-Z][a-z0-9_]*$/;

/** The numeric dialect: hex/binary with `_` separators and decimals --
 * NO octal form (C# `0777` is plain decimal), no leading-dot float --
 * floats with exponent, and the u/U/l/L/ul/UL/f/F/m/M/d/D suffix zoo.
 * Validation sends `0x`, `1_` back to default. */
const NUM_OK_RE =
  /^(?:0[xX][0-9a-fA-F](?:[0-9a-fA-F_]*[0-9a-fA-F])?|0[bB][01](?:[01_]*[01])?|\d(?:[\d_]*\d)?(?:\.\d(?:[\d_]*\d)?)?(?:[eE][+-]?\d(?:[\d_]*\d)?)?)(?:[uU][lL]?|[lL][uU]?|[fFdDmM])?$/;

const isNumberStart = (c: string): boolean => /[0-9]/.test(c);

const NUM_SUFFIX_RE = /^(?:[uU][lL]?|[lL][uU]?|[fFdDmM])(?![\w])/;

function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  if (text[i] === "0" && /[xXbB]/.test(text[i + 1] ?? "")) {
    i += 2;
    while (i < n && /[0-9a-fA-F_]/.test(text[i]!)) i++;
  } else {
    while (i < n && /[0-9_]/.test(text[i]!)) i++;
    if (text[i] === "." && /[0-9_]/.test(text[i + 1] ?? "")) {
      i++;
      while (i < n && /[0-9_]/.test(text[i]!)) i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      let j = i + 1;
      if (text[j] === "+" || text[j] === "-") j++;
      if (/[0-9]/.test(text[j] ?? "")) {
        i = j;
        while (i < n && /[0-9_]/.test(text[i]!)) i++;
      }
    }
  }
  const suffix = NUM_SUFFIX_RE.exec(text.slice(i));
  if (suffix) i += suffix[0].length;
  return i;
}

/** Primitive type keywords ride "type" (exact case); note the `bool` and
 * `string` spellings (unlike java). `var`/`dynamic` are contextual and
 * ride default. `true`/`false`/`null` are handled separately. */
const PRIMITIVES: ReadonlySet<string> = new Set([
  "bool",
  "byte",
  "char",
  "decimal",
  "double",
  "float",
  "int",
  "long",
  "nint",
  "nuint",
  "object",
  "sbyte",
  "short",
  "string",
  "uint",
  "ulong",
  "ushort",
  "void",
]);

/** The reserved words (exact case -- like java, unlike php), minus
 * true/false/null which ride boolean/null and the primitives which ride
 * type. The contextual keywords are deliberately NOT listed (they are
 * legal identifiers in enough places that display honesty says let them
 * ride): var, dynamic, async, await, nameof (it takes the call peek as
 * fn), yield, partial, get, set, value, required, file, when, where. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "abstract",
  "as",
  "base",
  "break",
  "case",
  "catch",
  "checked",
  "class",
  "const",
  "continue",
  "default",
  "delegate",
  "do",
  "else",
  "enum",
  "event",
  "explicit",
  "extern",
  "finally",
  "fixed",
  "for",
  "foreach",
  "goto",
  "if",
  "implicit",
  "in",
  "interface",
  "internal",
  "is",
  "lock",
  "namespace",
  "new",
  "operator",
  "out",
  "override",
  "params",
  "private",
  "protected",
  "public",
  "readonly",
  "record",
  "ref",
  "return",
  "sealed",
  "sizeof",
  "stackalloc",
  "static",
  "struct",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "unchecked",
  "unsafe",
  "using",
  "virtual",
  "volatile",
  "while",
]);

/** The registry entry for this lang (assembly list: index.ts). No
 * aliases: the canonical name is the fence word (markdown fences spell
 * the language `csharp`, which IS the canonical name here). `.csx`
 * (script) is NOT claimed -- the cheap-wins pass can revisit. */
export const CS_SYNTAX: SyntaxDef = {
  lang: "csharp",
  tokenize: tokenizeCs,
  extensions: ["cs"],
};
