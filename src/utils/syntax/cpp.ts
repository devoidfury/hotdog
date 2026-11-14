import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * C++ tokenizer.
 *
 * One pass over code: the c.ts shape transfers wholesale (cpp.ts grew from
 * that scan), with the C++ deltas spelled out here. A line-leading `#`
 * (past any indentation) is one "preproc" run through the line end --
 * directives read whole, trailing comment or angle-bracket header
 * included, and a directive carried to the next physical line by a
 * backslash continuation just stops there (the line-wise family; the
 * continuation tail re-tokenizes on its own). `//` opens a "comment" to
 * EOL and the block form runs to its closer or end of input, NEVER nested
 * (the grammar does not nest them, unlike kotlin). "string" covers both
 * quote forms -- char literals ride the same scan, display has no need of
 * a class of their own, the c.ts ruling -- with the wide/UTF prefixes
 * L/u8/u/U glued to the opening quote joining the run, escapes honored,
 * an unterminated literal stopping at the newline, and a backslash before
 * it splicing past (the c.ts endOfString). NEW, because raw strings are
 * real and common: a glued `R"` -- the prefixed spellings `LR"`, `u8R"`,
 * `uR"`, `UR"` too, reached through the word scan itself, since `u8R` is
 * one identifier token -- with an optional delimiter scans to the first
 * `)` + delimiter + `"` or end of input, with NO escape processing (the
 * backslash is raw, that is the point). An ill-formed delimiter
 * (whitespace, a quote or a paren or a backslash before the `(`) is not a
 * raw string: the word rides as itself (`R` alone is Capitalized-shaped,
 * so type, the family's heuristic) and the quote opens the ordinary scan.
 * The `[[...]]` attribute is one "decorator" run: balanced brackets,
 * strings (the raw form included) and comments inside skipped so their
 * brackets cannot cut the run short, no closer anywhere runs to end of
 * input. Unlike the cs.ts attribute there is NO position-arming here: a
 * doubled bracket is unambiguous in this language (an index cannot nest a
 * bracketed expression), so even `a[[maybe_unused]]` reads as the
 * attribute-qualified subscript, which is exactly what the language says
 * it is. "keyword" for the reserved words CASE-SENSITIVELY (like c.ts,
 * like java), with lowercase-only `true`/`false` riding "boolean" and
 * `nullptr` riding "null" (there is no `null` keyword; `NULL` is a
 * macro-shaped word and rides default). The set is the C++ reserved set:
 * the coroutine trio co_await/co_return/co_yield, concept and requires,
 * the alternative operator tokens (and/or/not/xor, the _eq family,
 * bitand/bitor/compl -- they ARE keywords, reserved names no legal
 * program spends on identifiers), the cast spellings and friends; C's
 * `restrict` is absent (not a C++ keyword), `register` stays listed for
 * the pre-C++17 dialects, and the contextual `final`/`override` are
 * listed, the java record/sealed precedent. "type" for the primitive
 * keywords -- C++'s `bool` joins (it is a keyword here, unlike c.ts),
 * and so do the fundamental wide-character types wchar_t/char8_t/
 * char16_t/char32_t (they name types, that is the ruling) -- the name
 * directly after struct/union/enum/class/namespace, and Capitalized
 * names (`Widget` reads as a class, `MAX_SIZE` stays a plain word -- the
 * c.ts heuristic); generics angle brackets ride plain operators. "fn" is
 * any name directly before `(` (the call peek survives the dot and claims
 * `Foo(...)` constructor calls, like the java family); there is no def
 * keyword, so there is no prevFn arm. "number" keeps the c.ts dialect
 * whole: hex/binary/octal/decimal, floats with exponent, the u/l/ll/f
 * suffixes, and the `1.2.3` lookalike rule (leading-dot floats are real
 * here, so the prevType tracking transfers, unlike the java family); the
 * C++14 `'` digit separators keep c.ts's documented degradation (`1'000`
 * is the number plus an open char scan) and hex floats ride along
 * degraded. `->` is one "operator" run and a member position (c.ts's
 * ruling, and C++'s dominant arrow); `::` (scope resolution, the java
 * ruling) and the pointer-to-member forms `.*` and `->*` are runs and
 * member positions too. One run each: `==`, `!=`, `<=`, `>=`, `&&`,
 * `||`, `++`, `--`, `<<`, `>>`, `<<=`, `>>=`, the C++20 logical
 * assignments `&&=` and `||=`, the ellipsis `...`, and the three-way
 * comparison `<=>` -- the spaceship IS a three-char run here, the honest
 * contrast with the groovy rejection (there the operator does not
 * exist). The elvis `?:` does NOT exist and degrades to two singles;
 * `??`, `=>`, `?.` and `<-` do not either, and degrade too. The dot flag
 * refuses every reading but the call peek after a member gesture, the
 * documented cost being that a lambda trailing return type (`-> bool`,
 * `-> Widget`) reads as a plain word. Honest limits carried and new: a
 * colon glued to a word (bitfield, label) gets no "key" reading;
 * `size_t` is a typedef and rides a plain word; a user-defined literal
 * (`5_km`) is the number plus a word; a `#` at the start of a line inside
 * a multi-line block comment reads as a directive when the file view
 * tokenizes that line alone. Nothing is ever dropped or reordered:
 * concatenating every run reproduces the input exactly, for any input.
 * One run per token; adjacent runs may share a type (sinks coalesce as
 * they like). This is display candy, not a C++ parser.
 */
export function tokenizeCpp(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let lineStart = true; // nothing significant pushed since the last newline
  let dot = false; // the previous token was `.`, `->`, `::`, `.*` or `->*`
  let prevDecl = false; // the previous token was struct/union/enum/class/namespace
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
    if (c === "[" && text[i + 1] === "[") {
      const end = endOfAttribute(text, i);
      push("decorator", text.slice(i, end));
      i = end;
      setPrev("decorator");
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
      // Raw string (`R"delim(...)delim"`, prefixed spellings included):
      // the word scan ate the glued head, so the check lives here. An
      // ill-formed delimiter degrades to word + ordinary quote scan.
      if (text[j] === '"' && isRawHead(word)) {
        const end = endOfRawString(text, j);
        if (end !== -1) {
          push("string", text.slice(i, end));
          i = end;
          setPrev("string");
          continue;
        }
      }
      // A wide-string prefix glued to an opening quote (`L"wide"`,
      // `u8"utf8"`): the prefix joins the string run (the c.ts arm).
      if ((text[j] === '"' || text[j] === "'") && STRING_PREFIXES.has(word)) {
        const end = endOfString(text, j);
        push("string", text.slice(i, end));
        i = end;
        setPrev("string");
        continue;
      }
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
    const three = text.slice(i, i + 3);
    if (THREE_CHAR_OPS.has(three)) {
      push("operator", three);
      i += 3;
      setPrev("operator");
      dot = three === "->*"; // pointer-to-member IS a member gesture
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push("operator", two);
      i += 2;
      setPrev("operator");
      dot = two === "->" || two === "::" || two === ".*"; // arrow, scope, member-pointer
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

  /** Primitives -> keywords -> the name after struct/union/enum/class/
   * namespace -> fn (name before `(`) -> Capitalized type. After a dot,
   * every reading but the call peek is refused. */
  function classifyIdent(word: string, after: number): string {
    if (!dot) {
      if (PRIMITIVES.has(word)) return "type";
      if (word === "true" || word === "false") return "boolean";
      if (word === "nullptr") return "null";
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

/** `struct`/`union`/`enum`/`class`/`namespace`: the name right after one
 * is a "type" (c.ts's arm plus the two C++ specifiers). */
const DECL_KW = new Set(["struct", "union", "enum", "class", "namespace"]);

/** Interpreted strings (one scan for both quote forms): escapes honored,
 * an unterminated literal stops before an unescaped newline -- but a
 * backslash before that newline splices the line, so the scan carries on
 * to the closer or end of input (the c.ts/js family). */
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

/** The glued head of a raw string: a lone `R` or a string prefix + `R`
 * (`LR`, `u8R`, `uR`, `UR` -- the word scan eats them as one token). */
const isRawHead = (word: string): boolean =>
  word === "R" || (word.length > 1 && word.endsWith("R") && STRING_PREFIXES.has(word.slice(0, -1)));

/** Raw string from the opening quote: the optional delimiter runs to `(`
 * (whitespace, a quote, a backslash or a paren makes it ill-formed and
 * the caller degrades to the ordinary scan), then the body runs to the
 * first `)` + delimiter + `"` or end of input. NO escape processing -- a
 * backslash is raw, which matches the language. */
function endOfRawString(text: string, from: number): number {
  let k = from + 1;
  while (k < text.length && text[k] !== "(") {
    if (/[\s"'\\()]/.test(text[k]!)) return -1;
    k++;
  }
  if (text[k] !== "(") return -1; // no opener anywhere: not a raw string
  const closer = ")" + text.slice(from + 1, k) + '"';
  const end = text.indexOf(closer, k + 1);
  return end === -1 ? text.length : end + closer.length;
}

/** `[[...]]` through the bracket-balanced closer: strings (the raw form
 * included) and comments inside are skipped so their brackets cannot cut
 * the run short; no closer anywhere runs to the end of input. No position
 * arming -- the doubled bracket is unambiguous here (unlike cs.ts). */
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
    } else if (d === "R" && text[j + 1] === '"') {
      const end = endOfRawString(text, j + 1);
      j = end === -1 ? j + 1 : end;
    } else if (d === '"' || d === "'") {
      j = endOfString(text, j);
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

/** Prefixes glued to an opening quote or the raw `R` (case-sensitive per
 * the standard). */
const STRING_PREFIXES = new Set(["L", "u", "U", "u8"]);

/** Three-char operators, checked before the two-char set: the spaceship
 * `<=>` IS a run here (the groovy contrast: that language has no such
 * operator, C++ does), `->*` is pointer-to-member (checked before the
 * `->` arm can see it), `...` is the ellipsis of varargs, and the shift-
 * and logical-assign compound spellings (`&&=`/`||=` are C++20). */
const THREE_CHAR_OPS = new Set(["<=>", "->*", "...", "<<=", ">>=", "&&=", "||="]);

/** Two-char operators. `->` IS a member position (c.ts's ruling, not
 * java's: in C++ the arrow is member access, the lambda arrow being the
 * rarer spelling -- the documented cost is the trailing return type);
 * `::` is scope resolution (the java ruling) and `.*` pointer-to-member,
 * both member positions. The elvis `?:` does NOT exist (two singles),
 * nor do `??`, `=>` or `?.`. */
const TWO_CHAR_OPS = new Set([
  "->",
  "::",
  ".*",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "++",
  "--",
  "<<",
  ">>",
]);

/** Capitalized name (`Widget`, `Thing2`), NOT an all-caps macro constant
 * (`MAX_SIZE`) and not a mixed-prefix name (`GtkWidget`) -- the honest
 * typedef heuristic (c.ts). */
const CAPITALIZED_RE = /^[A-Z][a-z0-9_]*$/;

/** The numeric dialect, c.ts's verbatim: radix forms, octal, floats with
 * exponent, and the suffix zoo. Shape validation at the call site sends
 * `0x`, `1e`-tails and lookalikes back to default; the C++14 `'` digit
 * separators and hex floats degrade, documented. */
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

/** Primitive keywords ride "type": C's set plus C++'s `bool` (a keyword
 * here where c.ts had to leave it a stdbool typedef) and the fundamental
 * wide-character types -- they name types, so they ride type (the
 * ruling). `size_t` is still a typedef and rides a plain word. */
const PRIMITIVES: ReadonlySet<string> = new Set([
  "bool",
  "char",
  "char8_t",
  "char16_t",
  "char32_t",
  "double",
  "float",
  "int",
  "long",
  "short",
  "signed",
  "unsigned",
  "void",
  "wchar_t",
  "_Bool",
]);

/** The reserved words (the C++ set: c.ts's minus `restrict`, plus the
 * coroutine trio, concept/requires, the casts, the alternative operator
 * tokens -- and/or/not/xor and friends are reserved, not sugar to this
 * display -- the access-control words, templates, and the contextual
 * final/override listed like java's record/sealed. `register` stays for
 * the pre-C++17 dialects. true/false/nullptr are handled separately as
 * boolean/null; the primitives ride type. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "alignas",
  "alignof",
  "and",
  "and_eq",
  "asm",
  "auto",
  "bitand",
  "bitor",
  "break",
  "case",
  "catch",
  "class",
  "co_await",
  "co_return",
  "co_yield",
  "compl",
  "concept",
  "const",
  "consteval",
  "constexpr",
  "constinit",
  "continue",
  "decltype",
  "default",
  "delete",
  "do",
  "dynamic_cast",
  "else",
  "enum",
  "explicit",
  "export",
  "extern",
  "final",
  "for",
  "friend",
  "goto",
  "if",
  "inline",
  "mutable",
  "namespace",
  "new",
  "not",
  "not_eq",
  "noexcept",
  "operator",
  "or",
  "or_eq",
  "override",
  "private",
  "protected",
  "public",
  "register",
  "reinterpret_cast",
  "requires",
  "return",
  "sizeof",
  "static",
  "static_assert",
  "static_cast",
  "struct",
  "switch",
  "template",
  "this",
  "thread_local",
  "throw",
  "try",
  "typedef",
  "typeid",
  "typename",
  "union",
  "using",
  "virtual",
  "volatile",
  "while",
  "xor",
  "xor_eq",
]);

/** The registry entry for this lang (assembly list: index.ts). The C++
 * spellings moved here from c.ts at the re-split: `c` kept c/h and the
 * CUDA/shader dialects, and `.h` staying there is the honest ruling --
 * a header's dialect (C or C++) is undecidable display-wise, and the c
 * scanner reads a C++ header honestly enough. No aliases: the canonical
 * name is the fence word. The tail claims are all real C++ spellings and
 * nothing else (`.inl`, `.tcc` etc. are NOT claimed -- the house rule
 * keeps the list minimal). */
export const CPP_SYNTAX: SyntaxDef = {
  lang: "cpp",
  tokenize: tokenizeCpp,
  extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "ipp"],
};
