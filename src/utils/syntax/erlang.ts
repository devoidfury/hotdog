import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Erlang tokenizer.
 *
 * The elixir sibling with the headline INVERSION: a Capitalized word is a
 * VARIABLE, not a type (the zig lowercase-reversal lesson, mirrored). The
 * word scan is the only class a Capitalized word can get -- in either
 * position, so the tuple pattern `Mod:Var = ...` keeps its variable -- and
 * the Capitalized type heuristic is absent by design; there is no type
 * reading at all except the `-spec`/`-type` attribute, where the preproc
 * arm claims the attribute NAME only and the type words ride default (the
 * honest shape, documented). Comments: `%` to EOL anywhere (the `%%`/`%%%`
 * doc style rides the same arm); there are NO block comments (pin the C
 * opener sequence as operator singles). "string" is double-quoted (the
 * charlist, c.ts endOfString: escapes honored, unterminated stops at the
 * newline, a backslash before it splices) and single-quoted atoms --
 * `'foo'`, `'Foo'`, `'with spaces'` -- take the ordinary string scan, so
 * the invisible char/atom distinction (an unquoted `'a'` is BOTH a 97-char
 * and an atom) never reaches display; java's endOfCharLiteral is NOT used
 * here, the pinned contrast with crystal/swift. The code point `$a` takes
 * the elixir `?a` arm re-pointed at `$`, class "number": one character or
 * one escape (the named `\n`-family, the 1-3 digit octal `\377`, `\x41`
 * and `\x{1F600}`, the control `\^A` spellings) glued to the `$`; a lone
 * `$` or one glued to a newline rides a default byte. Format strings have
 * no holes in THIS language: `io/format` `~p~n` bytes are string bytes,
 * pinned (OTP 28's `~s` sigil strings are a separate feature with no arm
 * here; a `~` outside them is one plain token). THE OPERATOR SET IS THE
 * LEXER'S (erl_scan): the three-char runs `...`, `<:-`, `<:=`, `=:=`,
 * `=/=` are checked FIRST (the dart lesson -- `=:=` before the `=<`
 * two-char), then the two-char `->` (clause arrow), `=>` (map assoc),
 * `:=` (map update), `::` (typespec), `==`, `/=`, `=<`, `>=`, `++`, `--`,
 * `||`, `&&`, `..`, `?=` (maybe-match), `<-` (comprehension generator)
 * and the bitstring pair `<<`/`>>` -- real single tokens in the lexer, so
 * they run (a spec-over-plan reversal of the cmake bracket lean, flagged);
 * everything else is a single-char operator (the lexer tokenizes bare
 * `?`, `~`, `@`, `!`... as symbols too -- so `?` is NOT a plan-style
 * "not-an-operator", it is a single the macro arm beats). `#` is one
 * operator single: `#rec{` and `#{` read as byte plus brackets, and the
 * OTP 27 `#_` two-char token is deliberately NOT armed so `#_foo` keeps
 * its atom whole (documented). The macro `?NAME` (glued, upper- as the
 * language demands) is ONE "variable" run -- macro usage washes with
 * variable, the documented reading -- while a `?` that arms nothing is
 * the symbol single. `!` stays the bind OPERATOR single in every
 * position: `Pid ! msg` dominates and the guard `!X` reads
 * operator+variable, the pinned cost. Attributes: a line-leading `-`
 * (past any indentation, c.ts's lineStart arm) GLUED to a name is a
 * "preproc" run for the attribute name ONLY (`-module`, `-export`,
 * `-spec`...) -- unlike c.ts's whole-line, because export lists contain
 * candy (fn names, strings, numbers); the rest of the line tokenizes
 * normally, and a bare `-`/`--`/negative number cannot arm. `foo(...) ->`
 * clause heads get their name from the call peek (the only fn reading:
 * there is NO def keyword, so no prevFn arm exists, pinned); the peek
 * survives the module dot, `lists:map` reads `map`-as-fn, and after `.`
 * or `:` every reading but the call peek is refused (the house rule).
 * Keywords are the reference's reserved words verbatim, CASE-SENSITIVE:
 * after/and/andalso/band/begin/bnot/bor/bsl/bsr/bxor/case/catch/cond/
 * div/else/end/fun/if/let/maybe/not/of/or/orelse/receive/rem/try/when/
 * xor (`catch`, `else` and the OTP 27 `maybe` join the plan's draft list
 * from the spec). There are NO booleans and no null in this language:
 * the atoms `true`/`false`/`ok`/`error`/`undefined` are lowercase words
 * riding "default" the honest way, pinned -- the tokenizer emits no
 * boolean/null class AT ALL. Numbers: decimals with single-`_`
 * separators (OTP 24+; the lexer is the trust boundary: `1__0`
 * degrades), floats that must contain a dot (`1e6` is NOT a float --
 * number plus word; `.01` is dot plus number, neither is legal here
 * either), and the radix form `Base#digits` (`16#ff`, `2#1010`,
 * `36#helloworld`, with the float spellings `16#ff.fe` and
 * `16#ff.fe#e+6`) as ONE number run when the shape validates (base in
 * 2..36); `#` is consumed into the number attempt only after digits,
 * so records and macros cannot collide, and the half form `16#` rides
 * default. There is NO `0x` (the spec denies it: `0x1f` is the number
 * `0` plus the word `x1f`, pinned). Nothing is ever dropped or
 * reordered: concatenating every run reproduces the input exactly, for
 * any input. One run per token; adjacent runs may share a type (sinks
 * coalesce as they like). This is display candy, not an Erlang parser.
 */
export function tokenizeErlang(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let lineStart = true; // nothing significant pushed since the last newline (arms attributes)
  let dot = false; // the previous token was `.` or `:` (module/member position)

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
      if (sawNewline) lineStart = true; // a newline arms the next attribute; spaces never spend it
      continue;
    }
    if (c === "%") {
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      push("comment", text.slice(i, j));
      i = j;
      setPrev("comment");
      continue;
    }
    if (c === "-" && lineStart && /[A-Za-z_]/.test(text[i + 1] ?? "")) {
      let j = i + 1;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      push("preproc", text.slice(i, j)); // the attribute NAME only; the line continues tokenizing
      i = j;
      setPrev("preproc");
      continue;
    }
    if (c === '"' || c === "'") {
      // Double-quoted strings and single-quoted atoms share the ordinary
      // scan: content is bytes to display, the char/atom split is not.
      const end = endOfString(text, i);
      push("string", text.slice(i, end));
      i = end;
      setPrev("string");
      continue;
    }
    if (c === "?" && /[A-Z]/.test(text[i + 1] ?? "")) {
      let j = i + 1;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      push("variable", text.slice(i, j)); // `?MODULE`: macro use washes with variable
      i = j;
      setPrev("variable");
      continue;
    }
    if (c === "$") {
      const end = endOfCodepoint(text, i);
      if (end !== -1) {
        push("number", text.slice(i, end)); // `$A` is 65: the elixir `?a` arm re-pointed
        i = end;
        setPrev("number");
        continue;
      }
      push("default", c); // a `$` that arms nothing is a plain byte (no operator role)
      i++;
      setPrev("default");
      continue;
    }
    if (IDENT_START_RE.test(c)) {
      let j = i;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      const word = text.slice(i, j);
      const type = classifyIdent(word, j);
      push(type, word);
      i = j;
      setPrev(type);
      continue;
    }
    if (isNumberStart(c)) {
      const end = scanNumber(text, i);
      push(numOk(text.slice(i, end)) ? "number" : "default", text.slice(i, end));
      i = end;
      setPrev("number");
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
      continue; // nothing two-char is a member gesture HERE
    }
    if (OPERATOR_RE.test(c)) {
      push("operator", c);
      i++;
      setPrev("operator");
      dot = c === "." || c === ":"; // the module/member separators (`lists:map`, `Rec#rec.field`)
      continue;
    }
    push("default", c);
    i++;
    setPrev("default");
  }
  return runs;

  function setPrev(type: string): void {
    lineStart = false; // any significant token spends the attribute arm
    if (type !== "operator") dot = false;
  }

  /** The inversion: UPPER starts a VARIABLE, in any position (the tuple
   * pattern `Mod:Var = ...` keeps it). Then keywords (case-sensitive, but
   * refused after a dot) -> fn (name before `(`, the peek surviving the
   * dot) -> default. There are no booleans, no null, no types. */
  function classifyIdent(word: string, after: number): string {
    if (UPPER_START_RE.test(word)) return "variable";
    if (!dot && KEYWORDS.has(word)) return "keyword";
    if (text[skipWs(text, after)] === "(") return "fn";
    return "default";
  }
}

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

const skipWs = (text: string, from: number): number => {
  let j = from;
  while (j < text.length && isWs(text[j])) j++;
  return j;
};

/** Strings and quoted atoms (one scan, one class): escapes honored, an
 * unterminated literal stops before an unescaped newline -- but a backslash
 * before that newline splices the line and the scan carries on to the
 * closer or end of input (the c.ts family). No interpolation exists in
 * this language's plain strings (OTP 28's `~s` sigils are another feature,
 * unarmed), so `~p~n` and `#{` inside a string are bytes, pinned. */
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

/** Code point literal `$x`: one character or one escape glued to the `$`
 * -- the named `\n`/`\t`/`\e`/`\d`/`\s`... family, the 1-3 digit octal
 * `\377`, the hex `\x41` and brace `\x{1F600}` forms, the control `\^A`.
 * Returns the end index, or -1 (a lone `$`, or one facing a newline): the
 * caller lets the `$` ride a default byte -- it has no operator role in
 * this language. No boundary check follows: `$ab` reads as the code point
 * `$a` plus the word `b`, which is exactly what the compiler's lexer
 * sees before it errors. */
function endOfCodepoint(text: string, from: number): number {
  const n = text.length;
  let j = from + 1;
  if (j >= n) return -1;
  if (text[j] === "\\") {
    const e = text[j + 1];
    if (e === undefined || e === "\n" || e === "\r") return -1;
    j += 2; // spend the backslash and its first follower
    if (text[j - 1] === "x") {
      if (text[j] === "{") {
        j++; // spend the brace
        while (j < n && /[0-9a-fA-F]/.test(text[j]!)) j++;
        if (text[j] !== "}") return -1;
        j++;
      } else {
        while (j < n && j < from + 5 && /[0-9a-fA-F]/.test(text[j]!)) j++; // \xHH
      }
    } else if (text[j - 1] === "^") {
      j++; // the control letter rides `\^A`
    } else if (/[0-7]/.test(text[j - 1]!)) {
      while (j < n && j < from + 5 && /[0-7]/.test(text[j]!)) j++; // up to three octal digits
    }
  } else if (text[j] === "\n" || text[j] === "\r") {
    return -1;
  } else {
    j++;
  }
  return Math.min(j, n);
}

const IDENT_START_RE = /[A-Za-z_\u00a0-\uffff]/;
const IDENT_RE = /[\w\u00a0-\uffff]/;
const UPPER_START_RE = /^[A-Z]/;

/** The lexer's single-char symbol tokens (`%`, `'`, `"`, `$` are handled
 * by their own arms above and never ride here). The backtick and tilde are
 * lexer symbols; the sigil feature gets no arm (documented). */
const OPERATOR_RE = /[{}()[\];,.:?+\-*/&|^!~=<>@\\`#]/;

/** Three-char tokens, checked before the two-char set (the dart lesson:
 * `=:=` must not lose its first char to `=<`... the `=<` shape starts with
 * `=` the other way, and `=:=`/`=/=` are whole lexer tokens). */
const THREE_CHAR_OPS = new Set(["...", "<:-", "<:=", "=:=", "=/="]);

/** Two-char tokens, the erl_scan set: the clause arrow `->`, map assoc
 * `=>`, map update `:=`, typespec `::`, the comparisons `==`, `/=`, `=<`,
 * `>=`, the list `++`/`--`, the guards `||`/`&&`, the new dots `..`, the
 * maybe-match `?=`, the generator `<-`, and the bitstring pair `<<`/`>>`
 * (the lexer lexes them as single tokens, so they run; the draft's cmake
 * bracket lean is overridden by the spec). The OTP 27 `#_` token is
 * deliberately absent so `#_foo` keeps its atom name whole. */
const TWO_CHAR_OPS = new Set([
  "->",
  "=>",
  ":=",
  "::",
  "==",
  "/=",
  "=<",
  ">=",
  "++",
  "--",
  "||",
  "&&",
  "..",
  "?=",
  "<-",
  "<<",
  ">>",
]);

/** The reserved words (exact case -- the reference's list, OTP 29):
 * `catch`, `else` and `maybe` (reserved with `maybe_expr` on by default
 * since OTP 27) join the classic set. `true`/`false` are NOT here: they
 * are plain atoms riding default, the pinned inversion's sibling fact. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "after",
  "and",
  "andalso",
  "band",
  "begin",
  "bnot",
  "bor",
  "bsl",
  "bsr",
  "bxor",
  "case",
  "catch",
  "cond",
  "div",
  "else",
  "end",
  "fun",
  "if",
  "let",
  "maybe",
  "not",
  "of",
  "or",
  "orelse",
  "receive",
  "rem",
  "try",
  "when",
  "xor",
]);

/** The numeric dialect (the reference's): decimals and floats with
 * single-`_` separators (OTP 24+; doubles and trailing underscores fail
 * validation), floats that must contain the dot (`1e6` is not a float
 * here -- the spec denies it), and the radix form `Base#digits` with the
 * float spellings `Base#digits.digits` and `Base#digits.digits#e exponent`
 * (the exponent is always decimal). NO `0x`/`077` prefixes (the spec
 * denies them; `0x1f` is `0` plus the word `x1f`). Validation checks the
 * base range 2..36; digit values per base are not checked (a lenient
 * display rule). The half form `16#` fails validation and rides default. */
const NUM_OK_RE =
  /^(?:[0-9](?:_?[0-9])*)(?:(?:#[0-9A-Za-z](?:[0-9A-Za-z_]*)?(?:\.[0-9A-Za-z](?:[0-9A-Za-z_]*)?)?(?:#[eE][+-]?[0-9](?:_?[0-9])*)?)|(?:\.[0-9](?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?))?$/;

/** Shape validation plus the radix base range (2..36, the spec's): the
 * half form `16#` fails the regex, `1#0` fails the range. */
function numOk(word: string): boolean {
  if (!NUM_OK_RE.test(word)) return false;
  const hash = word.indexOf("#");
  if (hash !== -1) {
    const base = Number(word.slice(0, hash).replace(/_/g, ""));
    if (!(base >= 2 && base <= 36)) return false;
  }
  return true;
}

const isNumberStart = (c: string): boolean => /[0-9]/.test(c);

function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  while (i < n && /[0-9_]/.test(text[i]!)) i++;
  if (text[i] === "#") {
    i++; // the `#` is consumed into the attempt only after digits: records and macros cannot collide
    while (i < n && /[0-9A-Za-z_]/.test(text[i]!)) i++;
    if (text[i] === "." && /[0-9A-Za-z]/.test(text[i + 1] ?? "")) {
      i++;
      while (i < n && /[0-9A-Za-z_]/.test(text[i]!)) i++;
    }
    if (text[i] === "#" && (text[i + 1] === "e" || text[i + 1] === "E")) {
      i += 2;
      if (text[i] === "+" || text[i] === "-") i++;
      while (i < n && /[0-9_]/.test(text[i]!)) i++;
    }
    return i;
  }
  if (text[i] === "." && /[0-9]/.test(text[i + 1] ?? "")) {
    i++;
    while (i < n && /[0-9_]/.test(text[i]!)) i++;
    if (text[i] === "e" || text[i] === "E") {
      let j = i + 1;
      if (text[j] === "+" || text[j] === "-") j++;
      if (/[0-9]/.test(text[j] ?? "")) {
        i = j;
        while (i < n && /[0-9_]/.test(text[i]!)) i++;
      }
    }
  }
  return i;
}

/** The registry entry for this lang (assembly list: index.ts). No
 * aliases: the canonical name is the fence word. `.escript` is NOT
 * claimed (a script dialect with its own shebang shape); `.hrl` is the
 * include header, same syntax. */
export const ERLANG_SYNTAX: SyntaxDef = {
  lang: "erlang",
  tokenize: tokenizeErlang,
  extensions: ["erl", "hrl"],
};
