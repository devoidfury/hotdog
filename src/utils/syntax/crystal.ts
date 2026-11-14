import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Crystal tokenizer.
 *
 * The ruby clone (ruby.ts is the base; dart.ts the clone exemplar) with a
 * verified DELTA list against the reference and the compiler lexer. Kept
 * from ruby: `#` opens the only "comment" form to EOL (the shebang rides
 * it); double-quoted "string" with escapes honored (unterminated stops at
 * the newline, a backslash before it splices the line, the c.ts
 * endOfString) with the `#{...}` interpolation hole INSIDE the run (the
 * rust ruling: holes are not parsed, so a quote inside a hole closes the
 * literal); symbols `:sym`, `:"quoted"`, `:'quoted'` ride "string" with
 * ruby's `!`/`?` ending absorption (one mark, never `!=`); `@ivar`/`@@cvar`
 * ride "variable" (php's class) and a lone `@` rides default; heredocs
 * `<<IDENT`/`<<-IDENT`/`<<~IDENT` with the quoted label forms take ruby's
 * endOfHeredoc verbatim (closer line, indentation tolerance per the
 * marker, the line's tail riding the next run); `::` and `.` set the dot;
 * `self`/`super` ride keyword; the Capitalized type heuristic; the
 * ternary `?`/`:` ride operators. THE DELTAS, each pinned: NO
 * `=begin`/`=end` block comment (Crystal has only `#`, so `=begin` reads
 * operator plus the keyword `begin`); NO `?c` char arm (no such literal
 * here; `?a` is the ternary mark plus a word); NO `$` globals (a `$` is a
 * plain default byte). Single quotes open a CHAR, not a string: `'a'` is
 * a Char literal (the java endOfCharLiteral arm as swift uses it, plus
 * the documented `\\u{...}` spelling), riding "string", while `'ab'` is
 * not a literal and the quote rides degraded default bytes -- the pinned
 * contrast with ruby's string quotes. NEW annotation arm: `@[` (the
 * sequence itself arms it, no line position involved) runs through the
 * balanced bracket group as one "decorator" run -- strings (both quote
 * forms) and comments inside are skipped so their brackets cannot cut the
 * run short; no closer anywhere runs to end of input. Numbers: the radix
 * forms are 0x/0b/0o ONLY -- there is NO legacy `0NNN` octal, so `0777`
 * is a plain decimal (the pinned contrast with ruby), with `_`
 * separators, floats with exponent (`1e10` needs no dot) and the width-
 * suffix zoo `_i8/_i16/_i32/_i64/_i128`, `_u8..._u128`, `_f32/_f64` with
 * the underscore OPTIONAL and legal on radix forms too (`1i64`, `0xF_u8`
 * are the reference's own shape); `1_f32` is a Float32, so integer parts
 * may carry float suffixes; shape validation sends `0x`, `1_`, `0o8` back
 * to default, and there is no leading-dot float (`.5` raises at compile
 * time, the lexer's own message). Operators (the compiler's operator
 * whitelist): the three-char runs are checked FIRST (the dart lesson) --
 * `<=>`, `===`, `...`, `&**` and the combined-assignment tails `**=`,
 * `<<=`, `>>=`, `&&=`, `||=`, `//=`, `&+=`, `&-=`, `&*=`; the two-char
 * set carries `**`, `=>` (the hash rocket), `==`, `!=`, `=~`, `!~`, `<=`,
 * `>=`, `&&`, `||`, `..`, `->` (the proc literal, NOT member), the
 * overflow family `&+`, `&-`, `&*`, the floor division `//`, the shifts
 * `<<`/`>>` (past the heredoc arm's glue rule) and the combined
 * assignments `+=`, `-=`, `*=`, `/=`, `%=`, `|=`, `&=`, `^=`. The safe
 * navigation `&.` is NOT a Crystal token (removed with the `try` method;
 * the lexer has no such sequence) and degrades to `&` plus the member
 * dot. PERCENT literals (`%w[]`, `%i[]`, `%(...)`, `%r{}`) are real
 * Crystal and get NO arm: ruby rejects them the same way, and the
 * reference's delimiter-balancing is not a two-liner, so `%w[a b]` rides
 * `%` operator, `w` word, bracketed words -- the pinned doctrine. The
 * keyword set is the compiler lexer's reserved words verbatim, lowercase
 * and CASE-SENSITIVE, `true`/`false` riding "boolean" and `nil` riding
 * "null" (the lexer spells the question-mark keywords `is_a?`, `nil?` and
 * `responds_to?` -- the OLD reference's `isa?`/`respond_to??` spellings
 * do not exist -- and they land here through the identifier scan's
 * trailing-mark absorption; `type`, `of`, `private` and friends are
 * reserved words too, riding keyword as the lexer emits them). prevFn
 * arms after `def` AND `fun` (the C-binding declaration names its
 * function with no paren-free choice), and the DECL_KW name reading covers
 * class/module/struct/union/lib/enum/alias; there are no primitive
 * keywords because the language has none. Identifiers keep ruby's one
 * glued `?`/`!` tail (`nil_or_not?`, `save!`, never `!=`). Unclosed
 * constructs run to end of input; per-line statelessness is the house
 * ceiling (the file view tokenizes line by line, so a multi-line heredoc
 * carries its class whole only when the document reaches the tokenizer,
 * the php/ruby story). Nothing is ever dropped or reordered:
 * concatenating every run reproduces the input exactly, for any input.
 * One run per token; adjacent runs may share a type (sinks coalesce as
 * they like). This is display candy, not a Crystal parser.
 */
export function tokenizeCrystal(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let dot = false; // the previous token was `.` or `::`
  let prevDecl = false; // the previous token was class/module/struct/...
  let prevFn = false; // the previous token was def/fun

  while (i < n) {
    const c = text[i]!;
    if (isWs(c)) {
      let j = i;
      while (j < n && isWs(text[j])) j++;
      push("default", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "#") {
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
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
      // A Char is quote-char-quote (java's shape as swift uses it);
      // anything else between quotes is not a literal and the quote rides
      // default bytes (the pinned contrast with ruby).
      const end = endOfCharLiteral(text, i);
      if (end !== -1) {
        push("string", text.slice(i, end));
        i = end;
        setPrev("string");
        continue;
      }
    }
    if (c === "<" && text[i + 1] === "<") {
      const end = endOfHeredoc(text, i);
      if (end !== -1) {
        push("string", text.slice(i, end));
        i = end;
        setPrev("string");
        continue;
      }
      // `<<` with nothing glued (a shift, `a << b`): the operator arm
      // below eats it, two-char first (`<<=` is a combined assignment).
    }
    if (c === "@" && text[i + 1] === "[") {
      const end = endOfAnnotation(text, i);
      push("decorator", text.slice(i, end));
      i = end;
      setPrev("decorator");
      continue;
    }
    if (c === "@" && (IDENT_START_RE.test(text[i + 1] ?? "") || (text[i + 1] === "@" && IDENT_START_RE.test(text[i + 2] ?? "")))) {
      let j = i + 1;
      if (text[j] === "@") j++;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      push("variable", text.slice(i, j));
      i = j;
      setPrev("variable");
      continue;
    }
    if (c === ":" && (IDENT_START_RE.test(text[i + 1] ?? "") || text[i + 1] === '"' || text[i + 1] === "'")) {
      let j: number;
      if (text[i + 1] === '"' || text[i + 1] === "'") {
        j = endOfString(text, i + 1);
      } else {
        j = absorbTrailingMark(text, scanIdent(text, i + 1));
      }
      push("string", text.slice(i, j));
      i = j;
      setPrev("string");
      continue;
    }
    if (IDENT_START_RE.test(c)) {
      const j = absorbTrailingMark(text, scanIdent(text, i));
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
      dot = false; // spaceship, eeq and range are not member gestures
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push("operator", two);
      i += 2;
      setPrev("operator");
      dot = two === "::"; // a constant/scope reference IS a member position; `->` (the proc literal) is not
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
    prevFn = word !== undefined && PREV_FN.has(word);
  }

  /** Booleans/null (lowercase only, the language is case-sensitive) ->
   * keywords (case-sensitive) -> the name after a DECL_KW -> the name
   * after def/fun -> fn (name before `(`, the peek surviving the dot) ->
   * Capitalized type. After a dot, every reading but the call peek is
   * refused. */
  function classifyIdent(word: string, after: number): string {
    if (!dot) {
      if (word === "true" || word === "false") return "boolean";
      if (word === "nil") return "null";
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

/** The declaration words (exact case): the name right after one is a
 * "type". */
const DECL_KW = new Set(["class", "module", "struct", "union", "lib", "enum", "alias"]);

/** def/fun: the next word is the function NAME (the C-binding `fun`
 * declaration gets the same reading as `def`, the pinned decision). */
const PREV_FN = new Set(["def", "fun"]);

/** Strings: escapes honored, an unterminated literal stops before an
 * unescaped newline -- but a backslash before that newline splices the
 * line and the scan carries on to the closer or end of input (the c.ts/
 * js family). Interpolation (`#{expr}`) rides the string run -- the rust
 * format-string ruling. Only double quotes reach here: single quotes are
 * chars. */
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

/** Heredoc from `<<`: an optional `-`/`~` marker, then an identifier glued
 * (quoted forms included, backtick too; `<< b` with air is a shift). The
 * closer is a line beginning with the same label (case-sensitive):
 * `<<-`/`<<~` tolerate indentation past it, the bare spelling wants column
 * 0 as the language does; the run ends right after the closer word (the
 * line's tail rides the next run). Returns the end index, or -1 when
 * there is no glued label; a never-closed opener runs to end of input.
 * ruby.ts's function verbatim. */
function endOfHeredoc(text: string, from: number): number {
  let j = from + 2;
  let indented = false;
  if (text[j] === "-" || text[j] === "~") {
    indented = true;
    j++;
  }
  let quote: string | undefined;
  if (text[j] === "'" || text[j] === '"' || text[j] === "`") {
    quote = text[j];
    j++;
  }
  const idStart = j;
  while (j < text.length && IDENT_RE.test(text[j]!)) j++;
  const label = text.slice(idStart, j);
  if (label === "") return -1;
  if (quote !== undefined) {
    if (text[j] !== quote) return -1; // unterminated label quote: not a readable heredoc
    j++;
  }
  let line = j;
  while (line < text.length) {
    const nl = text.indexOf("\n", line);
    const lineEnd = nl === -1 ? text.length : nl + 1;
    let k = line;
    if (indented) {
      while (k < lineEnd && (text[k] === " " || text[k] === "\t")) k++;
    }
    if (text.startsWith(label, k) && !IDENT_RE.test(text[k + label.length] ?? "")) return k + label.length;
    line = lineEnd;
  }
  return text.length;
}

/** Char literal: exactly one character or escape between the quotes (the
 * `\\uXXXX` and the `\\u{...}` spellings included, the reference's two).
 * Returns the end index, or -1 when the shape fails -- `'ab'` is NOT a
 * literal in this language and the caller lets the quote ride default
 * bytes (the pinned contrast with ruby's string quotes and with the
 * single-quoted-atom reading of erlang). */
function endOfCharLiteral(text: string, from: number): number {
  let j = from + 1;
  if (text[j] === "\\") {
    if (text[j + 1] === "u") {
      let k = j + 2;
      if (text[k] === "{") {
        k++;
        while (k < text.length && /[0-9a-fA-F]/.test(text[k]!)) k++;
        j = text[k] === "}" ? k + 1 : -1;
        if (j === -1) return -1;
      } else {
        while (k < text.length && k < j + 6 && /[0-9a-fA-F]/.test(text[k]!)) k++;
        j = k;
      }
    } else {
      j += 2;
    }
  } else {
    j++;
  }
  return text[j] === "'" ? j + 1 : -1;
}

/** Annotation from `@[`: one "decorator" run through the balanced bracket
 * group (`@[Name]`, `@[Link("lib")]`); strings (both quote forms) and
 * comments inside are skipped so their brackets cannot cut the run short;
 * no closer anywhere runs to end of input. The `@[` sequence itself arms
 * it -- no line position is involved. */
function endOfAnnotation(text: string, from: number): number {
  let j = from + 2; // spend the `@[`
  let depth = 1;
  while (j < text.length) {
    const d = text[j]!;
    if (d === "[") {
      depth++;
      j++;
    } else if (d === "]") {
      depth--;
      j++;
      if (depth === 0) return j;
    } else if (d === '"' || d === "'") {
      j = endOfString(text, j);
    } else if (d === "#") {
      while (j < text.length && text[j] !== "\n" && text[j] !== "\r") j++;
    } else j++;
  }
  return text.length;
}

/** The `?`/`!` method-name tail (`nil_or_not?`, `save!`): absorbed when
 * glued -- one mark only, and never `!=`, so `foo!=bar` stays `foo` `!=`
 * `bar`. This is also how the lexer's `is_a?`/`nil?`/`responds_to?`
 * keywords reach the keyword set. */
function absorbTrailingMark(text: string, j: number): number {
  if (text[j] === "?") return j + 1;
  if (text[j] === "!" && text[j + 1] !== "=") return j + 1;
  return j;
}

function scanIdent(text: string, from: number): number {
  let j = from;
  while (j < text.length && IDENT_RE.test(text[j]!)) j++;
  return j;
}

const IDENT_START_RE = /[A-Za-z_\u00a0-\uffff]/;
const IDENT_RE = /[\w\u00a0-\uffff]/;
const OPERATOR_RE = /[{}()[\];,.:?+\-*/%&|^!~=<>]/;

/** Three-char operators, checked before the two-char set (the dart
 * lesson): the classic trio plus the wrapping exponentiation and the
 * combined-assignment tails the compiler lexes as single tokens. */
const THREE_CHAR_OPS = new Set([
  "<=>",
  "===",
  "...",
  "&**",
  "**=",
  "<<=",
  ">>=",
  "&&=",
  "||=",
  "//=",
  "&+=",
  "&-=",
  "&*=",
]);

/** Two-char operators: ruby's set (`=>` the hash rocket, `**`, `..`,
 * `->` the proc literal that does NOT set the dot, `::` that does) plus
 * the overflow family `&+`/`&-`/`&*`, the floor division `//`, the shifts
 * `<<`/`>>` (reached only past the heredoc glue rule) and the combined
 * assignments. The safe navigation `&.` is NOT a Crystal token (the
 * compiler has no such sequence; `try` replaced it) and degrades to `&`
 * plus the member dot, the pinned spec-over-plan correction. */
const TWO_CHAR_OPS = new Set([
  "=>",
  "**",
  "::",
  "==",
  "!=",
  "=~",
  "!~",
  "<=",
  ">=",
  "&&",
  "||",
  "..",
  "->",
  "&+",
  "&-",
  "&*",
  "//",
  "<<",
  ">>",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "|=",
  "&=",
  "^=",
]);

/** Capitalized name (`Widget`, `Thing2`), NOT an all-caps constant
 * (`MAX_SIZE`) and not a mixed-case name (`ArgumentError`) -- the c.ts
 * typedef heuristic, kept from ruby. */
const CAPITALIZED_RE = /^[A-Z][a-z0-9_]*$/;

/** The numeric dialect (the reference's, verified): radix forms 0x/0b/0o
 * with `_` separators -- NO legacy `0NNN` octal, so `0777` is a decimal
 * (the pinned contrast with ruby) -- decimals and floats with exponent
 * (`1e10` needs no dot), and the width suffixes `_i8..._i128`,
 * `_u8..._u128`, `_f32/_f64` with the underscore OPTIONAL (the reference:
 * "the underscore before the suffix is optional"), legal on integer
 * parts (`1_f32`) and radix forms alike. There is no leading-dot float
 * (`.5` is rejected by the compiler itself, whose lexer even names the
 * rule in its error). Validation sends `0x`, `1_`, `0o8` back to default. */
const NUM_OK_RE =
  /^(?:0[xX][0-9a-fA-F](?:[0-9a-fA-F_]*[0-9a-fA-F])?|0[bB][01](?:[01_]*[01])?|0[oO][0-7](?:[0-7_]*[0-7])?|\d(?:[\d_]*\d)?(?:\.\d(?:[\d_]*\d)?)?(?:[eE][+-]?\d(?:[\d_]*\d)?)?)(?:_?(?:i(?:8|16|32|64|128)|u(?:8|16|32|64|128)|f(?:32|64)))?$/;

const isNumberStart = (c: string): boolean => /[0-9]/.test(c);

const NUM_SUFFIX_RE = /^_?(?:i(?:8|16|32|64|128)|u(?:8|16|32|64|128)|f(?:32|64))(?![\w])/;

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

/** The reserved words, the compiler lexer's set verbatim (exact case),
 * minus true/false/nil which ride boolean/null. The question-mark
 * spellings are the lexer's own (`is_a?`, `nil?`, `responds_to?` -- the
 * old reference's `isa?`/`respond_to??` do not exist) and arrive through
 * the identifier scan's trailing-mark absorption. Contextual reserveds
 * like `type`, `of`, `private` ride keyword exactly as the lexer emits
 * them, the honest display cost being a `def type`-style method name
 * reading keyword before the prevFn/peek readings do (ruby orders them
 * the same way). */
const KEYWORDS: ReadonlySet<string> = new Set([
  "abstract",
  "alias",
  "alignof",
  "annotation",
  "as",
  "asm",
  "begin",
  "break",
  "case",
  "class",
  "def",
  "do",
  "else",
  "elsif",
  "end",
  "ensure",
  "enum",
  "extend",
  "for",
  "fun",
  "if",
  "include",
  "instance_alignof",
  "instance_sizeof",
  "is_a?",
  "lib",
  "macro",
  "module",
  "next",
  "nil?",
  "of",
  "offsetof",
  "out",
  "pointerof",
  "private",
  "protected",
  "require",
  "rescue",
  "responds_to?",
  "return",
  "select",
  "self",
  "sizeof",
  "struct",
  "super",
  "then",
  "type",
  "typeof",
  "uninitialized",
  "union",
  "unless",
  "until",
  "verbatim",
  "when",
  "while",
  "with",
  "yield",
]);

/** The registry entry for this lang (assembly list: index.ts). No
 * aliases: the canonical name is the fence word. `.ecr` (the template
 * dialect) is NOT crystal -- html-with-tags, the erb doctrine. */
export const CRYSTAL_SYNTAX: SyntaxDef = {
  lang: "crystal",
  tokenize: tokenizeCrystal,
  extensions: ["cr"],
};
