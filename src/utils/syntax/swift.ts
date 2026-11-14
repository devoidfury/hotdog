import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Swift tokenizer.
 *
 * One pass over code (the kotlin.ts family, which it mirrors closely):
 * `//` opens a "comment" to EOL (doc comments are just this) and the
 * block form runs to its closer or end of input -- NESTED (the plan draft
 * said plain; the spec overrides: the Swift grammar nests block comments,
 * so an inner pair closed inside an outer one stays ONE comment, kotlin's
 * shape transfers here, not java's). `#` is NOT a comment and NOT a
 * directive class: there is no preproc reading at all (unlike c.ts) --
 * `#if`, `#available` and the keypath-ish `#foo` spellings degrade to the
 * plain `#` plus the ordinary words, honestly. "string" is rich here:
 * the double-quoted form with escapes honored (an unterminated literal
 * stops at the newline, a backslash before it splices the line, the c.ts
 * endOfString) with interpolation `\(...)` staying inside the run (the
 * rust format-string ruling: the holes are not parsed, so a quote inside
 * a hole closes the literal); the triple-quoted multiline form scans for
 * its closer SKIPPING backslash pairs (the interpreted counterpart of
 * the kotlin raw scan -- swift multiline strings process escapes, so
 * `\"""` does NOT close, while a content-ending-in-quote spelling the
 * language itself escapes still reads whole; a lone trailing quote cost
 * like kotlin's `"""""` stays). Raw strings with N hashes `#"..."#`
 * (also `##"..."##`, and the multiline `#"""..."""#`) arm on hashes
 * glued to the opening quote: NO escape processing, the closer is the
 * same quote run followed by the same hash count (so a bare quote or a
 * short hash run cannot close it), and the single-line form stops at the
 * newline like its interpreted cousin (the groovy/kotlin precedent); a
 * content spelling that needs the closer shape wants more hashes, which
 * is exactly what the language tells you. Char literals ride the java.ts
 * simple rule -- quote, one escape (the `\uXXXX` spelling included) or
 * plain char, closer -> "string"; anything else is not a literal and the
 * quote rides default (stable Swift spells Character as a double-quoted
 * literal; this is the tolerant read for the single-quote spelling, and
 * the common typo `'''` does read as one literal, lossless either way,
 * the java/kotlin pin). `@` glued to a name is an attribute and rides
 * "decorator": the dotted name plus AT MOST ONE balanced paren group
 * (whitespace between name and `(` allowed; strings -- both quote forms
 * -- and comments inside are skipped so their brackets cannot cut the
 * run short; no closer anywhere runs to end of input; the java/kotlin
 * arm transfers verbatim), and a `@` not glued to a name rides plain
 * default. "keyword" for the reserved words CASE-SENSITIVELY (java's
 * shape), with lowercase-only `true`/`false` riding "boolean" and `nil`
 * riding "null" (the spelling is nil; there is no `null` word); `self`
 * and `super` ride keyword and `Self` reads via the Capitalized
 * heuristic (documented, honest -- it is a type name in the grammar);
 * the declaration modifiers (final, override, convenience, required,
 * mutating, nonisolated...) are listed like kotlin's soft set, while
 * accessor words (get/set/willSet/didSet) and the property-attribute
 * words (weak, unowned, lazy, dynamic) ride default. There are NO
 * primitive keywords -- `Int`/`Double`/`Void` are ordinary Capitalized
 * classes and the heuristic does the work (kotlin's ruling); `void`
 * lowercase does not exist. "type" is the name directly after class/
 * struct/enum/protocol/extension/actor/typealias/associatedtype plus
 * the Capitalized heuristic (`Widget` reads as a class, `MAX_SIZE` stays
 * a plain word -- the c.ts ruling); generics angle brackets ride plain
 * operators. "fn" is the name after `func` (kotlin's prevFn shape), the
 * `init`/`init?`/`init!` of a declaration taking the reading from the
 * keyword arm itself (`init` IS the name -- a pinned quirk), and any
 * name directly before `(` (the call peek survives the dot, and claims
 * `Foo(...)` constructor calls like java); trailing-closure calls
 * `foo { }` get no fn reading, the same honest ceiling as ruby's
 * optional parens. "number" for hex (the lowercase `0x` spelling only,
 * the grammar's own), OCTAL `0o` (the reverse pin -- the radix the
 * kotlin/groovy/dart batch had no word for; `017` is a plain decimal
 * anyway), and binary `0b`, with `_` separators, decimals and floats
 * with e-exponent, and the hex-float p-exponent on an integer mantissa
 * (`0x1p3` is a number; a hex FRACTIONAL mantissa degrades, documented,
 * which keeps `0xFF.bitWidth` reading as member access); NO suffix zoo
 * (`1u` is the number 1 plus the word u, like dart). There is no
 * leading-dot float, so `1.2.3` reads number, dot, number and no
 * lookalike tracking exists; shape validation sends `0x`, `0o`, `0b`,
 * a trailing `_`, `0b2`, `0o8` back to default. `?.` (optional chaining)
 * IS a member position and sets the dot; `...` (closed range) and
 * `..<` (half-open) and `??=` are one "operator" run each (the
 * three-char check runs first, as dart pinned), and so are `??`, `==`,
 * `!=`, `<=`, `>=`, `&&`, `||` and the overflow-arithmetic family
 * `&+`/`&-`/`&*`/`&/`/`&<<`/`&>>` (the plan draft denied them; the spec
 * overrides: they are real swift tokens). `->` (the function/lambda
 * arrow) is a run but NOT member access (java's ruling: `-> String`
 * keeps its type reading, `-> true` keeps its boolean); the postfix `?`
 * and `!` ride plain singles. The elvis `?:` does NOT exist (no such
 * operator -- contrast kotlin's pin, the sequence degrades to two
 * singles), and neither do `!!`, `=>`, `<-`, `::` or `<=>`, all of which
 * degrade too. `$` is not an identifier char here and carries no sigil
 * meaning outside strings; it rides plain default. Nothing is ever
 * dropped or reordered: concatenating every run reproduces the input
 * exactly, for any input. One run per token; adjacent runs may share a
 * type (sinks coalesce as they like). This is display candy, not a
 * Swift parser.
 */
export function tokenizeSwift(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let dot = false; // the previous token was `.` or `?.` (NOT `->`: arrow)
  let prevDecl = false; // the previous token was class/struct/enum/protocol/extension/actor/typealias/associatedtype
  let prevFn = false; // the previous token was the `func` keyword

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
    if (c === "#") {
      // Raw string `#"..."#` (N hashes, `#"""..."""#` multiline): the
      // hashes must be glued to the opening quote, or it is no string
      // at all -- `#if`, `#available` and a lone `#` ride plain bytes.
      let k = i + 1;
      while (text[k] === "#") k++;
      if (text[k] === '"') {
        const end = endOfHashRaw(text, i);
        push("string", text.slice(i, end));
        i = end;
        setPrev("string");
        continue;
      }
    }
    if (c === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
      const end = endOfMultiline(text, i);
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
    if (THREE_CHAR_OPS.has(three)) {
      push("operator", three);
      i += 3;
      setPrev("operator");
      dot = false; // ranges and nil-assign are not member gestures
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push("operator", two);
      i += 2;
      setPrev("operator");
      dot = two === "?."; // optional chaining IS a member position
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
    prevFn = word !== undefined && word === "func";
  }

  /** Booleans/null (lowercase only, the language is case-sensitive) ->
   * keywords (case-sensitive; `init` of a declaration is itself the
   * member NAME, so it takes the fn reading) -> the name after class/
   * struct/... -> the name after `func` -> fn (name before `(`, the peek
   * surviving the dot) -> Capitalized type. After a dot, every reading
   * but the call peek is refused. */
  function classifyIdent(word: string, after: number): string {
    if (!dot) {
      if (word === "true" || word === "false") return "boolean";
      if (word === "nil") return "null";
      if (KEYWORDS.has(word)) return word === "init" && isInitHead(text, after) ? "fn" : "keyword";
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

/** `class`/`struct`/`enum`/`protocol`/`extension`/`actor`/`typealias`/
 * `associatedtype` (exact case): the name right after one is a "type". */
const DECL_KW = new Set([
  "class",
  "struct",
  "enum",
  "protocol",
  "extension",
  "actor",
  "typealias",
  "associatedtype",
]);

/** Block comment from the opener: NESTED (the Swift grammar nests them --
 * kotlin's shape, not java's), so a depth count runs to the closer that
 * matches the opener; no matching closer anywhere runs to the end of
 * input. */
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

/** Interpreted strings (interpolated ones ride the same scan -- the holes
 * stay inside the run, the rust format-string ruling, so a quote inside
 * a hole closes the literal): escapes honored, an unterminated literal
 * stops before an unescaped newline -- but a backslash before that newline
 * splices the line and the scan carries on to the closer or end of input
 * (the c.ts/js family). */
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

/** Multiline `"""..."""` from the opener: the closer scan SKIPS backslash
 * pairs (the opposite cost from kotlin's raw scan: swift multiline
 * processes escapes, so `\"""` is an escaped quote, not a closer); runs
 * to the first following triple-quote or end of input. A lone quote never
 * closes the triple, so quotes inside interpolation holes survive here --
 * the run can even END unclosed on a trailing-quote spelling the language
 * wants escaped, kotlin's documented cost in new dress. */
function endOfMultiline(text: string, from: number): number {
  let j = from + 3;
  while (j < text.length) {
    const d = text[j]!;
    if (d === "\\") {
      j += 2;
      continue;
    }
    if (d === '"' && text[j + 1] === '"' && text[j + 2] === '"') return j + 3;
    j++;
  }
  return text.length;
}

/** Hash-delimited raw string from the first `#`: count the hashes, the
 * opener is N quotes (one for the single-line form, three for the
 * multiline form), the closer the same quote run followed by the same
 * hash count -- a bare quote or a short hash run cannot close it, and
 * there is NO escape processing at all. The single-line form stops at the
 * newline like its interpreted cousin (it is not a multiline spelling);
 * an unclosed form runs to end of input. */
function endOfHashRaw(text: string, from: number): number {
  let k = 0;
  while (text[from + k] === "#") k++;
  const q = from + k; // the first opening quote
  const multiline = text[q + 1] === '"' && text[q + 2] === '"';
  const closer = (multiline ? '"""' : '"') + "#".repeat(k);
  let j = q + (multiline ? 3 : 1);
  while (j < text.length) {
    if (!multiline && (text[j] === "\n" || text[j] === "\r")) return j;
    if (text.startsWith(closer, j)) return j + closer.length;
    j++;
  }
  return text.length;
}

/** Char literal: exactly one character or escape (the `\uXXXX` form
 * included) between the quotes. Returns the end index, or -1 when the
 * shape fails -- the caller then lets the quote ride default (so a stray
 * apostrophe never eats the line). The java.ts arm, verbatim. */
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

/** `init`/`init?`/`init!` of a declaration: the keyword is the member
 * NAME, so a paren (past an optionality mark and any whitespace) takes
 * the fn reading instead of the keyword one. */
function isInitHead(text: string, from: number): boolean {
  let j = skipWs(text, from);
  if (text[j] === "?" || text[j] === "!") j = skipWs(text, j + 1);
  return text[j] === "(";
}

/** `@Name`/`@a.b.Name` plus AT MOST ONE balanced paren group (the group
 * may sit behind whitespace, as the grammar allows): strings (both quote
 * forms) and comments inside are skipped so their brackets cannot cut the
 * run short; no closer anywhere runs to the end of input. The java arm,
 * verbatim (kotlin's string skip with the char-literal fallback). */
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

/** Three-char operators, checked before the two-char set: the closed
 * range, the half-open range (the maximal munch runs FIRST, so `..<`
 * beats a `..` -- dart's pinned lesson; swift has no `..` single form
 * either way), the nil-coalescing assignment, and the shift members of
 * the overflow family. */
const THREE_CHAR_OPS = new Set(["...", "..<", "??=", "&<<", "&>>"]);

/** Two-char operators. `?.` IS a member position (the cs/kotlin
 * ruling); `->` (the function arrow) is a run but NOT one (java's
 * ruling: `-> String` keeps its type reading); `&+`/`&-`/`&*`/`&/` are
 * the overflow family (real swift tokens, the spec overriding the plan
 * draft's denial). The elvis `?:` is DELIBERATELY absent (no such
 * operator -- contrast kotlin), and so are `!!`, `=>`, `<-` and `::`
 * (none exist; all scan as single-char operators). */
const TWO_CHAR_OPS = new Set([
  "?.",
  "??",
  "->",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "&+",
  "&-",
  "&*",
  "&/",
]);

/** Capitalized name (`Widget`, `Thing2`), NOT an all-caps constant
 * (`MAX_SIZE`) and not a mixed-case name (`GtkWidget`) -- the c.ts
 * typedef heuristic. `Self` and `Void` ride it (honest: they are type
 * names in the grammar, not lowercase keywords). */
const CAPITALIZED_RE = /^[A-Z][a-z0-9_]*$/;

/** The numeric dialect: hex (`0x`), OCTAL (`0o` -- the radix this family
 * had never met; the reverse pin) and binary with `_` separators, plain
 * decimal (no octal semantics either way), floats with e-exponent, and
 * the hex-float p-exponent on an integer mantissa (`0x1p3`; a fractional
 * mantissa degrades -- `0x1.8p10` is number, dot, number, word -- which
 * keeps `0xFF.bitWidth` reading as member access). NO suffix zoo (the
 * simplest dialect of the java family: `1u` is the number plus the word
 * u, like dart) and no leading-dot float. Validation sends `0x`, `0o`,
 * `0b`, `1_`, `0b2`, `0o8` back to default; hex is the lowercase `0x`
 * spelling only, as the grammar's own. */
const NUM_OK_RE =
  /^(?:0x[0-9a-fA-F](?:[0-9a-fA-F_]*[0-9a-fA-F])?(?:[pP][+-]?\d(?:[\d_]*\d)?)?|0o[0-7](?:[0-7_]*[0-7])?|0b[01](?:[01_]*[01])?|\d(?:[\d_]*\d)?(?:\.\d(?:[\d_]*\d)?)?(?:[eE][+-]?\d(?:[\d_]*\d)?)?)$/;

const isNumberStart = (c: string): boolean => /[0-9]/.test(c);

function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  if (text[i] === "0" && /[xob]/.test(text[i + 1] ?? "")) {
    i += 2;
    while (i < n && /[0-9a-fA-F_]/.test(text[i]!)) i++;
    if (text[i] === "p" || text[i] === "P") {
      let j = i + 1;
      if (text[j] === "+" || text[j] === "-") j++;
      if (/[0-9]/.test(text[j] ?? "")) {
        i = j;
        while (i < n && /[0-9_]/.test(text[i]!)) i++;
      }
    }
    return i;
  }
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
  return i;
}

/** The reserved words (exact case -- like java), minus true/false which
 * ride boolean and nil which rides null. There is NO primitive set:
 * `Int`/`Double`/`Void` are ordinary Capitalized classes (kotlin's
 * ruling) and lowercase `void` does not exist. The contextual words the
 * language lets you spend as identifiers ride default: the accessors
 * (get, set, willSet, didSet), the property attributes (weak, unowned,
 * lazy, dynamic), `Protocol`, `Type`. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "actor",
  "any",
  "as",
  "associatedtype",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "convenience",
  "continue",
  "default",
  "defer",
  "deinit",
  "do",
  "else",
  "enum",
  "extension",
  "fallthrough",
  "fileprivate",
  "final",
  "for",
  "func",
  "guard",
  "if",
  "import",
  "in",
  "inout",
  "init",
  "internal",
  "is",
  "let",
  "mutating",
  "nonisolated",
  "open",
  "operator",
  "override",
  "package",
  "private",
  "protocol",
  "public",
  "repeat",
  "required",
  "rethrows",
  "return",
  "self",
  "some",
  "static",
  "struct",
  "subscript",
  "super",
  "switch",
  "throw",
  "throws",
  "try",
  "typealias",
  "var",
  "where",
  "while",
]);

/** The registry entry for this lang (assembly list: index.ts). No
 * aliases: the canonical name is the fence word, and `.swift` is the
 * only extension (`.swiftinterface` and friends are NOT claimed -- the
 * house rule keeps the list minimal). */
export const SWIFT_SYNTAX: SyntaxDef = {
  lang: "swift",
  tokenize: tokenizeSwift,
  extensions: ["swift"],
};
