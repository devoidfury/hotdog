import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Rust tokenizer.
 *
 * One pass over code (the c.ts family): `//` opens a "comment" to EOL and
 * the block form NESTS (an inner block comment inside an outer one is
 * still one comment, unlike C/Go -- the language nests and so does the
 * depth count), running to its matching
 * closer or end of input; "string" covers the quote zoo -- interpreted
 * double quotes with escapes honored and an unterminated literal stopping
 * at the newline (backslash splicing past, the js family), char literals
 * with their escapes (`'\n'`, `'\''`, `'\x41'`, `'\u{1F600}'`), raw strings
 * `r"..."`/`r#"..."#`/`r##"..."##` running to their hash-matched closer
 * across newlines with NO escape processing (Rust gives the backslash no
 * power there), and the byte spellings `b"..."`, `b'...'`, `br"..."` glued
 * to the same scans -- display has no need of a class of their own; a
 * literal that never closes just ends at the end of input. A quote that is
 * neither opens nothing. `'a`, `'_`, `'static` are "variable" (lifetimes
 * ride the css-variable hue; the char-vs-lifetime call is the closer:
 * `'x'` is a char, `'x` is a lifetime). `#[...]` and `#![...]` are one
 * "decorator" run through their bracket-balanced closer -- contents
 * included, strings inside skipped so a `"]"` cannot cut it short, no
 * attribute parsing beyond the brackets; an attribute whose closer never
 * arrives runs to the end of input. A name glued to `!` (not `!=`) is a
 * macro invocation and the name plus bang ride "fn" -- `println!`, `vec!`,
 * `macro_rules!` -- and the macro BODY is ordinary code, deliberately not
 * parsed as anything special; "keyword" for the reserved words (`.await`
 * keeps the keyword reading even after a dot, the one member position
 * where a Rust keyword legitimately sits), `true`/`false` "boolean";
 * "type" for the primitive keywords (`u8`..`u128`, `i8`..`i128`, `f32`,
 * `f64`, `isize`, `usize`, `bool`, `char`, `str`), the name directly after
 * struct/enum/trait/union, and Capitalized names (`Widget` reads as a
 * type, `MAX_SIZE` stays a plain word -- the c.ts heuristic); "fn" for any
 * name directly before `(` and for the name directly after `fn` (so the
 * generic signature `fn parse<'a>(..)` keeps its reading with the paren
 * behind the brackets); `..=`, `..`, `->`, `=>`, `::`, `==`, `!=`,
 * `<=`, `>=`, `&&`, `||` are one "operator" run each and the rest of the
 * punctuation is single-char "operator"; "number" for radix forms with
 * their `_` separators (`0xFF_FF`), decimals and floats (`1_000`, `3.14`,
 * `6.02e23` -- a `.` only joins the literal when a digit follows, so the
 * range `1..2` never eats its own dots) and the type suffixes (`42u64`,
 * `1.5f32`); a shape that fails validation (`0x`, a trailing `_`) rides
 * default. After a `.`, the keyword/type readings are refused (a field
 * name rides default or the call peek); `::` and `..` never spend the
 * reading. Honest limits: the number scan does not know a tuple index
 * (`t.0`) from anything else; raw identifiers (`r#try`) degrade to word +
 * default `#` + word; a `#` outside an attribute (macro-definition
 * interpolation) is plain. Nothing is ever dropped or reordered:
 * concatenating every run reproduces the input exactly, for any input.
 * One run per token; adjacent runs may share a type (sinks coalesce as
 * they like). This is display candy, not a Rust parser.
 */
export function tokenizeRust(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let dot = false; // the previous token was `.`
  let prevDecl = false; // the previous token was struct/enum/trait/union
  let prevFn = false; // the previous token was the `fn` keyword

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
      const j = endOfBlockComment(text, i);
      push("comment", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "#" && (text[i + 1] === "[" || (text[i + 1] === "!" && text[i + 2] === "["))) {
      const j = endOfAttribute(text, i);
      push("decorator", text.slice(i, j));
      i = j;
      setPrev("decorator");
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
      const end = endOfChar(text, i);
      if (end !== -1) {
        push("string", text.slice(i, end));
        i = end;
        setPrev("string");
      } else if (IDENT_START_RE.test(text[i + 1] ?? "")) {
        let j = i + 1;
        while (j < n && IDENT_RE.test(text[j]!)) j++;
        push("variable", text.slice(i, j));
        i = j;
        setPrev("variable");
      } else {
        push("default", c);
        i++;
        setPrev("default");
      }
      continue;
    }
    if (IDENT_START_RE.test(c)) {
      let j = i;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      const word = text.slice(i, j);
      // String prefixes glued to their opening quote: raw forms (`r"` plus
      // `#` counts, `br"`), byte forms (`b"`, `b'`). A shape that does not
      // match (`r#try`, the raw identifier) falls through to the word.
      if (STRING_PREFIXES.has(word)) {
        let k = j;
        while (text[k] === "#") k++;
        if (text[k] === '"' && word.includes("r")) {
          const end = endOfRaw(text, k, k - j);
          push("string", text.slice(i, end));
          i = end;
          setPrev("string");
          continue;
        }
        if (word === "b" && text[j] === '"') {
          const end = endOfString(text, j);
          push("string", text.slice(i, end));
          i = end;
          setPrev("string");
          continue;
        }
        if (text[j] === "'") {
          const end = endOfChar(text, j);
          if (end !== -1) {
            push("string", text.slice(i, end));
            i = end;
            setPrev("string");
            continue;
          }
        }
      }
      // Macro invocation: name glued to `!` but not `!=` (an empty-tuple
      // field `x.1 != y` keeps its comparison; `println!`, `vec!`, `foo! {}`).
      if (text[j] === "!" && text[j + 1] !== "=") {
        push("fn", word + "!");
        i = j + 1;
        setPrev("fn", word);
        continue;
      }
      const type = classifyIdent(word, j);
      push(type, word);
      i = j;
      setPrev(type, word);
      continue;
    }
    if (/[0-9]/.test(c)) {
      const end = scanNumber(text, i);
      const word = text.slice(i, end);
      push(NUM_OK_RE.test(word) ? "number" : "default", word);
      i = end;
      setPrev("number");
      continue;
    }
    const three = text.slice(i, i + 3);
    if (three === "..=") {
      push("operator", three);
      i += 3;
      setPrev("operator");
      dot = false; // a range is not a member gesture
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push("operator", two);
      i += 2;
      setPrev("operator");
      dot = false;
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
    prevFn = word === "fn";
  }

  /** Booleans -> primitives -> keywords -> the name after struct/enum/
   * trait/union -> the name after `fn` -> fn (name before `(`) ->
   * Capitalized type. After a dot, every reading but the call peek (and
   * `.await`) is refused. */
  function classifyIdent(word: string, after: number): string {
    if (!dot) {
      if (word === "true" || word === "false") return "boolean";
      if (PRIMITIVES.has(word)) return "type";
      if (KEYWORDS.has(word)) return "keyword";
      if (prevDecl) return "type";
      if (prevFn) return "fn";
    }
    if (word === "await") return "keyword";
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

/** `struct`/`enum`/`trait`/`union`: the name right after one is a "type". */
const DECL_KW = new Set(["struct", "enum", "trait", "union"]);

/** Block comments NEST in Rust; the depth count runs to the matching
 * closer or end of input (an unclosed comment spares nothing). */
function endOfBlockComment(text: string, from: number): number {
  let depth = 0;
  let j = from;
  while (j < text.length) {
    if (text.startsWith("/*", j)) {
      depth++;
      j += 2;
    } else if (text.startsWith("*/", j)) {
      depth--;
      j += 2;
      if (depth === 0) return j;
    } else j++;
  }
  return text.length;
}

/** `#[...]`/`#![...]` through the bracket-balanced closer. Strings and
 * comments inside are skipped so their brackets cannot cut the run short;
 * no closer anywhere runs to the end of input. */
function endOfAttribute(text: string, from: number): number {
  let j = from;
  while (j < text.length && text[j] !== "[") j++; // spend the # and optional !
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
    } else if (d === '"') {
      j = endOfString(text, j);
    } else if (d === "'") {
      const end = endOfChar(text, j);
      j = end === -1 ? j + 1 : end;
    } else if (d === "/" && text[j + 1] === "/") {
      while (j < text.length && text[j] !== "\n" && text[j] !== "\r") j++;
    } else if (d === "/" && text[j + 1] === "*") {
      j = endOfBlockComment(text, j);
    } else j++;
  }
  return text.length;
}

/** Interpreted strings (and byte strings): escapes honored, an unterminated
 * literal stops before an unescaped newline -- but a backslash before that
 * newline splices the line (the c.ts/js family). */
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

/** Char and byte-char literals: `\\.` escapes plus `\xNN` and `\u{...}`,
 * exactly one character between the quotes. Returns the end index, or -1
 * (the caller decides between lifetime and plain quote). */
function endOfChar(text: string, from: number): number {
  let j = from + 1;
  if (text[j] === "\\") {
    if (text[j + 1] === "u") {
      const close = text.indexOf("}", j + 2);
      if (close === -1) return -1;
      j = close + 1;
    } else if (text[j + 1] === "x") {
      let k = j + 2;
      while (k < text.length && k < j + 4 && /[0-9a-fA-F]/.test(text[k]!)) k++;
      j = k;
    } else {
      j += 2;
    }
  } else {
    j++;
  }
  return text[j] === "'" ? j + 1 : -1;
}

/** Raw string from the opening quote (at `quoteIdx`, preceded by `r`/`br`
 * plus `#`*hashes): no escapes; the closer is a quote followed by exactly
 * that many hashes, anywhere across newlines; unclosed runs to end of
 * input. */
function endOfRaw(text: string, quoteIdx: number, hashes: number): number {
  const closer = '"' + "#".repeat(hashes);
  const end = text.indexOf(closer, quoteIdx + 1);
  return end === -1 ? text.length : end + closer.length;
}

const IDENT_START_RE = /[A-Za-z_\u00a0-\uffff]/;
const IDENT_RE = /[\w\u00a0-\uffff]/;
const OPERATOR_RE = /[{}()[\];,.:?+\-*/%&|^!~=<>]/;
const TWO_CHAR_OPS = new Set(["..", "->", "=>", "::", "==", "!=", "<=", ">=", "&&", "||"]);

/** Prefixes glued to an opening quote (lowercase only, per the language). */
const STRING_PREFIXES = new Set(["r", "b", "br", "rb"]);

/** The numeric dialect: radix forms and decimals with `_` separators,
 * floats whose dot needs a following digit (the `1..2` ruling), exponent,
 * and the integer/float type suffixes. Shape validation at the call site
 * sends `0x`, `1_` and other half-literals back to default. */
const NUM_OK_RE =
  /^(?:0[xX][0-9a-fA-F](?:[0-9a-fA-F_]*[0-9a-fA-F])?|0[bB][01](?:[01_]*[01])?|0[oO][0-7](?:[0-7_]*[0-7])?|\d(?:[\d_]*\d)?)(?:\.\d(?:[\d_]*\d)?)?(?:[eE][+-]?\d(?:[\d_]*\d)?)?(?:(?:[iu](?:8|16|32|64|128|size)|f(?:32|64)))?$/;

function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  if (text[i] === "0" && /[xXbBoO]/.test(text[i + 1] ?? "")) {
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
      if (/[0-9_]/.test(text[j] ?? "")) {
        i = j;
        while (i < n && /[0-9_]/.test(text[i]!)) i++;
      }
    }
  }
  const suffix = NUM_SUFFIX_RE.exec(text.slice(i));
  if (suffix) i += suffix[0].length;
  return i;
}

const NUM_SUFFIX_RE = /^(?:[iu](?:8|16|32|64|128|size)|f(?:32|64))(?![\w])/;

/** Capitalized name (`Widget`, `Thing2`), NOT an all-caps constant
 * (`MAX_SIZE`) and not a mixed-case name (`myThing`) -- the c.ts typedef
 * heuristic. */
const CAPITALIZED_RE = /^[A-Z][a-z0-9_]*$/;

/** Primitive types ride "type" (the ts/c/go class). */
const PRIMITIVES: ReadonlySet<string> = new Set([
  "bool",
  "char",
  "f32",
  "f64",
  "i8",
  "i16",
  "i32",
  "i64",
  "i128",
  "isize",
  "str",
  "u8",
  "u16",
  "u32",
  "u64",
  "u128",
  "usize",
]);

/** Reserved words (used and reserved-never-used both -- neither can be an
 * identifier), minus true/false which ride "boolean". `macro_rules` is NOT
 * here: it is an ordinary name glued to `!`. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "become",
  "box",
  "break",
  "const",
  "continue",
  "crate",
  "do",
  "dyn",
  "else",
  "enum",
  "extern",
  "final",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "macro",
  "match",
  "mod",
  "move",
  "mut",
  "override",
  "priv",
  "pub",
  "ref",
  "return",
  "Self",
  "self",
  "static",
  "struct",
  "super",
  "trait",
  "try",
  "type",
  "typeof",
  "union",
  "unsafe",
  "unsized",
  "use",
  "virtual",
  "where",
  "while",
  "yield",
]);

/** The registry entry for this lang (assembly list: index.ts). */
export const RUST_SYNTAX: SyntaxDef = {
  lang: "rust",
  tokenize: tokenizeRust,
  extensions: ["rs"],
};
