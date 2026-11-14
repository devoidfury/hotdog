import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Dart tokenizer.
 *
 * One pass over code (the java.ts family, which it mirrors closely):
 * `//` opens a "comment" to EOL (dart's doc comments `///` are just this)
 * and the block form runs to its closer or end of input, NEVER nested
 * (dart does not nest them, unlike kotlin). "string" is rich here:
 * single/double quotes with escapes honored (an unterminated literal
 * stops at the newline, a backslash before it splices the line, the c.ts
 * endOfString) with interpolation `$x`/`${x}` staying inside the run (the
 * rust format-string ruling: the holes are not parsed, so a quote inside
 * a hole closes the literal); the triple-quoted `"""..."""`/`'''...'''`
 * multiline forms scan to the first following triple-quote or end of
 * input (the kotlin raw-string scan), and the raw strings `r'...'`/
 * `r"""..."""` take the c.ts glued STRING_PREFIXES arm with NO escape
 * processing at all (a backslash is literal, and the language agrees:
 * a raw string cannot contain its quote, doubled or escaped, so the
 * simple closer scan is the honest one). There are NO char literals in
 * the java sense: `'` just opens the ordinary String scan (java's
 * endOfCharLiteral arm is dropped entirely). Adjacent string-literal
 * concatenation (`'a' 'b'`) rides as the separate runs the scan gives,
 * honestly. `@` glued to a name is an annotation and rides "decorator":
 * the dotted name plus AT MOST ONE balanced paren group (whitespace
 * between name and `(` allowed; strings -- both quote forms, dart has no
 * char literals -- and comments inside are skipped so their brackets
 * cannot cut the run short; no closer anywhere runs to end of input; the
 * java arm with the groovy string fix). "keyword" for the reserved words
 * CASE-SENSITIVELY (like java, unlike php), with lowercase-only
 * `true`/`false` riding "boolean" and `null` riding "null"; the async
 * family (async/await/yield/sync) rides keyword (the spec reserves them,
 * the honest call against the cs contextual ruling -- dart is not C#),
 * and so do `get`/`set`/`factory` for the same reason (the plan draft
 * called them contextual, but they are reserved words in the dart
 * grammar and cannot be identifiers). `var`/`final`/`const`/`late` ride
 * keyword. There is NO primitive set: dart has no primitive keywords, so
 * `int`/`String`/`Future` are ordinary classes -- the Capitalized ones
 * read as types by the heuristic and the lowercase `int`/`double` ride
 * default -- except `void`, which is reserved and rides "type" with the
 * java family. "type" is also the name directly after class/mixin/
 * extension/enum/typedef/implements/extends plus the Capitalized
 * heuristic (`Widget` reads as a class, `MAX_SIZE` stays a plain word --
 * the c.ts ruling); generics angle brackets ride plain operators. "fn"
 * is any name directly before `(` (the call peek survives the dot, and
 * claims `Foo(...)` constructor calls like java); dart has no def
 * keyword, so there is no prevFn arm, and getters `get x =>` get no fn
 * reading (`x` is glued to `=>`, not `(`), honestly documented. "number"
 * for decimal/hex (NO octal -- `0777` is a plain decimal like C# -- and
 * NO binary, so `0b101` is the number 0 plus the word b101, unlike every
 * other member of this family) with NO digit separators (the simplest
 * dialect of the three: `1_000` degrades to the number `1` plus the
 * identifier `_000`, since `_` is a legal identifier start) and NO
 * suffix zoo; floats with exponent ride; there is no leading-dot float,
 * so `1.2.3` reads number, dot, number and no lookalike tracking exists;
 * shape validation sends `0x` back to default. `..` (cascade), `...`
 * (the spread), `?..` (null-aware cascade), `??=` and `=>` (the function
 * arrow -- a real operator run, ruby's rocket precedent; java/cs had no
 * such token and correctly rejected it) are one "operator" run each;
 * `?.` IS a member position and sets the dot; `??`, `==`, `!=`, `<=`,
 * `>=`, `&&`, `||` are runs. The null-aware spread `...?` decomposes
 * into `...` plus `?`, and the `?...` spelling into `?..` plus `.` (the
 * three-char check runs first, so the null-aware cascade wins the
 * maximal munch, which is what the real lexer does too). `::` is NOT a dart operator (static access is a dot)
 * and degrades to two single colons; `<=>` and `->` do not exist and
 * degrade too. `$` is not an identifier char here: outside a string it
 * is an interpolation sigil with nothing to interpolate and rides plain
 * default. Nothing is ever dropped or reordered: concatenating every run
 * reproduces the input exactly, for any input. One run per token;
 * adjacent runs may share a type (sinks coalesce as they like). This is
 * display candy, not a dart parser.
 */
export function tokenizeDart(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let dot = false; // the previous token was `.` or `?.`
  let prevDecl = false; // the previous token was class/mixin/extension/enum/typedef/implements/extends

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
    if ((c === '"' || c === "'") && text[i + 1] === c && text[i + 2] === c) {
      const end = endOfTriple(text, i);
      push("string", text.slice(i, end));
      i = end;
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
      // Raw string from a glued `r`: NO escape processing, the closer is
      // the closer (the c.ts STRING_PREFIXES arm).
      if (text.slice(i, j) === "r" && (text[j] === '"' || text[j] === "'")) {
        const quote = text[j]!;
        const end =
          text[j + 1] === quote && text[j + 2] === quote ? endOfTriple(text, j) : endOfRawString(text, j);
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
    if (isNumberStart(c)) {
      const end = scanNumber(text, i);
      push(NUM_OK_RE.test(text.slice(i, end)) ? "number" : "default", text.slice(i, end));
      i = end;
      setPrev("number");
      continue;
    }
    const three = text.slice(i, i + 3);
    if (THREE_CHAR_OPS.has(three)) {
      push("operator", three);
      i += 3;
      setPrev("operator");
      dot = false; // cascade/spread/null-assign are not member gestures
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push("operator", two);
      i += 2;
      setPrev("operator");
      dot = two === "?."; // the null-aware method call IS a member position
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
   * void -> keywords (case-sensitive) -> the name after class/mixin/...
   * -> fn (name before `(`, the peek surviving the dot) -> Capitalized
   * type. After a dot, every reading but the call peek is refused. */
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

/** `class`/`mixin`/`extension`/`enum`/`typedef`/`implements`/`extends`
 * (exact case): the name right after one is a "type". */
const DECL_KW = new Set(["class", "mixin", "extension", "enum", "typedef", "implements", "extends"]);

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

/** Raw string from the opening quote (the glued-`r` arm): NO escape
 * processing -- a backslash is literal and cannot shield the closer,
 * which matches the language: a raw string cannot contain its quote at
 * all. The single-quote form stops at the newline like its interpreted
 * cousin (it is not a multiline spelling). */
function endOfRawString(text: string, from: number): number {
  const quote = text[from]!;
  let j = from + 1;
  while (j < text.length) {
    const d = text[j]!;
    if (d === "\n" || d === "\r") return j;
    if (d === quote) return j + 1;
    j++;
  }
  return text.length;
}

/** Triple-quoted multiline string (`"""` or `'''`, raw or not -- the
 * prefix sits before the opener and joins the run) from the triple-quote:
 * runs to the FIRST following triple-quote of the same spelling or end of
 * input (the kotlin scan). Interpolation stays inside the run; an escaped
 * closer in an INTERPRETED triple can cut the run short here, the
 * documented cost of the simple scan. */
function endOfTriple(text: string, from: number): number {
  const triple = text.slice(from, from + 3);
  const end = text.indexOf(triple, from + 3);
  return end === -1 ? text.length : end + 3;
}

/** `@Name`/`@a.b.Name` plus AT MOST ONE balanced paren group (the group
 * may sit behind whitespace, as the grammar allows): strings (BOTH quote
 * forms -- dart has no char literals) and comments inside are skipped so
 * their brackets cannot cut the run short; no closer anywhere runs to the
 * end of input. */
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
    } else if (d === '"' || d === "'") {
      k = endOfString(text, k);
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

/** Three-char operators, checked before the two-char set: `??=`
 * (null-assign), `?..` (null-aware cascade) and `...` (the spread). The
 * null-aware spread `...?` is deliberately absent: it rides as the spread
 * plus a single `?`. */
const THREE_CHAR_OPS = new Set(["??=", "?..", "..."]);

/** Two-char operators. `=>` IS a run (the function arrow, a real dart
 * token; java/cs rejected the spelling because they have no such
 * operator). `?.` IS a member position; `::` is DELIBERATELY absent (dart
 * static access is a dot, so `::` scans as two single colons), and so are
 * `<=>` and `->` (no such tokens). `..` is the cascade. */
const TWO_CHAR_OPS = new Set(["?.", "??", "..", "=>", "==", "!=", "<=", ">=", "&&", "||"]);

/** Capitalized name (`Widget`, `Thing2`), NOT an all-caps constant
 * (`MAX_SIZE`) and not a mixed-case name (`GtkWidget`) -- the c.ts
 * typedef heuristic. */
const CAPITALIZED_RE = /^[A-Z][a-z0-9_]*$/;

/** The numeric dialect: the simplest of the three languages. Hex with no
 * separators, plain decimal (NO octal -- `0777` is decimal like C# -- and
 * NO binary), floats with exponent, NO suffixes, NO leading-dot float.
 * Validation sends `0x` back to default; `1_000` scans as the number 1
 * plus the identifier `_000` (dart has no digit separators). Hex is the
 * lowercase `0x` spelling only, as the grammar's own. */
const NUM_OK_RE = /^(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;

const isNumberStart = (c: string): boolean => /[0-9]/.test(c);

function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  if (text[i] === "0" && text[i + 1] === "x") {
    i += 2;
    while (i < n && /[0-9a-fA-F]/.test(text[i]!)) i++;
    return i;
  }
  while (i < n && /[0-9]/.test(text[i]!)) i++;
  if (text[i] === "." && /[0-9]/.test(text[i + 1] ?? "")) {
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

/** `void` rides "type" with the java family (it is reserved in the
 * grammar, and display has no reason to split it from the java
 * primitives). `true`, `false` and `null` are handled separately as
 * boolean/null; `int`/`double` are ordinary lowercase class names and
 * ride default. */
const PRIMITIVES: ReadonlySet<string> = new Set(["void"]);

/** The reserved words (exact case -- like java, unlike php), minus
 * true/false/null which ride boolean/null and void which rides type.
 * This is the dart grammar's own reserved list (the async family,
 * get/set/factory, the import/export/part/module vocabulary, covariant,
 * required...); contextual-ish readings are NOT a dart concept -- the cs
 * contextual rulings stay in cs. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "abstract",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "covariant",
  "deferred",
  "default",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "extension",
  "external",
  "factory",
  "final",
  "finally",
  "for",
  "get",
  "hide",
  "if",
  "implements",
  "import",
  "in",
  "interface",
  "is",
  "late",
  "library",
  "mixin",
  "new",
  "on",
  "operator",
  "part",
  "required",
  "rethrow",
  "return",
  "set",
  "show",
  "static",
  "super",
  "switch",
  "sync",
  "this",
  "throw",
  "try",
  "typedef",
  "var",
  "while",
  "with",
  "yield",
]);

/** The registry entry for this lang (assembly list: index.ts). No
 * aliases: the canonical name is the fence word, and it is also the only
 * extension (`.dart`) -- nothing else is claimed (`.dill` is the SDK
 * binary, the house rule keeps the list minimal). */
export const DART_SYNTAX: SyntaxDef = {
  lang: "dart",
  tokenize: tokenizeDart,
  extensions: ["dart"],
};
