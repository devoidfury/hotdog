import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * HCL tokenizer (native syntax: Terraform's `.tf`/`.tfvars` and the
 * standalone `.hcl`).
 *
 * THE HEADLINE: there are NO reserved words in this language (the spec
 * says so outright -- `for`, `in`, `if` are ordinary identifiers that
 * merely RIDE contextual keyword positions), so there is NO keyword class
 * at all and none is invented: the honest NO-keyword decision, the cmake
 * STREQUAL-rejection doctrine taken to the whole vocabulary. Block headers
 * (`resource "aws_s3_bucket" "web" {`) get no special arm either: the
 * block type is a plain word and the labels are just strings/words -- a
 * terraform vocabulary list (resource/data/provider/output/locals...) was
 * considered and rejected exactly like cmake's if-operator zoo, and it
 * would misread the equally legal `{for = 1}` shenanigans. `true`/`false`
 * ride "boolean" and `null` rides "null" (lowercase exactly; `True` is a
 * variable here). "key" is the attribute definition's shape, per the
 * json.ts precedent narrowed to the same line: an identifier followed (past
 * spaces and tabs, NEVER past a newline) by `=` is one "key" run -- and
 * the `=` must not be the head of `==` or `=>` (the object-for arrow), so
 * `v => i` keeps `v` a plain word. THE DECISION on `:`: it does NOT glue
 * keys, even though object elements legally spell `{foo = 1}` OR
 * `{foo: 1}` -- because `:` is also the for-expression colon
 * (`[for t in var.tags : upper(t)]`) and the ternary mark
 * (`var.x ? 2 : 0`), where an identifier glued before it is NOT a key, and
 * those shapes are far more common in real files than the JSON-flavored
 * object spelling; the cost is that `{foo: 1}` keeps `foo` a plain word,
 * pinned. THE IDENTIFIER IS THE BATCH'S SIGNATURE RULE (UAX #31 plus the
 * dash the spec adds by fiat): ID_Start then any run of ID_Continue or `-`
 * -- so `my-var` is ONE word (and a `my-var = 1` key), `a - 1` with air is
 * arithmetic (the whitespace separates), and the spec's own trap is pinned
 * whole: `x-1` is one identifier, not subtraction. Hyphens are swallowed
 * greedily as the grammar states, so `a- 1` eats the dash into the word.
 * There is NO type reading (the cmake doctrine; Terraform conventions put
 * every casing at every role) and NO variable class: a bare identifier is
 * default, and only two readings lift a word: the key glue above, and the
 * call peek (a word before `(` is "fn", whitespace-tolerant, surviving the
 * dot -- `aws_api.thing(` names `thing` while `data.aws_ami.x` keeps its
 * words plain; there is no def keyword, so no prevFn arm exists, pinned).
 * The peek is the ONLY fn reading; `[` indexing never lifts a word.
 * Comments: `#` AND `//` open line comments to EOL (two spellings, both
 * first-class, unlike every other house lang), and `/*` opens a block
 * comment that NEVER nests (c.ts's indexOf shape: the first closer ends it
 * and the tail re-reads; no closer anywhere runs to end of input). "string"
 * is the quoted template: escapes honored (`\n`, `\uNNNN`, `\UNNNNNNNN`
 * ride the generic backslash skip), an unterminated literal stops at the
 * newline (raw newlines are illegal inside quoted templates, the c.ts
 * shape) with a backslash before it splicing; `${...}` interpolations AND
 * `%{...}` directives RIDE INSIDE the run (the rust ruling -- holes are
 * not parsed), which carries the documented cost that a quote inside a
 * hole closes the literal: `"${join(", ", x)}"` is a string, a comma, and
 * another string. THE HOLES ARE STRING-ONLY: at top level `$` rides a
 * default byte (it arms nothing -- the pin) and `%{` is the modulo
 * operator plus a brace. Heredocs `<<EOT` and `<<-EOT` take the label
 * glued (air makes it not a heredoc) and run to the closer: the same label
 * at the start of a line (the bare spelling demands column 0; `<<-`
 * tolerates indentation), the closer line's tail riding the next run; the
 * label follows the identifier rule (dashes included), interpolation rides
 * the run, an unclosed opener runs to end of input, and quoted labels DO
 * NOT EXIST here -- ruby's endOfHeredoc adjusted: no quote forms, no `~`
 * marker (`<<~` degrades to two `<` singles plus a tilde; the marker is
 * not in this language). "number" is decimal-only: digits, optional
 * `.digits`, optional exponent `e[+-]?digits` (`1e10` needs no dot) -- NO
 * hex/octal/binary, NO underscore separators (the pinned degradations:
 * `0x1f` is number `0` plus the word `x1f`; `1_0` is number `1` plus the
 * word `_0`; `1e` is number `1` plus the word `e`; `.5` has no leading-dot
 * float and reads operator plus number). The scanner's number shape is
 * closed, so no validation arm is needed. Operators: the two-char runs
 * `==` `!=` `<=` `>=` `&&` `||` `=>` with the three-char `...` (spread)
 * checked FIRST (the dart lesson); `?` and `:` are separate singles (the
 * ternary is not a run, pinned); `!` single; `%` single; `=` single exists
 * for the parenthesized-key shape `{(foo) = 1}`; there is NO shift, so a
 * stray `<<` (past the heredoc arm) is two `<` singles; leftover `&`/`|`
 * ride singles too, and backslash, `@`, `;`, backtick and tilde are plain
 * bytes. Nothing is ever dropped or reordered: concatenating every run
 * reproduces the input exactly, for any input. One run per token; adjacent
 * runs may share a type (sinks coalesce as they like). This is display
 * candy, not an HCL parser.
 */
export function tokenizeHcl(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;

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
      const end = text.indexOf(CLOSER, i + 2); // NEVER nested: the first closer ends it
      const j = end === -1 ? n : end + 2;
      push("comment", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"') {
      const end = endOfString(text, i);
      push("string", text.slice(i, end));
      i = end;
      continue;
    }
    if (c === "<" && text[i + 1] === "<") {
      const end = endOfHeredoc(text, i);
      if (end !== -1) {
        push("string", text.slice(i, end));
        i = end;
        continue;
      }
      // No glued label (air, a digit, the `~` marker): NOT a heredoc, and
      // there is no shift operator here, so the `<`s ride singles below.
    }
    if (IDENT_START_RE.test(c)) {
      const j = scanIdent(text, i);
      const word = text.slice(i, j);
      push(classify(word, j), word);
      i = j;
      continue;
    }
    if (isNumberStart(c)) {
      const end = scanNumber(text, i);
      push("number", text.slice(i, end)); // the scan's shape is closed (decimal-only): always valid
      i = end;
      continue;
    }
    const three = text.slice(i, i + 3);
    if (three === "...") {
      push("operator", three); // spread, checked before any two-char (the dart lesson)
      i += 3;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push("operator", two);
      i += 2;
      continue;
    }
    if (OPERATOR_RE.test(c)) {
      push("operator", c);
      i++;
      continue;
    }
    push("default", c); // `$`, `~`, `@`, `;`, backtick: no role at top level
    i++;
  }
  return runs;

  /** Booleans/null (lowercase exactly) -> key (the same-line `=` glue;
   * the `:` decision says NO) -> fn (the call peek, surviving the dot) ->
   * default. There are no keywords, no types, no variable class: this is
   * the honest shape of a language with no reserved words. */
  function classify(word: string, after: number): string {
    if (word === "true" || word === "false") return "boolean";
    if (word === "null") return "null";
    if (peekAssign(text, after)) return "key";
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

/** The same-line `=` glue (json.ts's key reading narrowed to one line):
 * spaces and tabs may sit between the identifier and the sign, a newline
 * may not; the sign must not be the head of `==` or the `=>` arrow, so
 * comparisons and object-for keys stay plain words. */
function peekAssign(text: string, from: number): boolean {
  let j = from;
  while (text[j] === " " || text[j] === "\t") j++;
  return text[j] === "=" && text[j + 1] !== "=" && text[j + 1] !== ">";
}

/** Quoted template: escapes honored, an unterminated literal stops before
 * an unescaped newline -- but a backslash before that newline splices the
 * line and the scan carries on (the c.ts family). `${...}` holes and
 * `%{...}` directives ride the run (the rust ruling), so a quote inside a
 * hole closes the literal: `"${join(", ", x)}"` ends early and the tail
 * re-reads as junk, the documented cost of not parsing holes. */
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

/** Heredoc from `<<` (ruby.ts's scan adjusted for this language): the
 * optional `-` marker, then the identifier label GLUED (dashes allowed by
 * the identifier rule; air, a digit, or the foreign `~` marker arm
 * nothing). The closer is a line BEGINNING with the same label -- bare
 * `<<` wants column 0, `<<-` tolerates indentation -- with no identifier
 * char or dash following (a longer word is not the closer); the run ends
 * right after the label and the closer line's tail rides the next run.
 * Quoted labels do not exist here (the ruby forms are gone). A never-
 * closed opener runs to end of input. */
function endOfHeredoc(text: string, from: number): number {
  let j = from + 2;
  let indented = false;
  if (text[j] === "-") {
    indented = true;
    j++;
  }
  if (!IDENT_START_RE.test(text[j] ?? "")) return -1;
  const labelStart = j;
  j = scanIdent(text, j);
  const label = text.slice(labelStart, j);
  let line = j;
  while (line < text.length) {
    const nl = text.indexOf("\n", line);
    const lineEnd = nl === -1 ? text.length : nl + 1;
    let k = line;
    if (indented) {
      while (k < lineEnd && (text[k] === " " || text[k] === "\t")) k++;
    }
    const after = k + label.length;
    if (text.startsWith(label, k) && !IDENT_RE.test(text[after] ?? "") && text[after] !== "-") return after;
    line = lineEnd;
  }
  return text.length;
}

/** UAX #31 plus the spec's dash: ID_Start then ID_Continue or `-`, greedy
 * as the grammar states -- `my-var` is ONE word, `x-1` is one identifier
 * (the spec's own subtraction trap), and `a - 1` with air separates. */
function scanIdent(text: string, from: number): number {
  const n = text.length;
  let j = from;
  if (j < n && IDENT_START_RE.test(text[j]!)) j++;
  while (j < n && (IDENT_RE.test(text[j]!) || text[j] === "-")) j++;
  return j;
}

const IDENT_START_RE = /[A-Za-z_\u00a0-\uffff]/;
const IDENT_RE = /[\w\u00a0-\uffff]/;
const CLOSER = "*/";

/** Single-char operators (the spec's delimiters and singles; `#` and the
 * comment arms are handled above, `$` has NO top-level role and rides a
 * default byte). There is no `~`, `@`, `;`, or backtick operator here. */
const OPERATOR_RE = /[{}()[\],.?:+\-*/<>=!&|%]/;

/** The two-char operator runs (the spec's table): comparisons, the
 * logical pair, and the object-for arrow. NO shift (`<<` past the heredoc
 * arm is two singles), no `..`, no `::`. */
const TWO_CHAR_OPS = new Set(["==", "!=", "<=", ">=", "&&", "||", "=>"]);

/** The numeric dialect: decimal-only (the spec's grammar) -- digits, an
 * optional `.digits` fraction, an optional exponent with sign. NO hex,
 * octal, binary, underscore separators, suffixes, or leading-dot floats;
 * the scan never produces a shape needing validation, so `1_0` splits at
 * the underscore (number plus word) instead of distrusting a run. */
function isNumberStart(c: string): boolean {
  return c >= "0" && c <= "9";
}

function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
  if (text[i] === "." && text[i + 1]! >= "0" && text[i + 1]! <= "9") {
    i++;
    while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
  }
  if (text[i] === "e" || text[i] === "E") {
    let j = i + 1;
    if (text[j] === "+" || text[j] === "-") j++;
    if (text[j]! >= "0" && text[j]! <= "9") {
      i = j;
      while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
    }
  }
  return i;
}

/** The registry entry for this lang (assembly list: index.ts). `.tf` and
 * `.tfvars` are the Terraform spellings, `.hcl` the native syntax; no
 * aliases (the canonical name is the fence word -- `terraform` is an
 * application, not a syntax name) and no basenames (`terraform.tfvars`
 * lands through the extension). */
export const HCL_SYNTAX: SyntaxDef = {
  lang: "hcl",
  tokenize: tokenizeHcl,
  extensions: ["tf", "tfvars", "hcl"],
};
