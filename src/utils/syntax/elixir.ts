import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Elixir tokenizer.
 *
 * One pass over code (the ruby.ts/kotlin.ts family -- do/end blocks and a
 * prevFn reading, with dart.ts as the clone exemplar): `#` opens a
 * "comment" to EOL anywhere, including the `#!/usr/bin/env elixir`
 * shebang (the same arm covers it); there are NO block comments, so the
 * C-shaped opener sequence degrades to the operator singles `/` and `*`
 * (pinned). "string" is the big class here. Double-quoted strings ride
 * the ordinary scan with escapes honored (unterminated stops at the
 * newline, a backslash before it splices the line, the c.ts endOfString)
 * and the `#{...}` interpolation hole stays INSIDE the run (the rust
 * ruling: holes are not parsed, so a quote inside a hole closes the
 * literal -- pinned). Single quotes open the ordinary string scan too:
 * `'abc'` is a charlist, a string-shaped value (dart's char-literal-less
 * doctrine; the cost is an apostrophe-in-text opening a string run that
 * ends at the next quote or the newline). Heredocs `"""`/`'''` scan to
 * the next same-triple SKIPPING backslash pairs (the swift endOfMultiline
 * template -- elixir heredocs do process escapes); the real closing rule
 * is indentation-aware, the simple scan is the pinned cost. Atoms are
 * string-like constants and ride "string": a `:` glued to a name scans
 * the atom charset (letters, digits, `_`, `@`, and the language's own
 * `!`/`?` ending -- one mark only, never `!=`), `:"quoted"` and
 * `:'quoted'` take the full string scan, and the operator atoms (`:<`)
 * and `:123` ride the degrade (colon plus tokens). The trailing-keyword
 * form `foo:` -- the colon moved to the end for keyword lists and atom
 * maps -- is Elixir's most distinctive display win and rides "key" (the
 * json/yaml precedent): a word glued to a colon whose next char is not
 * another colon, so `x :: y` typespecs stay two operator singles (pinned)
 * while `%{a | b: 1}`, `case ... y: ->`, and `do:`/`else:` wash as keys
 * (`do:` IS the atom :do; the keyword reading is the documented wash).
 * Sigils arm at `~` optionally followed by one lowercase letter or one or
 * more uppercase letters (the reference's own rule; the bare `~` is the
 * regex sigil) and then ONE of the seven delimiter pairs -- `( )`,
 * `{ }`, `[ ]`, `< >`, `" "`, `' '`, `/ /` (the reference lists exactly
 * these; the pipe pair the draft hoped for is NOT among them, so
 * `~w|a b|` degrades to `~` plus ordinary tokens); bracket pairs balance
 * (depth-counted, the language nests them), quotes and slashes close on
 * their next byte, a backslash skips two bytes in every form (the one
 * documented raw-sigil cost: `~S"\\"` closes where the bytes say), triple
 * quote spellings (`~s"""..."""`) take the triple closer, trailing
 * modifier letters and digits ride the run, and an unclosed sigil runs to
 * end of input (per-line calls degrade honestly, the php-heredoc story).
 * The slash form is safe BECAUSE it is tilde-led: a bare `/` is division
 * and never a regex (this is not the groovy slashy fight -- pinned).
 * `@` glued to a name is a module attribute and rides "decorator": the
 * name plus AT MOST ONE paren group but only when the paren is GLUED
 * (`@on_load(:init)` groups; `@spec` does NOT swallow the next line's
 * function head, the deliberate divergence from java/kotlin's
 * whitespace-tolerant arm -- `@spec foo(...) :: t` keeps `foo` reading as
 * fn); an `@` not glued to a name rides default. "keyword" for the
 * reserved words plus the def-family/control macros CASE-SENSITIVELY
 * (lowercase only): true/false ride "boolean" and `nil` rides "null" --
 * Elixir's spelling, pinned; `xor` is an ordinary Kernel FUNCTION and
 * rides plain (the draft listed it; the spec overrides), `raise` is a
 * function too. prevFn after def/defp/defmacro is MANDATORY, not
 * decorative: `def foo do` names the function with no paren anywhere,
 * so the call peek alone misses it (pinned). "type" is defmodule/
 * defprotocol's name plus the Capitalized heuristic -- modules are
 * Capitalized, so `Enum.map` reads Enum-as-type and module aliases ride
 * the kotlin precedent; there are NO primitive keywords (the typespec
 * words `integer`/`binary` are plain atoms and ride default).
 * IDENTIFIERS may end in `?` or `!` (`valid?`, `raise!`, the predicate/
 * bang convention -- `def foo! do` names a function): the identifier
 * scan absorbs ONE glued trailing mark, never after whitespace and never
 * `!=`, so `foo!=bar` stays `foo` `!=` `bar` and `x? :y` reads atom-then-
 * colon with the mark glued to the word; the mark is end-only (mid-word
 * `a?b` is the word `a?` plus `b`), and this changes every operator-
 * degrade fixture: `x!` is ONE word HERE, not operator-plus-word. The
 * `?c` code point literal (the deprecated-but-parsing `?a` -> 97) takes
 * the ruby char arm re-pointed at "number": one char or one escape glued
 * to the `?` with the language's own boundary after it; a spaced `?`
 * (there is no ternary in this language) rides default. "number" for
 * decimal/hex/octal/binary with `_` separators (the kotlin/groovy shape;
 * Elixir has NO octal `0NNN` legacy -- `0777` is a plain decimal), floats
 * with e-exponent, and NO suffix zoo; no leading-dot float (`1.2.3` reads
 * number, dot, number); shape validation sends `0x`, `0o8`, `1_` back to
 * default. Operators: the pipe `|>` IS a run and NOT a member (the
 * signature token), as are `**` (exponentiation), `=>` (the map arrow --
 * a real token, the draft's silence overridden by the reference), `==`
 * `!=` `===` `!==` `<=` `>=` `=~`, the comprehension `<-`, the function
 * head `->` (NOT member), the typespec `::`, the range `..` (so `..//2`
 * step ranges read `..` then `//` -- the step IS a token), `++` `--`
 * `<>` `//`, and `&&` `||`; the three-char set is `===` `!==` `<<<`
 * `>>>` `|||` `&&&` (Bitwise, real tokens), checked first as the dart
 * lesson demands. REJECTED and degrading to singles (the groovy
 * doctrine, extended to "Elixir parses but never uses" spellings):
 * `^^^`, `=~=` (do not exist), `~~~` (gone from the operator table),
 * `?.` and `??` (no safe navigation, no elvis), `<=>`, `->`-adjacent
 * `-->`, and the exotic parseables `+++` `---` `<~` `~>` `<~>` `<<~`
 * `~>>` `...`. `<<` and `>>` are NOT runs (the binary construct `<<...>>`
 * is structural, the cmake bracket ruling); the capture `&`, the cons
 * `|`, the pin `^`, the match `=`, and `+` `-` `*` `/` are plain singles
 * (a glued `!` was already eaten by the identifier arm; `&foo/1`
 * captures ride `&` plus a plain word plus the arity number); the
 * match-pin backslash rides an operator single. Nothing is ever dropped
 * or reordered: concatenating every run reproduces the input exactly,
 * for any input. One run per token; adjacent runs may share a type (sinks
 * coalesce as they like). This is display candy, not an Elixir parser.
 */
export function tokenizeElixir(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let dot = false; // the previous token was `.` (nothing else sets it HERE)
  let prevDecl = false; // the previous token was defmodule/defprotocol
  let prevFn = false; // the previous token was def/defp/defmacro

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
    if ((c === '"' || c === "'") && text[i + 1] === c && text[i + 2] === c) {
      const end = endOfHeredoc(text, i);
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
    if (c === "~") {
      const end = endOfSigil(text, i);
      if (end !== -1) {
        push("string", text.slice(i, end));
        i = end;
        setPrev("string");
        continue;
      }
      // not a sigil (a bare `~`, `~~~`, `~` glued to a word...): the
      // operator arm below eats one byte
    }
    if (c === "@" && IDENT_START_RE.test(text[i + 1] ?? "")) {
      const end = endOfAnnotation(text, i);
      push("decorator", text.slice(i, end));
      i = end;
      setPrev("decorator");
      continue;
    }
    if (c === ":" && (IDENT_START_RE.test(text[i + 1] ?? "") || text[i + 1] === '"' || text[i + 1] === "'")) {
      // Atom (the string-like constant): `:foo`, `:Foo`, `:"quoted"`,
      // with the language's `@` mid-atom and `!`/`?` tail.
      let j: number;
      if (text[i + 1] === '"' || text[i + 1] === "'") {
        j = endOfString(text, i + 1);
      } else {
        j = i + 1;
        while (j < n && (IDENT_RE.test(text[j]!) || text[j] === "@")) j++;
        j = absorbTrailingMark(text, j);
      }
      push("string", text.slice(i, j));
      i = j;
      setPrev("string");
      continue;
    }
    if (c === "?") {
      const end = endOfCodepoint(text, i);
      if (end !== -1) {
        push("number", text.slice(i, end)); // `?a` is 97: a number, unlike ruby's string
        i = end;
        setPrev("number");
        continue;
      }
      // a lone `?` is no operator HERE (there is no ternary): default byte
      push("default", c);
      i++;
      setPrev("default");
      continue;
    }
    if (IDENT_START_RE.test(c)) {
      const j = absorbTrailingMark(text, scanIdent(text, i));
      // Keyword key (`foo:` with a non-`::` follow): the atom colon
      // moved to the end. Checked before the word classification so
      // `do:`/`if:` wash as keys (they ARE atoms).
      if (text[j] === ":" && text[j + 1] !== ":") {
        push("key", text.slice(i, j + 1));
        i = j + 1;
        setPrev("key");
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
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push("operator", two);
      i += 2;
      setPrev("operator");
      continue; // nothing two-char is a member gesture HERE (only `.` is)
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
   * keywords (case-sensitive) -> the name after defmodule/defprotocol ->
   * the name after def/defp/defmacro (MANDATORY: `def foo do` has no
   * paren) -> fn (name before `(`, the peek surviving the dot) ->
   * Capitalized module. After a dot, every reading but the call peek is
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

/** `defmodule`/`defprotocol` (exact case): the name right after one is a
 * "type" (protocols and modules are modules). */
const DECL_KW = new Set(["defmodule", "defprotocol"]);

/** def/defp/defmacro (the plan's trio): the next word is the function
 * NAME, paren or not (`def foo do` is the pinned case). */
const PREV_FN = new Set(["def", "defp", "defmacro"]);

/** Interpreted strings (both quote forms -- charlists ride the same scan,
 * dart doctrine): escapes honored, an unterminated literal stops before
 * an unescaped newline -- but a backslash before that newline splices the
 * line and the scan carries on to the closer or end of input (the c.ts/
 * js family). The `#{...}` hole rides the run (the rust ruling: a quote
 * inside a hole closes the literal). */
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

/** Heredoc from the triple quote (`"""` or `'''`): the closer scan SKIPS
 * backslash pairs (the swift endOfMultiline template -- heredocs process
 * escapes, so an escaped triple does not close); runs to the first
 * following same-triple or end of input. The real closing rule is
 * indentation-aware; the simple scan is the documented cost. */
function endOfHeredoc(text: string, from: number): number {
  const triple = text.slice(from, from + 3);
  let j = from + 3;
  while (j < text.length) {
    const d = text[j]!;
    if (d === "\\") {
      j += 2;
      continue;
    }
    if (d === triple[0] && text[j + 1] === triple[0] && text[j + 2] === triple[0]) return j + 3;
    j++;
  }
  return text.length;
}

/** Sigil from the `~`: optional sigil letters (one lowercase or one or
 * more uppercase, the reference's rule; the bare `~` is the regex
 * sigil), then one of the seven delimiter pairs -- brackets balance
 * (depth counted), quotes/slashes close on the next matching byte, and
 * the triple quote spellings take the triple closer. A backslash skips
 * two bytes in every form. Trailing modifier letters/digits ride the
 * run; an unclosed sigil runs to end of input. Returns the end index, or
 * -1 when the shape fails (no delimiter, illegal letter spelling) and
 * the caller lets `~` ride the operator arm. */
function endOfSigil(text: string, from: number): number {
  const n = text.length;
  let k = from + 1;
  const head = k;
  while (k < n && /[A-Za-z]/.test(text[k]!)) k++;
  const letters = text.slice(head, k);
  if (letters !== "" && !/^[a-z]$|^[A-Z]+$/.test(letters)) return -1;
  const open = text[k];
  if (open === undefined) return -1;
  const close = PAIRS[open];
  if (close === undefined) return -1;
  const triple = (open === '"' || open === "'") && text[k + 1] === open && text[k + 2] === open;
  let j = k + 1 + (triple ? 2 : 0);
  if (open === close) {
    while (j < n) {
      const d = text[j]!;
      if (d === "\\") {
        j += 2;
        continue;
      }
      if (triple) {
        if (d === open && text[j + 1] === open && text[j + 2] === open) {
          j += 3;
          break;
        }
      } else if (d === open) {
        j++;
        break;
      }
      j++;
    }
  } else {
    let depth = 1;
    while (j < n) {
      const d = text[j]!;
      if (d === "\\") {
        j += 2;
        continue;
      }
      if (d === open) depth++;
      else if (d === close) {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      j++;
    }
  }
  while (j < n && /[0-9A-Za-z]/.test(text[j]!)) j++; // modifiers ride the run
  return j;
}

const PAIRS: Record<string, string> = { "(": ")", "{": "}", "[": "]", "<": ">", '"': '"', "'": "'", "/": "/" };

/** `@Name` plus AT MOST ONE paren group, GLUED only (the deliberate
 * divergence from java/kotlin's whitespace-tolerant arm: `@spec` must not
 * swallow the next line's function head): strings (both quote forms,
 * heredocs included) and comments inside the group are skipped so their
 * brackets cannot cut the run short; no closer anywhere runs to the end
 * of input. */
function endOfAnnotation(text: string, from: number): number {
  let j = from + 1; // spend the `@`
  while (j < text.length && IDENT_RE.test(text[j]!)) j++;
  if (text[j] !== "(") return j;
  let depth = 0;
  while (j < text.length) {
    const d = text[j]!;
    if (d === "(") {
      depth++;
      j++;
    } else if (d === ")") {
      depth--;
      j++;
      if (depth === 0) return j;
    } else if (d === '"' || d === "'") {
      j =
        text[j + 1] === d && text[j + 2] === d ? endOfHeredoc(text, j) : endOfString(text, j);
    } else if (d === "#") {
      while (j < text.length && text[j] !== "\n" && text[j] !== "\r") j++;
    } else j++;
  }
  return text.length;
}

/** Code point literal `?x` (the deprecated `?a` -> 97): one character or
 * one escape (the `\uXXXX` spelling included) glued to the `?`, then the
 * language's own boundary -- no identifier char may follow. Returns the
 * end index, or -1 (a lone `?` or one glued to a longer word): the caller
 * lets the `?` ride a default byte (there is no ternary to keep fed). */
function endOfCodepoint(text: string, from: number): number {
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
    return -1;
  }
  return IDENT_RE.test(text[j] ?? "") ? -1 : j;
}

/** The `?`/`!` method-name tail (`valid?`, `raise!`): absorbed when glued
 * -- one mark only, and never `!=`, so `foo!=bar` stays `foo` `!=` `bar`
 * (the ruby arm; the mark is END-only, mid-word marks just end the word). */
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

/** No `?` in here: Elixir has no ternary and the `?` byte is identifier
 * tail, code-point lead, or nothing. The match-pin backslash rides a
 * plain single. */
const OPERATOR_RE = /[{}()[\];,.:+\-*/%&|^!~=<>\\]/;

/** Three-char operators, checked before the two-char set (the dart
 * lesson): the strict-equality pair and the Bitwise spellings (`&&&` and
 * `|||` are real tokens -- band/bor -- when Bitwise is imported; `<<<`
 * and `>>>` are the guard-safe shifts). `^^^`, `=~=` and `~~~` are NOT
 * Elixir tokens and degrade (the groovy doctrine). */
const THREE_CHAR_OPS = new Set(["===", "!==", "<<<", ">>>", "|||", "&&&"]);

/** Two-char operators: the pipe `|>` (the signature token, NOT a member
 * gesture), the exponentiation `**`, the map arrow `=>`, the comparison
 * pair-ups, the text match `=~`, the comprehension generator `<-`, the
 * function/case head `->` (NOT member), the typespec `::`, the range
 * `..` (step ranges read `..` then `//`), `//` itself, the list `++`/`--`
 * and binary `<>` concatenations, and `&&`/`||`. `?.`/`??` (no safe
 * navigation, no elvis), `<=>`, `<<`/`>>` (the binary construct is
 * structural, the cmake bracket ruling), and the exotic parseables
 * (`+++`, `---`, `-->`, `...`) are DELIBERATELY absent and scan as
 * single-char operators. */
const TWO_CHAR_OPS = new Set([
  "|>",
  "**",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "=~",
  "<-",
  "->",
  "::",
  "..",
  "//",
  "++",
  "--",
  "<>",
  "&&",
  "||",
]);

/** Capitalized name (`Widget`, `Thing2`), NOT an all-caps constant
 * (`MAX_SIZE`) and not a mixed-case name (`GtkWidget`) -- the c.ts
 * typedef heuristic. Elixir's modules are Capitalized, so this is also
 * the module alias reading (kotlin's precedent); `Enum.map` reads Enum
 * as a type, honestly and usefully. */
const CAPITALIZED_RE = /^[A-Z][a-z0-9_]*$/;

/** The numeric dialect: hex/octal/binary with `_` separators (NO legacy
 * `0NNN` octal -- `0777` is a plain decimal), decimals and floats with
 * e-exponent (an integer `1e10` is a float in this language, and rides
 * number), NO suffixes, no leading-dot float. Validation sends `0x`,
 * `1_`, `0b2`, `0o8` back to default (the radix scan eats the bad tail,
 * kotlin's whole-word shape -- there is no digit-restricted split). */
const NUM_OK_RE =
  /^(?:0[xX][0-9a-fA-F](?:[0-9a-fA-F_]*[0-9a-fA-F])?|0[oO][0-7](?:[0-7_]*[0-7])?|0[bB][01](?:[01_]*[01])?|\d(?:[\d_]*\d)?(?:\.\d(?:[\d_]*\d)?)?(?:[eE][+-]?\d(?:[\d_]*\d)?)?)$/;

const isNumberStart = (c: string): boolean => /[0-9]/.test(c);

function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  if (text[i] === "0" && /[xXoObB]/.test(text[i + 1] ?? "")) {
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
  return i;
}

/** The keywords (exact case): the reference's reserved words minus
 * true/false/nil (boolean/null), plus the def-family and control macros
 * the display wants colored with them (ruby treats `def` as a keyword
 * too -- the family precedent). `xor` rides plain (a Kernel function, the
 * spec overriding the draft list), `raise` is a function, and `before`
 * (the draft's stray) is not an Elixir word at all. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "after",
  "alias",
  "and",
  "case",
  "catch",
  "cond",
  "def",
  "defguard",
  "defguardp",
  "defimpl",
  "defmacro",
  "defmacrop",
  "defmodule",
  "defprotocol",
  "defp",
  "defstruct",
  "do",
  "else",
  "end",
  "for",
  "fn",
  "if",
  "import",
  "in",
  "not",
  "or",
  "quote",
  "receive",
  "require",
  "rescue",
  "try",
  "unless",
  "unquote",
  "unquote_splicing",
  "use",
  "when",
  "with",
]);

/** The registry entry for this lang (assembly list: index.ts). No
 * aliases: the canonical name is the fence word. `.ex` and `.exs` are the
 * claims; `.heex` is NOT claimed (it is HTML-in-a-sigil, an honest
 * non-fit for this scanner and for html.ts alike -- documented). */
export const ELIXIR_SYNTAX: SyntaxDef = {
  lang: "elixir",
  tokenize: tokenizeElixir,
  extensions: ["ex", "exs"],
};
