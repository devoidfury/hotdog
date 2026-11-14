import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Ruby tokenizer.
 *
 * One pass over code (the java.ts/cs.ts family, which it mirrors closely):
 * `#` opens a "comment" to EOL -- the only line-comment spelling, there is
 * no `//` in ruby, so a slash NEVER opens a comment; that is also why regex
 * literals ride plain: the regex-vs-division ambiguity is undecidable
 * without parser state the per-line house does not have, so `/` is always
 * an operator and a regex body is scanned as ordinary code. The
 * `=begin`/`=end` block comment is position-armed like c.ts's `#` directive
 * (line-leading, past any indentation; any other token spends it, so
 * `x =begin` reads equals-then-`begin` keyword): the run reaches an `=end`
 * whose line begins with it past any indent (the language itself is
 * stricter, column 0), with a word-boundary check so `=beginner` stays the
 * ordinary word; no closer anywhere runs to the end of input. "string" is
 * rich here: single/double quotes with escapes honored (an unterminated
 * literal stops at the newline, a backslash before it splices the line,
 * the c.ts endOfString) and interpolation `#{...}` stays inside the run
 * (the rust format-string ruling -- the holes are not parsed, so a quote
 * inside a hole closes the literal); heredocs `<<IDENT`, `<<-IDENT`,
 * `<<~IDENT` and the quoted (`<<'EOT'`, backtick included) spellings run to
 * the closer line -- `<<-`/`<<~` take an indented closer, the bare spelling
 * wants column 0 as the language does -- and the closer line's tail rides
 * the next run (ruby's terminator takes no semicolon, unlike php); `<<`
 * with nothing glued after it is the ordinary shift and the operator arm
 * eats it one char at a time (the documented cost of the glue rule: an
 * unterminated heredoc swallows the input). %-literals (`%w[]`, `%q{}`)
 * get no arm and ride plain, their contents scanned as code. `?c` char
 * literals take a simple rule: one char or one escape (the `\uXXXX`
 * spelling included) glued to the `?` with the language's own
 * non-identifier boundary after it, so a spaced ternary `a ? b` keeps its
 * operator `?` (the glued `cond ?x : y` washes as a char literal, which
 * ruby itself calls ambiguous). Symbols are ruby's signature candy and
 * ride "string": a `:` glued to a name or to a quoted form (`:sym`,
 * `:'a b'`, `:"x"`) is one run, while the ternary mark `:` needs air and
 * `Foo::Bar` is the member `::` operator that sets the dot, never a symbol
 * (the documented cost: the glued `a ? b :c` reads as a symbol). Instance
 * `@name`, class `@@name` and global `$name` variables ride "variable"
 * (php's class); a lone `@` or `$` and the `$1`-style numeric globals have
 * no identifier glued and ride default. Ruby has NO attributes: there is
 * no decorator arm, and this tokenizer never emits the "decorator" class.
 * "keyword" is CASE-SENSITIVE (like java, unlike php) with lowercase-only
 * `true`/`false` riding "boolean" and `nil` riding "null" (`TRUE`, `NULL`
 * are plain words, `False`/`Nil` take the Capitalized reading); `self`,
 * `super` and `yield` ride keyword. "type" is the name directly after
 * class/module plus the Capitalized heuristic (`Widget` reads as a class,
 * `MAX_SIZE` stays a plain word, and `ArgumentError` is mixed-case like
 * `IEnumerable` and rides default -- the c.ts ruling); member position
 * refuses it, so `Foo::BarError` tails wash. There are no primitive
 * keywords because the language has none. "fn" is the name after `def`
 * (php's prevFn shape) and any name directly before `(` (the call peek
 * survives the dot); ruby's optional call parens mean a bare `puts x` gets
 * no fn reading, honestly. Ruby identifiers may end in `?` or `!`
 * (`empty?`, `save!`): the identifier scan absorbs ONE glued trailing mark
 * so `empty?` is one word -- never after whitespace, and never `!=`, so
 * `foo!=bar` stays `foo` `!=` `bar`. "number" for decimal/hex/binary/
 * octal -- both the `0o` spelling and the LEGACY `0NNN` (real octal here,
 * unlike C#, so `0778` is invalid octal and distrusted as in php/java) --
 * with `_` separators, floats with exponent, and the `r` rational/`i`
 * imaginary suffixes glued to a decimal; there is NO leading-dot float
 * (ruby requires a digit before the dot on method-call grounds, so `1.2.3`
 * reads number, dot, number and no lookalike tracking exists), and shape
 * validation sends `0x`, `1_`, `0o8` back to default. The hash rocket `=>`
 * IS one "operator" run (unlike java/cs), as are `**`, `<=>`, `===`, `=~`,
 * `!~`, `==`, `!=`, `<=`, `>=`, `&&`, `||`, `..`, `...`, `&:` and `->`;
 * `::` and `.` set the dot flag, `->` is the stabby lambda and does NOT
 * (java's lambda ruling: `-> true` keeps its boolean), and the rest of the
 * punctuation is single-char "operator". Unclosed constructs run to end of
 * input; per-line statelessness is the house ceiling (the file view
 * tokenizes line by line for some sinks, so a multi-line literal only
 * carries its class whole when the document reaches the tokenizer, as with
 * php's heredoc). Nothing is ever dropped or reordered: concatenating
 * every run reproduces the input exactly, for any input. One run per
 * token; adjacent runs may share a type (sinks coalesce as they like).
 * This is display candy, not a ruby parser.
 */
export function tokenizeRuby(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let lineStart = true; // nothing significant pushed since the last newline (arms `=begin`)
  let dot = false; // the previous token was `.` or `::`
  let prevDecl = false; // the previous token was class/module
  let prevFn = false; // the previous token was the `def` keyword

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
      if (sawNewline) lineStart = true; // a newline arms the block-comment opener; spaces never spend it
      continue;
    }
    if (c === "=" && lineStart && text.startsWith("=begin", i) && !IDENT_RE.test(text[i + 6] ?? "")) {
      const end = endOfBlockComment(text, i);
      push("comment", text.slice(i, end));
      i = end;
      setPrev("comment");
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
    if (c === '"' || c === "'") {
      const end = endOfString(text, i);
      push("string", text.slice(i, end));
      i = end;
      setPrev("string");
      continue;
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
      // below eats it one char at a time.
    }
    if ((c === "@" || c === "$") && (IDENT_START_RE.test(text[i + 1] ?? "") || (c === "@" && text[i + 1] === "@" && IDENT_START_RE.test(text[i + 2] ?? "")))) {
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
    if (c === "?") {
      const end = endOfCharLiteral(text, i);
      if (end !== -1) {
        push("string", text.slice(i, end));
        i = end;
        setPrev("string");
        continue;
      }
      // not a char literal: the `?` rides the operator arm below (the
      // ternary mark, or a `?` glued to a word that the identifier scan
      // already spent)
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
      dot = two === "::"; // a constant/scope reference IS a member position; `->` (the stabby lambda) is not
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
    lineStart = false; // any significant token spends the block-comment arm
    if (type !== "operator") dot = false;
    prevDecl = word !== undefined && DECL_KW.has(word);
    prevFn = word !== undefined && word === "def";
  }

  /** Booleans/null (lowercase only, the language is case-sensitive) ->
   * keywords (case-sensitive) -> the name after class/module -> the name
   * after `def` -> fn (name before `(`, the peek surviving the dot) ->
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

/** `class`/`module` (exact case): the name right after one is a "type". */
const DECL_KW = new Set(["class", "module"]);

/** Strings: escapes honored, an unterminated literal stops before an
 * unescaped newline -- but a backslash before that newline splices the
 * line and the scan carries on to the closer or end of input (the c.ts/
 * js family). Interpolation (`#{expr}`) inside double quotes rides the
 * string run -- the rust format-string ruling. */
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
 * `<<-`/`<<~` tolerate indentation past it, the bare spelling demands
 * column 0 as the language does; the run ends right after the closer word
 * (no semicolon convention in ruby -- the line's tail rides the next
 * run). Returns the end index, or -1 when there is no glued label (the
 * caller lets the operator arm eat the `<`s); a never-closed opener runs
 * to end of input. */
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

/** `=begin` through the closer line: the first line whose first non-space
 * token is `=end` (word-boundary checked) ends the run right after the
 * word; no closer anywhere runs to the end of input. */
function endOfBlockComment(text: string, from: number): number {
  let line = from + 6; // spend the opener word; its line tail is comment too
  while (line < text.length) {
    const nl = text.indexOf("\n", line);
    const lineEnd = nl === -1 ? text.length : nl + 1;
    let k = line;
    while (k < lineEnd && (text[k] === " " || text[k] === "\t")) k++;
    if (text.startsWith("=end", k) && !IDENT_RE.test(text[k + 4] ?? "")) return k + 4;
    line = lineEnd;
  }
  return text.length;
}

/** Char literal `?x`: one character or one escape (the `\uXXXX` spelling
 * included) glued to the `?`, then the language's own boundary -- no
 * identifier char may follow. Returns the end index, or -1 when the shape
 * fails (a lone `?`, or a `?` glued to a longer word): the caller lets the
 * `?` ride the operator arm. */
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
  } else if (j < text.length) {
    j++;
  } else {
    return -1; // a trailing lone `?` is the ternary mark, not a literal
  }
  return IDENT_RE.test(text[j] ?? "") ? -1 : j;
}

/** The `?`/`!` method-name tail (`empty?`, `save!`): absorbed when glued
 * -- one mark only, and never `!=`, so `foo!=bar` stays `foo` `!=` `bar`. */
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

/** Three-char operators, checked before the two-char set. */
const THREE_CHAR_OPS = new Set(["<=>", "===", "..."]);

/** Two-char operators. `->` is the stabby lambda (NOT member access: it
 * does not set the dot, unlike php); `::` is scope resolution and does;
 * `..` (the range) is here while `...` is a three-char run; `?.` is not a
 * ruby operator (safe navigation is `&.`). */
const TWO_CHAR_OPS = new Set(["=>", "**", "::", "==", "!=", "=~", "!~", "<=", ">=", "&&", "||", "..", "&:", "->"]);

/** Capitalized name (`Widget`, `Thing2`), NOT an all-caps constant
 * (`MAX_SIZE`) and not a mixed-case name (`ArgumentError`, `GtkWidget`) --
 * the c.ts typedef heuristic. */
const CAPITALIZED_RE = /^[A-Z][a-z0-9_]*$/;

/** The numeric dialect: radix forms with `_` separators, the `0o` octal
 * spelling AND the legacy `0NNN` (real octal, like php/java -- `0778` is
 * invalid and distrusted), decimals and floats with exponent, and the `r`
 * rational/`i` imaginary suffixes (glued, decimals only -- the scanNumber
 * tail; `0xFFr` is the number `0xFF` plus the word `r`). There is NO
 * leading-dot float (`.5` is a dot operator plus a number). Validation
 * sends `0x`, `1_`, `0o8` back to default. */
const NUM_OK_RE =
  /^(?:0[xX][0-9a-fA-F](?:[0-9a-fA-F_]*[0-9a-fA-F])?|0[bB][01](?:[01_]*[01])?|0[oO][0-7](?:[0-7_]*[0-7])?|0[0-7](?:[0-7_]*[0-7])?|(?:0|[1-9](?:\d|_\d)*)(?:\.\d(?:[\d_]*\d)?)?(?:[eE][+-]?\d(?:[\d_]*\d)?)?)[ri]?$/;

const isNumberStart = (c: string): boolean => /[0-9]/.test(c);

const NUM_SUFFIX_RE = /^[ri](?![\w])/;

function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  if (text[i] === "0" && /[xXbBoO]/.test(text[i + 1] ?? "")) {
    i += 2;
    while (i < n && /[0-9a-fA-F_]/.test(text[i]!)) i++;
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
  const suffix = NUM_SUFFIX_RE.exec(text.slice(i));
  if (suffix) i += suffix[0].length;
  return i;
}

/** The reserved words (exact case -- ruby keywords are case-sensitive,
 * like java, unlike php), minus true/false/nil which ride boolean/null.
 * `self`, `super` and `yield` ride keyword (the ruling: they read with
 * the control words, not as plain defaults); the regex-boundary `defined?`
 * lands here via the identifier scan's trailing-mark absorption. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "__ENCODING__",
  "__LINE__",
  "BEGIN",
  "END",
  "alias",
  "and",
  "begin",
  "break",
  "case",
  "class",
  "def",
  "defined?",
  "do",
  "else",
  "elsif",
  "end",
  "ensure",
  "for",
  "if",
  "in",
  "module",
  "next",
  "not",
  "redo",
  "rescue",
  "retry",
  "return",
  "self",
  "super",
  "then",
  "undef",
  "unless",
  "until",
  "when",
  "while",
  "yield",
]);

/** The registry entry for this lang (assembly list: index.ts). No
 * aliases: the canonical name is the fence word. `Rakefile`, `Gemfile`
 * and friends are NOT claimed (the basename shape is a cheap-wins follow-
 * up; the house rule keeps the list minimal); `.erb` is not ruby either
 * (html-with-tags). */
export const RUBY_SYNTAX: SyntaxDef = {
  lang: "ruby",
  tokenize: tokenizeRuby,
  extensions: ["rb", "gemspec"],
};
