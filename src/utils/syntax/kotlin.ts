import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Kotlin tokenizer.
 *
 * One pass over code (the java.ts family, which it mirrors closely):
 * `//` opens a "comment" to EOL, and the block form runs to its closer or
 * end of input -- nested, though (the one place java.ts's plain indexOf is
 * wrong here: the Kotlin grammar nests block comments, so an inner pair
 * closed inside an outer one stays ONE comment; KDoc is just an ordinary
 * block comment). "string" is
 * the double-quoted form with escapes honored -- an unterminated literal
 * stops at the newline, a backslash before it splices the line and the
 * scan carries on to the closer or end of input (the c.ts endOfString) --
 * and interpolation `$x`/`${x}` stays inside the string run (the rust
 * format-string ruling: the holes are not parsed, so a quote inside a
 * hole closes the literal). Triple-quoted raw strings `"""..."""` are
 * real and common: they scan to the first following `"""` (or end of
 * input) with NO escape processing -- a backslash is literal there, so
 * `\"""` is a backslash followed by the closer -- which makes `"""""` (a
 * string holding one quote) read as unclosed, the documented cost of the
 * simple scan; `""` is the ordinary empty string. Char literals follow
 * the java.ts simple rule: quote, one escape (the `\uXXXX` spelling
 * included) or plain char, closer -> "string"; anything else is not a
 * literal and the quote rides default (the common typo `'''` does read as
 * one literal, lossless either way). `@` glued to a name is an annotation
 * and rides "decorator": the dotted name plus AT MOST ONE balanced paren
 * group (whitespace between name and `(` allowed; strings and comments
 * inside are skipped so their brackets cannot cut the run short; no
 * closer anywhere runs to end of input; the java arm transfers verbatim),
 * and a `@` not glued to a name rides plain default. "keyword" for the
 * reserved words CASE-SENSITIVELY (like java, unlike php), with
 * lowercase-only `true`/`false` riding "boolean" and `null` riding
 * "null"; the soft keywords that are never plausible identifiers (abs-
 * tract, catch, companion, data, enum, inline, internal, open, override,
 * private, protected, public, sealed, suspend, vararg...) are listed
 * alongside the hard ones, while accessor words (get/set/field) ride
 * default. There are NO primitive keywords: Kotlin has none, so `Int`
 * and `String` are ordinary Capitalized classes and the heuristic does
 * the work. `val`/`var` ARE hard keywords (unlike java's contextual
 * `var`), `this`/`super` ride keyword, and `it` (the implicit lambda
 * parameter) rides default. "type" is the name directly after class/
 * interface/object/typealias plus the Capitalized heuristic (`Widget`
 * reads as a class, `MAX_SIZE` stays a plain word -- the c.ts ruling);
 * generics angle brackets ride plain operators. "fn" is the name after
 * `fun` (php's prevFn shape) and any name directly before `(` (the call
 * peek survives the dot, and claims `Foo(...)` constructor calls like
 * java); trailing-lambda calls `foo { }` get no fn reading, the same
 * honest ceiling as ruby's optional parens. "number" for decimal/hex/
 * binary (NO octal EVER -- not even legacy, so `0777` is a plain decimal
 * like C#) with `_` separators, floats with exponent, and the suffix zoo
 * L/l/f/F plus Kotlin's unsigned u/U in either order with the long mark
 * (`1u`, `128uL`, `1UL`); `128ull` overconsumes nothing: the scan declines
 * the ill-formed tail and `ull` rides as a word. There is no leading-dot
 * float, so `1.2.3` reads number, dot, number and no lookalike tracking
 * exists; shape validation sends `0x`, a trailing `_`, `0b2` back to
 * default. `::` (callable references) and the safe call `?.` ARE member
 * positions and set the dot; `->` is the lambda arrow and is NOT (java's
 * ruling: `-> true` keeps its boolean); `?:` (elvis) IS one operator run,
 * as are `!!` (not-null assertion), `..` (range), `==`, `!=`, `<=`, `>=`,
 * `&&`, `||`, and the three-char `===`/`!==` identity pair. `..<`, `=>`,
 * `??` and `...` are NOT operator runs here (the exclusive-range spelling
 * stays two runs; the rest degrade to singles). Nothing is ever dropped
 * or reordered: concatenating every run reproduces the input exactly, for
 * any input. One run per token; adjacent runs may share a type (sinks
 * coalesce as they like). This is display candy, not a Kotlin parser.
 */
export function tokenizeKotlin(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let dot = false; // the previous token was `.` or `::` (NOT `->`: lambda)
  let prevDecl = false; // the previous token was class/interface/object/typealias
  let prevFn = false; // the previous token was the `fun` keyword

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
      setPrev("comment");
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = endOfBlockComment(text, i);
      push("comment", text.slice(i, end));
      i = end;
      setPrev("comment");
      continue;
    }
    if (c === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
      const end = endOfRawString(text, i);
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
    if (c === "@" && IDENT_START_RE.test(text[i + 1] ?? "")) {
      const end = endOfAnnotation(text, i);
      push("decorator", text.slice(i, end));
      i = end;
      setPrev("decorator");
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
    const three = text.slice(i, i + 3);
    if (three === "===" || three === "!==") {
      push("operator", three);
      i += 3;
      setPrev("operator");
      dot = false; // identity comparisons are not member gestures
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push("operator", two);
      i += 2;
      setPrev("operator");
      dot = two === "::" || two === "?."; // callable refs and safe calls ARE member positions
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
    if (type !== "operator") dot = false;
    prevDecl = word !== undefined && DECL_KW.has(word);
    prevFn = word !== undefined && word === "fun";
  }

  /** Booleans/null (lowercase only, the language is case-sensitive) ->
   * keywords (case-sensitive) -> the name after class/interface/... -> the
   * name after `fun` -> fn (name before `(`, the peek surviving the dot)
   * -> Capitalized type. After a dot, every reading but the call peek is
   * refused. */
  function classifyIdent(word: string, after: number): string {
    if (!dot) {
      if (word === "true" || word === "false") return "boolean";
      if (word === "null") return "null";
      if (KEYWORDS.has(word)) return "keyword";
      if (prevDecl) return "type";
      if (prevFn) return "fn";
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

/** `class`/`interface`/`object`/`typealias` (exact case): the name right
 * after one is a "type". (`enum class` and `annotation class` land on the
 * `class` word anyway.) */
const DECL_KW = new Set(["class", "interface", "object", "typealias"]);

/** Block comment from `/*`: NESTED (unlike java/cs -- the Kotlin grammar
 * nests them), so a depth count runs to the closer that matches the
 * opener; no matching closer anywhere runs to the end of input. */
function endOfBlockComment(text: string, from: number): number {
  let j = from + 2;
  let depth = 1;
  while (j < text.length) {
    if (text.startsWith("/*", j)) {
      depth++;
      j += 2;
    } else if (text.startsWith("*/", j)) {
      depth--;
      j += 2;
      if (depth === 0) return j;
    } else {
      j++;
    }
  }
  return text.length;
}

/** Interpreted strings: escapes honored, an unterminated literal stops
 * before an unescaped newline -- but a backslash before that newline
 * splices the line and the scan carries on to the closer or end of input
 * (the c.ts/js family). Interpolation (`$x`, `${x}`) rides the string run
 * -- the rust format-string ruling: the holes are not parsed. */
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

/** Raw string `"""..."""` from the opener: NO escape processing (a
 * backslash is literal, so `\"""` is backslash-plus-closer); runs to the
 * FIRST following triple-quote or end of input (the documented cost: a
 * string whose content ends in a quote wants the doubled spellings the
 * language itself requires). Interpolation stays inside the run. */
function endOfRawString(text: string, from: number): number {
  const end = text.indexOf('"""', from + 3);
  return end === -1 ? text.length : end + 3;
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

/** `@Name`/`@a.b.Name` plus AT MOST ONE balanced paren group (the group
 * may sit behind whitespace, as the grammar allows): strings and comments
 * inside the group are skipped so their brackets cannot cut the run short;
 * no closer anywhere runs to the end of input. The java arm, verbatim:
 * kotlin annotations are the same spelling. */
function endOfAnnotation(text: string, from: number): number {
  let j = from + 1; // spend the `@`
  while (j < text.length && (IDENT_RE.test(text[j]!) || text[j] === ".")) j++;
  let k = skipWs(text, j);
  if (text[k] !== "(") return j;
  let depth = 0;
  while (k < text.length) {
    const d = text[k]!;
    if (d === "(") {
      depth++;
      k++;
    } else if (d === ")") {
      depth--;
      k++;
      if (depth === 0) return k;
    } else if (d === '"') {
      k = endOfString(text, k);
    } else if (d === "'") {
      const end = endOfCharLiteral(text, k);
      k = end === -1 ? k + 1 : end;
    } else if (d === "/" && text[k + 1] === "/") {
      while (k < text.length && text[k] !== "\n" && text[k] !== "\r") k++;
    } else if (d === "/" && text[k + 1] === "*") {
      k = endOfBlockComment(text, k);
    } else k++;
  }
  return text.length;
}

const IDENT_START_RE = /[A-Za-z_\u00a0-\uffff]/;
const IDENT_RE = /[\w\u00a0-\uffff]/;
const OPERATOR_RE = /[{}()[\];,.:?+\-*/%&|^!~=<>]/;

/** Two-char operators. `=>`, `??`, `...` and `..<` are deliberately
 * absent: kotlin has no such operator run (the exclusive range from 1.9
 * is a stdlib gesture, not a lexer token worth chasing), and the
 * sequences scan as single-char operators. `?.` and `::` ARE member
 * positions; `->` (the lambda arrow) is not; `?:` is the elvis. */
const TWO_CHAR_OPS = new Set(["::", "?.", "?:", "!!", "->", "==", "!=", "<=", ">=", "&&", "||", ".."]);

/** Capitalized name (`Widget`, `Thing2`), NOT an all-caps constant
 * (`MAX_SIZE`) and not a mixed-case name (`GtkWidget`) -- the c.ts
 * typedef heuristic. */
const CAPITALIZED_RE = /^[A-Z][a-z0-9_]*$/;

/** The numeric dialect: hex/binary with `_` separators and plain decimal
 * -- NO octal form in any spelling (kotlin `0777` is an ordinary decimal,
 * like C#), no leading-dot float -- floats with exponent, and the suffix
 * zoo L/l/f/F plus the unsigned u/U (either order with the long mark:
 * `1u`, `128uL`, `1UL`). Validation sends `0x`, `1_`, `0b2` back to
 * default; an ill-formed tail like `128ull` leaves `ull` as a word. */
const NUM_OK_RE =
  /^(?:0[xX][0-9a-fA-F](?:[0-9a-fA-F_]*[0-9a-fA-F])?|0[bB][01](?:[01_]*[01])?|\d(?:[\d_]*\d)?(?:\.\d(?:[\d_]*\d)?)?(?:[eE][+-]?\d(?:[\d_]*\d)?)?)(?:[uU][lL]?|[lL][uU]?|[fF])?$/;

const isNumberStart = (c: string): boolean => /[0-9]/.test(c);

const NUM_SUFFIX_RE = /^(?:[uU][lL]?|[lL][uU]?|[fF])(?![\w])/;

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

/** The reserved words (exact case -- kotlin keywords are case-sensitive,
 * like java), minus true/false/null which ride boolean/null. The hard set
 * (val, var, fun, object, when, ...) plus the soft keywords that are
 * practically never identifiers; the accessor words (get, set, field,
 * file, get/set-param) ride default, and `it` is not a keyword at all.
 * `typeof` is reserved-but-unused (like java's `const`/`goto`). */
const KEYWORDS: ReadonlySet<string> = new Set([
  "abstract",
  "actual",
  "annotation",
  "as",
  "break",
  "by",
  "catch",
  "class",
  "companion",
  "const",
  "continue",
  "crossinline",
  "data",
  "do",
  "dynamic",
  "else",
  "enum",
  "expect",
  "external",
  "final",
  "finally",
  "for",
  "fun",
  "if",
  "import",
  "in",
  "infix",
  "init",
  "inline",
  "inner",
  "interface",
  "internal",
  "is",
  "lateinit",
  "noinline",
  "object",
  "open",
  "operator",
  "out",
  "override",
  "package",
  "private",
  "protected",
  "public",
  "reified",
  "return",
  "sealed",
  "super",
  "suspend",
  "tailrec",
  "this",
  "throw",
  "try",
  "typealias",
  "typeof",
  "val",
  "var",
  "vararg",
  "when",
  "where",
  "while",
]);

/** The registry entry for this lang (assembly list: index.ts). No
 * aliases: the canonical name is the fence word. `.kts` (script, Gradle
 * Kotlin DSL) rides the same scanner; `.ktm`, `.kotlinx` and friends are
 * NOT claimed (the house rule keeps the list minimal). */
export const KOTLIN_SYNTAX: SyntaxDef = {
  lang: "kotlin",
  tokenize: tokenizeKotlin,
  extensions: ["kt", "kts"],
};
