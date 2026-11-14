import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Groovy tokenizer.
 *
 * One pass over code (the java.ts family, which it mirrors closely):
 * `//` opens a "comment" to EOL and the block form runs to its closer or
 * end of input, NEVER nested. The honest ruling on the slash is that
 * groovy HAS `//` line comments (the grammar's own, and every Jenkinsfile
 * in the world proves it), so the java comment arms transfer verbatim;
 * what rides plain instead is the slashy STRING: the regex-vs-division
 * ambiguity is undecidable without parser state the per-line house does
 * not have, so a lone `/` is always an operator and a regex or slashy
 * body is scanned as ordinary code; `///` therefore reads as a comment
 * (the documented cost: a triple-slashy string is what the real lexer
 * sees there). "string" is rich here: single/double quotes with escapes
 * honored (an unterminated literal stops at the newline, a backslash
 * before it splices the line, the c.ts endOfString) with interpolation
 * `$b`/`${x}` staying inside the run (the php ruling: the holes are not
 * parsed, so a quote inside a hole closes the literal); and the triple-
 * quoted `"""..."""`/`'''...'''` multiline forms -- real and common in
 * Jenkinsfile -- scan to the first following triple-quote or end of
 * input (the kotlin raw-string shape), which makes a content-ending-in-
 * quote spelling read as unclosed, the documented cost. There are NO
 * char literals in the java sense: single quotes open the ordinary
 * String scan, so `'ab'` is one string run and only a failing shape (a
 * lone quote) rides default. Dollar-slashy `$/...$` gets no arm and
 * rides plain. `@` glued to a name is an annotation and rides
 * "decorator": the dotted name plus AT MOST ONE balanced paren group
 * (whitespace between name and `(` allowed; strings -- both quote forms,
 * since groovy has no char literals -- and block comments inside are
 * skipped so their brackets cannot cut the run short; slashy strings are
 * not strings to this display, so brackets inside one are counted, the
 * honest ceiling; no closer anywhere runs to end of input). "keyword"
 * for the reserved words CASE-SENSITIVELY (like java, unlike php), with
 * lowercase-only `true`/`false` riding "boolean" and `null` riding
 * "null"; `def`, `trait`, `in`, `as` ride keyword, and `var` rides
 * default (groovy has no `var` keyword at all). Method names after `def`
 * need no prevFn arm: groovy insists on `def name(...)`, so the call
 * peek already claims them (ruby needs the prevFn because its parens are
 * optional; carrying an arm the peek subsumes would be dead code) -- a
 * `def x` property name rides default, honestly. "type" for the
 * primitive keywords (int, long, short, byte, float, double, boolean,
 * char, void -- groovy accepts the java spellings), the name directly
 * after class/interface/trait/enum/extends/implements, and Capitalized
 * names (`Widget` reads as a class, `MAX_SIZE` stays a plain word -- the
 * c.ts heuristic); generics angle brackets ride plain operators. "fn"
 * for any name directly before `(` (the call peek survives the dot, and
 * claims `Foo(...)` constructor calls like java); trailing-closure calls
 * `foo { }` get no fn reading, the same honest ceiling as ruby's
 * optional parens. "number" for decimal/hex/binary with `_` separators
 * and floats with exponent -- NO octal: groovy's legacy leading-zero
 * spelling was deprecated and removed, and the class is "number" either
 * way, so `0777` reads as a plain decimal (the cs ruling; `0o7` is the
 * number 0 plus the word o7) -- plus the big-number suffix zoo: L/l, the
 * BigInteger I/i and G/g, the BigDecimal BD/bd, and F/f/D/d; an
 * ill-formed tail like `1bd2` declines the suffix and `bd2` rides as a
 * word. There is no leading-dot float, so `1.2.3` reads number, dot,
 * number and no lookalike tracking exists; shape validation sends `0x`,
 * a trailing `_`, `0b2` back to default. `..` and `..<` (ranges), the
 * power `**`, the elvis `?:`, the matchers `=~`, `!~` and `==~`, `==`,
 * `!=`, `<=`, `>=`, `&&`, `||` and `->` (the closure arrow, NOT member
 * access: java's ruling, so `-> true` keeps its boolean) are one
 * "operator" run each; `::` (method refs) and the safe navigation `?.`
 * ARE member positions and set the dot; the compound accessors `*.`
 * spread and the null-aware `?.` spellings get no runs of their own and
 * decompose into their single-char pieces (the member dot still sets
 * the flag, so the trailing name reads correctly); `<=>` is NOT a groovy
 * operator (compareTo is a method, not a spelling -- ruby/php have the
 * run, groovy degrades to `<=` plus `>`), and `=>` and `??` do not exist
 * and degrade to singles. `$` outside a string is an interpolation
 * sigil with nothing to interpolate and rides plain default. Nothing is
 * ever dropped or reordered: concatenating every run reproduces the
 * input exactly, for any input. One run per token; adjacent runs may
 * share a type (sinks coalesce as they like). This is display candy,
 * not a groovy parser.
 */
export function tokenizeGroovy(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let dot = false; // the previous token was `.`, `?.` or `::` (NOT `->`: closure)
  let prevDecl = false; // the previous token was class/interface/trait/enum/extends/implements

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
      dot = false; // the find-all matcher and the exclusive range are not member gestures
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push("operator", two);
      i += 2;
      setPrev("operator");
      dot = two === "::" || two === "?."; // method refs and safe navigation ARE member positions
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
   * trait/... -> fn (name before `(`, the peek surviving the dot -- it
   * claims `def name(` names too, so no prevFn arm exists here) ->
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

/** `class`/`interface`/`trait`/`enum`/`extends`/`implements` (exact case):
 * the name right after one is a "type". */
const DECL_KW = new Set(["class", "interface", "trait", "enum", "extends", "implements"]);

/** Interpreted strings (interpolated ones ride the same scan -- the holes
 * stay inside the run, the php ruling): escapes honored (in BOTH quote
 * forms: groovy single quotes are full Strings with escapes, just no
 * interpolation), an unterminated literal stops before an unescaped
 * newline -- but a backslash before that newline splices the line and the
 * scan carries on to the closer or end of input (the c.ts/js family). */
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

/** Triple-quoted multiline string (`"""` or `'''`) from the opener: runs
 * to the FIRST following triple-quote of the same spelling or end of
 * input (the kotlin raw-string scan). The real form processes escapes, so
 * an escaped closer can cut the run short here, the documented cost of
 * the simple scan; interpolation stays inside the run. */
function endOfTriple(text: string, from: number): number {
  const triple = text.slice(from, from + 3);
  const end = text.indexOf(triple, from + 3);
  return end === -1 ? text.length : end + 3;
}

/** `@Name`/`@a.b.Name` plus AT MOST ONE balanced paren group (the group
 * may sit behind whitespace, as the grammar allows): strings (BOTH quote
 * forms -- groovy has no char literals for java's endOfCharLiteral skip)
 * and block comments inside are skipped so their brackets cannot cut the
 * run short; no closer anywhere runs to the end of input. `//` gets no
 * skip: it is a comment outside, but inside the group a slashy-string
 * bracket is counted, the honest ceiling. */
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

/** Three-char operators, checked before the two-char set: the find-all
 * matcher and the exclusive range (4.0). `<=>` is DELIBERATELY absent:
 * groovy has no spaceship operator (compareTo is a method), so the
 * sequence scans as `<=` plus `>` -- the ruby/php run does not transfer. */
const THREE_CHAR_OPS = new Set(["==~", "..<"]);

/** Two-char operators. `=>`, `??` and `...` are deliberately absent (they
 * are not groovy operators and scan as single-char operators); the
 * compound `*.`/`?.`-prefixed accessors decompose into their pieces (the
 * member dot still sets the flag). `?.` and `::` ARE member positions;
 * `->` (the closure arrow) is not; `?:` is the elvis; `..` is the range
 * (the exclusive `..<` is three-char). */
const TWO_CHAR_OPS = new Set(["**", "?.", "::", "?:", "=~", "!~", "->", "==", "!=", "<=", ">=", "&&", "||", ".."]);

/** Capitalized name (`Widget`, `Thing2`), NOT an all-caps constant
 * (`MAX_SIZE`) and not a mixed-case name (`GtkWidget`) -- the c.ts
 * typedef heuristic. */
const CAPITALIZED_RE = /^[A-Z][a-z0-9_]*$/;

/** The numeric dialect: hex/binary with `_` separators and plain decimal
 * -- NO octal (the legacy leading-zero spelling is deprecated-and-removed
 * and the class is number either way, so `0777` is a plain decimal like
 * C#), no leading-dot float -- floats with exponent, and the suffix zoo
 * L/l, I/i and G/g (BigInteger), BD/bd (BigDecimal), F/f/D/d.
 * Validation sends `0x`, `1_`, `0b2` back to default; an ill-formed tail
 * like `1bd2` leaves `bd2` as a word. */
const NUM_OK_RE =
  /^(?:0[xX][0-9a-fA-F](?:[0-9a-fA-F_]*[0-9a-fA-F])?|0[bB][01](?:[01_]*[01])?|\d(?:[\d_]*\d)?(?:\.\d(?:[\d_]*\d)?)?(?:[eE][+-]?\d(?:[\d_]*\d)?)?)(?:[bB][dD]|[lLiIgGfFdD])?$/;

const isNumberStart = (c: string): boolean => /[0-9]/.test(c);

const NUM_SUFFIX_RE = /^(?:[bB][dD]|[lLiIgGfFdD])(?![\w])/;

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

/** Primitive type keywords ride "type" (exact case; groovy accepts the
 * java spellings and maps them to the wrappers). `true`, `false` and
 * `null` are handled separately as boolean/null. */
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

/** The reserved words (exact case -- like java, unlike php), minus
 * true/false/null which ride boolean/null and the primitives which ride
 * type. `def` and `trait` are here (def is hard-reserved; its names still
 * take the call peek, see classifyIdent); `var` is DELIBERATELY absent
 * (groovy has no var keyword). Soft keywords (record in its annotation
 * sense and friends) ride default. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "abstract",
  "as",
  "assert",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
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
  "in",
  "instanceof",
  "interface",
  "new",
  "package",
  "return",
  "static",
  "strictfp",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "trait",
  "transient",
  "try",
  "volatile",
  "while",
]);

/** The registry entry for this lang (assembly list: index.ts). No
 * aliases: the canonical name is the fence word. `.gradle` (build
 * scripts) and the Jenkinsfile basename ride the same scanner (the
 * Dockerfile shape: variants like Jenkinsfile.dev guess too); `.gvy`,
 * `.gy` and `.gsh` are NOT claimed (the house rule keeps the list
 * minimal). */
export const GROOVY_SYNTAX: SyntaxDef = {
  lang: "groovy",
  tokenize: tokenizeGroovy,
  extensions: ["groovy", "gradle"],
  basenames: ["Jenkinsfile"],
};
