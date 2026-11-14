import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Java tokenizer.
 *
 * One pass over code (the c.ts/rust.ts/php.ts family): there is no tag
 * delimiter here (php's openTagLen has no java analogue), `//` opens a
 * "comment" to EOL and the block form runs to its closer or end of input,
 * NEVER nested (the language is not); Javadoc is just an ordinary block
 * comment.
 * "string" is the double-quoted form with escapes honored -- an
 * unterminated literal stops at the newline, a backslash before it splices
 * the line and the scan carries on to the closer or end of input (the
 * c.ts endOfString), and text blocks (`"""`) degrade to an empty string
 * plus the ordinary scan. Char literals are the simple rule (java has no
 * lifetime for them to masquerade as, unlike rust): quote, one escape (the
 * `\uXXXX` spelling included) or plain char, closer -> "string"; anything
 * else is not a literal and the quote rides default (lossless either way;
 * the common typo `'''` does read as one literal, and a lone apostrophe in
 * a comment never reaches this arm). `@` glued to a name is an annotation
 * and rides "decorator": the dotted name plus AT MOST ONE balanced paren
 * group (whitespace between name and `(` is allowed, as the grammar is;
 * strings and comments inside are skipped so their brackets cannot cut the
 * run short; no closer anywhere runs to end of input) -- this is NOT the
 * rust/php `#[...]` bracket-balanced shape, there is no bracket arm, and a
 * `@` not glued to a name rides plain default (so `@interface Foo` reads
 * decorator + Capitalized type, and an apostrophe-free `x@Foo` mid-
 * expression washes as an annotation, the honest ceiling). "keyword" for
 * the reserved words CASE-SENSITIVELY (java keywords are case-sensitive,
 * the opposite of php: `TRUE`, `NULL` and `Class` are not keywords --
 * `Class` and `False` fall to the Capitalized reading, `TRUE`/`NULL` are
 * plain words), with lowercase-only `true`/`false` riding "boolean" and
 * `null` riding "null"; the contextual type keywords (record/sealed/
 * permits, plus yield/yields) are listed, while `var` rides default.
 * "type" for the primitive keywords (int, long, short, byte, float,
 * double, boolean, char, void), the name directly after class/interface/
 * enum/record/extends/implements, and Capitalized names (`Widget` reads as
 * a class, `MAX_SIZE` stays a plain word -- the c.ts heuristic); generics
 * angle brackets ride plain operators, nothing is parsed inside them. "fn"
 * for any name directly before `(` (the call peek survives the dot, like
 * c.ts); in `class Foo(...)` the declaration arm claims the name as "type"
 * before the peek sees it, so a constructor DECLARATION `public Foo(...)`
 * reads "fn" exactly like a `Widget(...)` call does, and `Foo::new()` reads
 * the reserved `new` as fn -- documented, honest. "number" for decimal/hex/
 * binary/octal (java octal is the legacy `0NNN` only, there is NO `0o`
 * spelling, so `0o7` reads as the number `0` plus the word `o7`, the
 * opposite of php) with PHP 7.4-style `_` separators, floats with exponent
 * and the L/l/F/f/D/d suffixes (the c.ts suffix-zoo shape); java has no
 * leading-dot float (the validation shape offers no leading-dot form, so
 * `.5` scans as a dot operator plus a number), which also means the c.ts
 * lookalike rule is unnecessary and `1.2.3` reads number, dot, number;
 * shape validation sends the half-literals (`0x`, a
 * trailing `_`, `0778`) back to default. `->`, `::`, `==`, `!=`, `<=`,
 * `>=`, `&&`, `||` and the varargs `...` are one "operator" run each, and
 * the rest of the punctuation is single-char "operator". CRITICAL: `->` is
 * the LAMBDA arrow, not member access (that is `.`), so it does NOT set
 * the dot flag -- `x -> true` keeps its boolean reading (contrast php.ts,
 * where `->` IS member access and does); `::` (method refs and static
 * access) IS a member position and does. `=>`, `??` and `..` are not java
 * operators and degrade to singles. `$` is a legal-but-cursed identifier
 * char in the language and rides plain default here, same as backticks.
 * Nothing is ever dropped or reordered: concatenating every run reproduces
 * the input exactly, for any input. One run per token; adjacent runs may
 * share a type (sinks coalesce as they like). This is display candy, not a
 * java parser.
 */
export function tokenizeJava(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let dot = false; // the previous token was `.` or `::` (NOT `->`: lambda)
  let prevDecl = false; // the previous token was class/interface/enum/record/extends/implements

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
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      push("comment", text.slice(i, j));
      i = j;
      setPrev("comment");
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
      // not a char literal: the quote rides default below (java has no
      // lifetime token to reach for, unlike rust)
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
    if (c === "-" && text[i + 1] === ">") {
      push("operator", "->");
      i += 2;
      setPrev("operator");
      dot = false; // the lambda arrow is NOT a member access (that is `.`)
      continue;
    }
    if (text.startsWith("...", i)) {
      push("operator", "...");
      i += 3;
      setPrev("operator");
      dot = false; // varargs ellipsis is not a member gesture
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push("operator", two);
      i += 2;
      setPrev("operator");
      dot = two === "::"; // a static/member reference IS a member position
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
  }

  /** Booleans/null (lowercase only, the language is case-sensitive) ->
   * primitives -> keywords (case-sensitive) -> the name after class/
   * interface/... -> fn (name before `(`, the peek surviving the dot) ->
   * Capitalized type. After a dot, every reading but the call peek is
   * refused. */
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

/** `class`/`interface`/`enum`/`record`/`extends`/`implements` (exact case,
 * the language is case-sensitive): the name right after one is a "type". */
const DECL_KW = new Set(["class", "interface", "enum", "record", "extends", "implements"]);

/** Strings: escapes honored, an unterminated literal stops before an
 * unescaped newline -- but a backslash before that newline splices the
 * line and the scan carries on to the closer or end of input (the c.ts/
 * js family). Text blocks (`"""`) open the empty string here and settle
 * into the ordinary scan. */
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

/** Char literal: exactly one character or escape (the `\uXXXX` form
 * included) between the quotes. Returns the end index, or -1 when the
 * shape fails -- the caller then lets the quote ride default (there is no
 * lifetime token in java to catch it, unlike rust). */
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
 * no closer anywhere runs to the end of input. This is not the rust/php
 * `#[...]` shape -- it starts at the `@` and only the parens balance. */
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
      const end = text.indexOf("*/", k + 2);
      k = end === -1 ? text.length : end + 2;
    } else k++;
  }
  return text.length;
}

const IDENT_START_RE = /[A-Za-z_\u00a0-\uffff]/;
const IDENT_RE = /[\w\u00a0-\uffff]/;
const OPERATOR_RE = /[{}()[\];,.:?+\-*/%&|^!~=<>]/;

/** Two-char operators. `=>`, `??` and `..` are deliberately absent: java
 * has no such operators and the sequences scan as single-char operators. */
const TWO_CHAR_OPS = new Set(["::", "==", "!=", "<=", ">=", "&&", "||"]);

/** Capitalized name (`Widget`, `Thing2`), NOT an all-caps constant
 * (`MAX_SIZE`) and not a mixed-case name (`GtkWidget`) -- the c.ts
 * typedef heuristic. */
const CAPITALIZED_RE = /^[A-Z][a-z0-9_]*$/;

/** The numeric dialect: radix forms with `_` separators, the legacy `0NNN`
 * octal (there is NO `0o` spelling in java), decimals and floats with
 * exponent, and the L/l/F/f/D/d suffixes. There is no leading-dot float
 * (`.5` is not a java literal), which also means the c.ts `1.2.3`
 * lookalike rule is unnecessary here. Validation sends `0x`, `1_` and
 * `0778` back to default. */
const NUM_OK_RE =
  /^(?:0[xX][0-9a-fA-F](?:[0-9a-fA-F_]*[0-9a-fA-F])?|0[bB][01](?:[01_]*[01])?|0[0-7](?:[0-7_]*[0-7])?|(?:0|[1-9](?:\d|_\d)*)(?:\.\d(?:[\d_]*\d)?)?(?:[eE][+-]?\d(?:[\d_]*\d)?)?)[lLfFdD]?$/;

const isNumberStart = (c: string): boolean => /[0-9]/.test(c);

const NUM_SUFFIX_RE = /^[lLfFdD](?![\w])/;

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

/** Primitive type keywords ride "type" (exact case); `var` rides default
 * (it is not a keyword, and display has no need to chase it). `true`,
 * `false` and `null` are handled separately as boolean/null. */
const PRIMITIVES: ReadonlySet<string> = new Set([
  "boolean",
  "byte",
  "char",
  "double",
  "float",
  "int",
  "long",
  "short",
  "void",
]);

/** The reserved words (exact case -- java keywords are case-sensitive),
 * minus true/false/null which ride boolean/null and the primitives which
 * ride type. `const` and `goto` are reserved-but-unused (neither can be
 * an identifier); the contextual type keywords record/sealed/permits and
 * yield/yields are listed anyway (the display win beats the rare variable
 * named `record`), while `var` stays a plain word. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "abstract",
  "assert",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "else",
  "enum",
  "extends",
  "final",
  "finally",
  "for",
  "goto",
  "if",
  "implements",
  "import",
  "instanceof",
  "interface",
  "native",
  "new",
  "package",
  "permits",
  "private",
  "protected",
  "public",
  "record",
  "return",
  "sealed",
  "static",
  "strictfp",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "transient",
  "try",
  "volatile",
  "while",
  "yield",
  "yields",
]);

/** The registry entry for this lang (assembly list: index.ts). No
 * aliases: the canonical name is the fence word. `.jsp` and `.javacc` are
 * NOT claimed (jsp is html-with-tags, javacc is its own grammar -- the
 * cheap-wins pass can revisit; the house rule keeps the list minimal). */
export const JAVA_SYNTAX: SyntaxDef = {
  lang: "java",
  tokenize: tokenizeJava,
  extensions: ["java"],
};
