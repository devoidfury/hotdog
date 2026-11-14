import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * SCSS tokenizer.
 *
 * The css.ts scan transfers whole (scss.ts grew from it, and SCSS is a
 * superset of CSS): the statement-peek design (at every statement start --
 * beginning of input, or just after `{`, `}` or `;` -- a quote-aware peek
 * asks whether a `{` comes before the next `;`/`}`, and reads the statement
 * as a selector or a declaration accordingly), both comment spellings
 * (`//` to EOL and the star-slash block form, which runs to its closer or
 * end of input, NOT line-bounded), `--custom-prop` variables, `#hex`
 * colors vs `#id` selectors, the generic atrule arm (`@` plus the name,
 * so EVERY Sass at-rule -- `@mixin`, `@include`, `@use`, `@forward`,
 * `@extend`, `@each`, `@if`, `@else`, `@function`, `@return`, `@error`,
 * `@warn`, `@debug`, `@content`, `@at-root`, `@for`, `@while` -- rides for
 * free: css.ts arms ANY `@name`, so there is no keyword list to extend and
 * the at-rule NAMES plus their preludes read through the statement rules,
 * exactly like `@media` does, pinned), nested `&:hover` selectors, strings
 * that stop at the newline, `!important`'s `!` single, and the numbers
 * with units. The Sass-specific deltas are exactly three, and the flag
 * words (`!default`, `!global`, `!optional`, `!important`) need nothing:
 * the `!` is the parent's operator single and the flag word rides "value"
 * after it, pinned. (1) `$name` is a Sass variable (the family's php
 * "variable" class): `$` then a greedy run of the parent's identifier
 * chars, so `$_private`, `$-led`, `$with-hyphens` and `$with_underscores`
 * are one run each (the spec treats the two separator spellings as the
 * same name anyway); a lone `$` is still one variable run, and at
 * statement start a variable DEFINITION (`$x: 1;`) loses the "property"
 * reading to the variable class -- the peek already says declaration, so
 * the whole `$x` names the variable, pinned. (2) `#{...}` interpolation
 * RIDES the run it sits in and is never parsed (the rust ruling): inside
 * strings it is plain bytes, which carries the documented cost that a
 * quote inside a hole closes the literal -- `#{"a"}` inside a string ends
 * it early and the tail re-reads; inside selector runs and inside the
 * value-position `#` arm the hole is swallowed to its matching `}`
 * (quote-aware, unterminated runs to end of input) so `#{$x}.cls` stays
 * ONE selector run; the statement peek skips holes, so `$x: #{$y};` reads
 * as a declaration (the hole's brace never fakes a block). (3) Nothing
 * else: `%placeholder` selectors ride the parent's selector peek (a
 * statement whose `{` comes first is a selector, and `%` is not a
 * break -- so `%alert { }` is a selector run), and `@extend %foo
 * !optional;` degrades honestly (the peek sees the `;` first, so `%` is a
 * default byte and `foo` a value word -- pinned, selector readings need
 * the block). The indented `.sass` syntax is NOT this language and stays
 * unclaimed (the .ecr/.heex ruling: no def, no guess). Honest limits
 * carried from css.ts: malformed CSS missing a `;` can paint the next
 * chunk as a selector; maps and interpolations in declaration values past
 * a paren read as value material. Nothing is ever dropped or reordered:
 * concatenating every run reproduces the input exactly, for any input.
 * One run per token; adjacent runs may share a type (sinks coalesce as
 * they like). This is display candy, not a Sass parser.
 */
export function tokenizeScss(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let stmtStart = true; // nothing meaningful consumed since input start, `{`, `}` or `;`
  let inDecl = false; // past a declaration colon, before the statement end
  let selCtx: boolean | null = null; // memoized statement peek; reset at every statement start

  while (i < n) {
    const c = text[i]!;
    if (isWs(c)) {
      let j = i;
      while (j < n && isWs(text[j])) j++;
      push("default", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      push("comment", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      let j = i + 2;
      while (j < n && text[j] !== "\n") j++;
      push("comment", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      push("string", text.slice(i, endOfString(text, i)));
      i = endOfString(text, i);
      continue;
    }
    if (stmtStart && "{};,/@!".includes(c) === false) {
      if (selCtx === null) selCtx = blockComesFirst(text, i);
      if (selCtx) {
        const j = consumeSelector(text, i);
        if (j > i) {
          push("selector", text.slice(i, j));
          i = j;
          continue;
        }
      }
    }
    if (c === "{" || c === "}" || c === ";") {
      push("operator", c);
      stmtStart = true;
      inDecl = false;
      selCtx = null;
      i++;
      continue;
    }
    if (c === "@") {
      let j = i + 1;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      push("atrule", text.slice(i, j));
      i = j; // the prelude reads through the statement rules; stmtStart holds
      continue;
    }
    if (c === ",") {
      push("operator", ",");
      // A comma inside a selector statement keeps the selector context
      // (`.a, .b {`); inside a declaration it does not (`Arial, serif`).
      if (stmtStart && selCtx === null) selCtx = blockComesFirst(text, i);
      if (selCtx !== true) stmtStart = false;
      i++;
      continue;
    }
    stmtStart = false;
    if (c === ":") {
      push("operator", ":");
      inDecl = true;
      i++;
      continue;
    }
    if (c === "!") {
      push("operator", "!");
      i++;
      continue;
    }
    if (c === "(") {
      const j = consumeParens(text, i);
      pushGroupRuns(text.slice(i, j), push);
      i = j;
      continue;
    }
    if (c === "$") {
      // Sass variable: `$` plus the greedy identifier run. A lone `$` is
      // still one variable run (the scan includes the sign either way).
      let j = i + 1;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      push("variable", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      let j = i + 2;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      push("variable", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "#") {
      if (text[i + 1] === "{") {
        // Interpolation riding a value position: the hole is swallowed to
        // its matching `}` (quote-aware) and rides ONE value run unparsed.
        const j = consumeBracket(text, i + 1, "{", "}");
        push("value", text.slice(i, j));
        i = j;
        continue;
      }
      let j = i + 1;
      while (j < n && HEX_RE.test(text[j]!)) j++;
      push(inDecl && HEX_COLOR_RE.test(text.slice(i, j)) ? "color" : "value", text.slice(i, j));
      i = j;
      continue;
    }
    if (startsNumber(c, text[i + 1], text[i + 2])) {
      let j = c === "-" || c === "+" ? i + 1 : i;
      while (j < n && NUM_HEAD_RE.test(text[j]!)) j++;
      while (j < n && UNIT_RE.test(text[j]!)) j++; // the unit rides the number run
      push("number", text.slice(i, j));
      i = j;
      continue;
    }
    if (IDENT_RE.test(c)) {
      let j = i;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      const after = skipWs(text, j);
      push(text[after] === ":" ? "property" : "value", text.slice(i, j));
      i = j;
      continue;
    }
    push("default", c);
    i++;
  }
  return runs;
}

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

const skipWs = (text: string, from: number): number => {
  let j = from;
  while (j < text.length && isWs(text[j])) j++;
  return j;
};

const IDENT_RE = /[-\w\u00a0-\uffff]/;
const HEX_RE = /[0-9a-fA-F]/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const NUM_HEAD_RE = /[0-9.]/;
const UNIT_RE = /[%\w\u00a0-\uffff]/;

const startsNumber = (c: string, next: string | undefined, after: string | undefined): boolean =>
  /[0-9]/.test(c) ||
  (c === "." && next !== undefined && /[0-9]/.test(next)) ||
  ((c === "-" || c === "+") && (/[0-9]/.test(next ?? "") || (next === "." && /[0-9]/.test(after ?? ""))));

/** End index just past the string opened at `from` (quotes included). An
 * unterminated string stops before an unescaped newline, like CSS.
 * `#{...}` holes are plain bytes inside the run (the rust ruling): a quote
 * inside a hole closes the literal, the documented cost. */
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

/** End of a selector run: ident chars plus bracketed/parenthesized groups
 * and `#{...}` interpolation holes (quote-aware) until whitespace or
 * structural punctuation. The hole swallow keeps `#{$x}.cls` one run; an
 * unterminated hole runs to the end. */
function consumeSelector(text: string, from: number): number {
  const n = text.length;
  let i = from;
  while (i < n) {
    const d = text[i]!;
    if (d === "[") {
      i = consumeBracket(text, i, "[", "]");
      continue;
    }
    if (d === "(") {
      i = consumeParens(text, i);
      continue;
    }
    if (d === "#" && text[i + 1] === "{") {
      i = consumeBracket(text, i + 1, "{", "}");
      continue;
    }
    if (d === '"' || d === "'") {
      i = endOfString(text, i);
      continue;
    }
    if (d === "/" && (text[i + 1] === "*" || text[i + 1] === "/")) break; // a comment ends the run
    if (isWs(d) || "{};,@".includes(d) || d === "/") break;
    i++;
  }
  return i;
}

function consumeBracket(text: string, from: number, open: string, close: string): number {
  const n = text.length;
  let depth = 0;
  let i = from;
  for (; i < n; i++) {
    const d = text[i]!;
    if (d === '"' || d === "'") {
      i = endOfString(text, i) - 1;
      continue;
    }
    if (d === open) depth++;
    else if (d === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return n; // unbalanced: the whole remainder belongs to the run
}

/** Matching close included; unterminated means end of input. */
const consumeParens = (text: string, from: number): number => consumeBracket(text, from, "(", ")");

/** Statement peek: true when a `{` precedes the next `;` or `}`.
 * Interpolation holes are skipped whole, so a `#{...}` in a declaration
 * value never fakes a block and a `#{$x} {` selector is still a selector. */
function blockComesFirst(text: string, from: number): boolean {
  const n = text.length;
  let i = from;
  while (i < n) {
    const d = text[i]!;
    if (d === '"' || d === "'") {
      i = endOfString(text, i);
      continue;
    }
    if (d === "#" && text[i + 1] === "{") {
      i = consumeBracket(text, i + 1, "{", "}");
      continue;
    }
    if (d === "/") {
      if (text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        i = end === -1 ? n : end + 2;
        continue;
      }
      if (text[i + 1] === "/") {
        const end = text.indexOf("\n", i + 2);
        i = end === -1 ? n : end;
        continue;
      }
    }
    if (d === "{") return true;
    if (d === ";" || d === "}") return false;
    i++;
  }
  return false;
}

/** Classify one parenthesized group (`(` through its matching `)` or the end
 * of input): the parens are "operator", `$sass-vars` and `--custom-props`
 * ride "variable", numbers keep their class, and everything else inside
 * reads as value material (which is what makes `url(data:...)`,
 * `var(--x)` and `rgba($base-color, 0.88)` stay whole). */
function pushGroupRuns(chunk: string, push: (type: string, text: string) => void): void {
  const n = chunk.length;
  let i = 0;
  while (i < n) {
    const c = chunk[i]!;
    if (isWs(c)) {
      let j = i;
      while (j < n && isWs(chunk[j])) j++;
      push("default", chunk.slice(i, j));
      i = j;
    } else if (c === '"' || c === "'") {
      push("string", chunk.slice(i, endOfString(chunk, i)));
      i = endOfString(chunk, i);
    } else if (c === "(" || c === ")") {
      push("operator", c);
      i++;
    } else if (c === "$") {
      let j = i + 1;
      while (j < n && IDENT_RE.test(chunk[j]!)) j++;
      push("variable", chunk.slice(i, j));
      i = j;
    } else if (c === "-" && chunk[i + 1] === "-") {
      let j = i + 2;
      while (j < n && IDENT_RE.test(chunk[j]!)) j++;
      push("variable", chunk.slice(i, j));
      i = j;
    } else if (startsNumber(c, chunk[i + 1], chunk[i + 2])) {
      let j = c === "-" || c === "+" ? i + 1 : i;
      while (j < n && NUM_HEAD_RE.test(chunk[j]!)) j++;
      while (j < n && UNIT_RE.test(chunk[j]!)) j++;
      push("number", chunk.slice(i, j));
      i = j;
    } else {
      let j = i;
      while (j < n && !isWs(chunk[j]) && !"()'\"".includes(chunk[j]!)) j++;
      push("value", chunk.slice(i, j));
      i = j;
    }
  }
}

/** The registry entry for this lang (assembly list: index.ts). Only `.scss`
 * is claimed: the indented `.sass` syntax is a different reading of the
 * same language and stays HONESTLY UNCLAIMED (the .ecr/.heex ruling -- a
 * brace-driven scan per line does not speak indentation), pinned undefined
 * in the file-view test. No basenames, no aliases (the canonical name is
 * the fence word). */
export const SCSS_SYNTAX: SyntaxDef = {
  lang: "scss",
  tokenize: tokenizeScss,
  extensions: ["scss"],
};
