import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Zig tokenizer.
 *
 * One pass over code (the c.ts/cpp.ts family, which it mirrors closely):
 * `//` opens a "comment" to EOL and that is the ONLY comment form -- Zig
 * has no block comments at all (the pair was removed in 0.10 precisely so
 * every line tokenizes on its own), so a C-shaped `/*`-opener sequence
 * degrades to the two ordinary operator singles `/` and `*` (pinned; the
 * honest contrast with the whole c family). "string" is the double-quoted
 * form with escapes honored (an unterminated literal stops at the
 * newline, a backslash before it splices the line, the c.ts endOfString);
 * the single-quote form rides the same scan, era-tolerant: char literals
 * were real before 0.14 (`'a'` is one string run here -- display has no
 * need of a class of their own, the c.ts ruling) and after their removal
 * a stray apostrophe still stops at the newline, cost bounded. NEW, the
 * zig-distinctive multiline string: a `\\` marker opens a raw string that
 * runs to the end of its line (the marker rides the run, there is NO
 * escape processing -- a quote is just a byte and the docs' own example
 * embeds `"hello world\n"` verbatim), and consecutive `\\` lines
 * continue one string; the file view tokenizes per line so each segment
 * is its own run, lossless either way (the line-wise family). The arm is
 * position-blind: `\\` means nothing else in this language (a lone
 * backslash byte -- a legacy line splice -- rides default). "keyword" for
 * the reserved words CASE-SENSITIVELY (c.ts's shape): the language
 * reference's own 46-word table (addrspace through while; note `use` is
 * gone from it -- the spec overriding this batch's draft list, which was
 * carried over from the 0.10-era vocabulary -- and `error`, `anyframe`,
 * `unreachable`, `opaque` and the pointer-attribute words ARE on it);
 * lowercase-only `true`/`false` ride "boolean" and `null` rides "null"
 * with `undefined` -- the third primitive value -- riding "null" too
 * (it is spelled and used like null, the ruling), while `unreachable` is
 * a keyword per the table. There is NO preproc arm: `#` is not a Zig
 * token and rides default. "type" is REAL here in a way the java family
 * never was: Zig's lowercase builtin types (the reference's Primitive
 * Types table: bool, void, noreturn, type, anyerror, anyopaque, the
 * u8..u128/i8..i128/usize/isize/f16..f128 set, the c_* ABI types, and
 * comptime_int/comptime_float) ride "type" on the c.ts PRIMITIVES
 * precedent -- this is the language where lowercase words ARE types, the
 * dart note reversed; `anyframe` sits in the keyword table instead and
 * rides keyword (the spec splitting where the draft set did not). "type"
 * is also the name directly after struct/enum/union plus the Capitalized
 * heuristic (`Widget` reads as a type, `MAX_SIZE` stays a plain word --
 * the c.ts ruling; Zig's own naming style is lowercase types, which the
 * heuristic honestly misses). The `@` arm is the zig-distinctive one:
 * `@` glued to a name is one "fn" run (`@import`, `@as`, `@This` --
 * the builtins ARE functions and the overwhelming majority of callsites
 * are `@name(`; an `@`-builtin NOT before a paren still reads fn, which
 * is the documented wash: `@embedFile` in prose rides fn too), and an `@`
 * not glued to a name rides default (it is not an operator here). "fn"
 * is also the name after `fn` (kotlin's prevFn shape -- Zig always puts
 * the paren there too, but the arm reads `pub fn name` with the same
 * confidence) and any name directly before `(` (the call peek survives
 * the dot). "number" for decimal/hex/octal/binary (all three radices
 * real, `0X`/`0O`/`0B` too) with `_` separators between digits, floats
 * with e-exponent, and the hex float for REAL including its fractional
 * mantissa and optional p-exponent (`0x103.70p-5` and the p-less
 * `0x103.70` are both literals in the reference -- swift's
 * integer-mantissa restriction is NOT transferred, and the theoretical
 * cost is a `0x`-word whose dotted tail looks like hex digits); there is
 * NO suffix zoo (`1u8` is the number plus the type word, the dart
 * ruling) and NO leading-dot float (a dot wants a digit BEFORE it, so
 * `1.2.3` reads number, dot, number and no lookalike tracking exists,
 * the dart shape); shape validation sends `0x`, `0o8`, `1_` back to
 * default (the octal/binary scan declines the ill-formed tail).
 * Operators: Zig HAS compound assignment (`+=` and the whole zoo), the
 * wrapping forms `+%` `-%` `*%` (with `+%=`, `-%=`, `*%=`), the
 * saturating forms `+|` `-|` `*|` `<<|` (with `+|=`, `-|=`, `*=|` and
 * the four-char `<<|=` -- the only four-char run in the house), the
 * vector concatenation `||` and the array concatenation `++` (so `||` IS
 * a run here even though it is NOT logical or -- the keyword `or` is),
 * the switch-prong `=>`, the range `..`, the deref `.*` (a member
 * gesture: `p.*.field` keeps its member reading) and the optional
 * unwrap `.?`. `&&` is NOT a Zig token (logical and is the keyword
 * `and`) and degrades to two singles, the groovy-rejects-`<=>` doctrine;
 * so do `**` (the power operator was removed), `->`, `?:`, `::`, `??`
 * and `<=>`. The postfix `?` and `!` (optional and error-union types)
 * ride plain singles, and `*` `&` `~` ride plain as pointer/address/
 * bitwise bytes; `[N]`, `[*]` and `[*:0]` brackets ride the operator
 * singles as in cmake. After a `.` or `.*`, every reading but the call
 * peek is refused. Nothing is ever dropped or reordered: concatenating
 * every run reproduces the input exactly, for any input. One run per
 * token; adjacent runs may share a type (sinks coalesce as they like).
 * This is display candy, not a Zig parser.
 */
export function tokenizeZig(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let dot = false; // the previous token was `.` or `.*`
  let prevDecl = false; // the previous token was struct/enum/union
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
      setPrev("comment");
      continue;
    }
    if (c === "\\" && text[i + 1] === "\\") {
      // Multiline string line (the `\\` marker): raw through EOL, no
      // escapes. Per-line calls make each `\\` line its own run.
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
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
    if (c === "@" && IDENT_START_RE.test(text[i + 1] ?? "")) {
      // Builtin function (`@import`, `@as`, `@This`): one fn run, paren
      // or not (the documented wash: a bare @-name reads fn too).
      let j = i + 1;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      push("fn", text.slice(i, j));
      i = j;
      setPrev("fn");
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
    const four = text.slice(i, i + 4);
    if (four === "<<|=") {
      push("operator", four);
      i += 4;
      setPrev("operator");
      continue;
    }
    const three = text.slice(i, i + 3);
    if (THREE_CHAR_OPS.has(three)) {
      push("operator", three);
      i += 3;
      setPrev("operator");
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push("operator", two);
      i += 2;
      setPrev("operator");
      dot = two === ".*"; // deref IS a member gesture; the rest are not
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
    prevFn = word !== undefined && word === "fn";
  }

  /** Builtin types -> booleans/null-values -> keywords (case-sensitive) ->
   * the name after struct/enum/union -> the name after `fn` -> fn (name
   * before `(`) -> Capitalized type. After a dot, every reading but the
   * call peek is refused. */
  function classifyIdent(word: string, after: number): string {
    if (!dot) {
      if (PRIMITIVES.has(word)) return "type";
      if (word === "true" || word === "false") return "boolean";
      if (word === "null" || word === "undefined") return "null";
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

/** `struct`/`enum`/`union` (exact case): the name right after one is a
 * "type" (mostly vestigial -- Zig declares these anonymously -- but the
 * family shape and `union(enum)` pays for it). */
const DECL_KW = new Set(["struct", "enum", "union"]);

/** Interpreted strings: escapes honored, an unterminated literal stops
 * before an unescaped newline -- but a backslash before that newline
 * splices the line and the scan carries on to the closer or end of input
 * (the c.ts/js family). Both quote forms ride this scan; the multiline
 * `\\` lines are a separate arm (raw, no escapes). */
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

/** Three-char operators, checked before the two-char set: the wrapping
 * and saturating compound assignments and the saturating shift (the
 * four-char `<<|=` is checked one rung higher). */
const THREE_CHAR_OPS = new Set(["+%=", "-%=", "*%=", "+|=", "-|=", "*|=", "<<=", ">>=", "<<|"]);

/** Two-char operators: the compound-assignment zoo (Zig HAS them), the
 * wrapping `+%`/`-%`/`*%` and saturating `+|`/`-|`/`*|` pairs, the shift
 * pair, the comparisons, the switch-prong `=>`, the range `..`, the deref
 * `.*` (member position) and the optional unwrap `.?`, plus the
 * concatenations `++` and `||` (the latter is vector concatenation, NOT
 * logical or -- `or` is the keyword). `&&`, `**`, `->`, `?:`, `::`, `??`,
 * `<=>` and `...` DELIBERATELY absent: Zig has no such token and the
 * sequence scans as single-char operators (the groovy doctrine). */
const TWO_CHAR_OPS = new Set([
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "<<",
  ">>",
  "+%",
  "-%",
  "*%",
  "+|",
  "-|",
  "*|",
  "==",
  "!=",
  "<=",
  ">=",
  "=>",
  "..",
  ".*",
  ".?",
  "++",
  "||",
]);

/** Capitalized name (`Widget`, `Thing2`), NOT an all-caps constant
 * (`MAX_SIZE`) and not a mixed-case name (`GtkWidget`) -- the honest
 * typedef heuristic (c.ts). Zig's style guide wants lowercase types,
 * which the heuristic honestly misses. */
const CAPITALIZED_RE = /^[A-Z][a-z0-9_]*$/;

/** The numeric dialect: hex/octal/binary (both prefix cases) with `_`
 * separators, decimals and floats with e-exponent, and the hex float
 * WITH fractional mantissa and optional p-exponent (`0x103.70p-5` and
 * `0x103.70` are both real). NO suffixes and no leading-dot float.
 * Validation sends `0x`, `0o8` (the scan declines the tail), `1_` and
 * `0x.5` back to default. */
const NUM_OK_RE =
  /^(?:0[xX][0-9a-fA-F](?:[0-9a-fA-F_]*[0-9a-fA-F])?(?:\.[0-9a-fA-F](?:[0-9a-fA-F_]*[0-9a-fA-F])?)?(?:[pP][+-]?\d(?:[\d_]*\d)?)?|0[oO][0-7](?:[0-7_]*[0-7])?|0[bB][01](?:[01_]*[01])?|\d(?:[\d_]*\d)?(?:\.\d(?:[\d_]*\d)?)?(?:[eE][+-]?\d(?:[\d_]*\d)?)?)$/;

const isNumberStart = (c: string): boolean => /[0-9]/.test(c);

function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  if (text[i] === "0" && /[xXoObB]/.test(text[i + 1] ?? "")) {
    const radix = text[i + 1]!;
    i += 2;
    if (radix === "x" || radix === "X") {
      while (i < n && /[0-9a-fA-F_]/.test(text[i]!)) i++;
      if (text[i] === "." && /[0-9a-fA-F]/.test(text[i + 1] ?? "")) {
        i++;
        while (i < n && /[0-9a-fA-F_]/.test(text[i]!)) i++;
      }
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
    const digits = radix === "o" || radix === "O" ? /[0-7_]/ : /[01_]/;
    while (i < n && digits.test(text[i]!)) i++;
    return i;
  }
  while (i < n && /[0-9_]/.test(text[i]!)) i++;
  if (text[i] === "." && /[0-9]/.test(text[i + 1] ?? "")) {
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

/** The builtin types ride "type" (the reference's Primitive Types table;
 * this is the language where lowercase words ARE types -- the dart note
 * reversed). `anyframe` is NOT here: the reference lists it among the
 * keywords, and keywords are the keyword set's business. */
const PRIMITIVES: ReadonlySet<string> = new Set([
  "anyerror",
  "anyopaque",
  "bool",
  "c_char",
  "c_int",
  "c_long",
  "c_longdouble",
  "c_longlong",
  "c_short",
  "c_uint",
  "c_ulong",
  "c_ulonglong",
  "c_ushort",
  "comptime_float",
  "comptime_int",
  "f128",
  "f16",
  "f32",
  "f64",
  "f80",
  "i128",
  "i16",
  "i32",
  "i64",
  "i8",
  "isize",
  "noreturn",
  "type",
  "u128",
  "u16",
  "u32",
  "u64",
  "u8",
  "usize",
  "void",
]);

/** The reserved words (the language reference's Keyword Reference table,
 * all 46, exact case), minus true/false/null/undefined which ride
 * boolean/null. `use` is GONE from the table (the 0.10-era draft list
 * carried it; the spec overrides); `error`, `anyframe`, `unreachable`,
 * `opaque`, `bitpack` and the pointer-attribute words are on it. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "addrspace",
  "align",
  "allowzero",
  "and",
  "anyframe",
  "anytype",
  "asm",
  "bitpack",
  "break",
  "callconv",
  "catch",
  "comptime",
  "const",
  "continue",
  "defer",
  "else",
  "enum",
  "errdefer",
  "error",
  "export",
  "extern",
  "fn",
  "for",
  "if",
  "inline",
  "linksection",
  "noalias",
  "noinline",
  "nosuspend",
  "opaque",
  "or",
  "orelse",
  "pub",
  "resume",
  "return",
  "struct",
  "suspend",
  "switch",
  "test",
  "threadlocal",
  "try",
  "union",
  "unreachable",
  "var",
  "volatile",
  "while",
]);

/** The registry entry for this lang (assembly list: index.ts). No
 * aliases: the canonical name is the fence word, and `.zig` is the only
 * extension (the house rule keeps the list minimal). */
export const ZIG_SYNTAX: SyntaxDef = {
  lang: "zig",
  tokenize: tokenizeZig,
  extensions: ["zig"],
};
