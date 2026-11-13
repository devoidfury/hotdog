import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * CSS tokenizer.
 *
 * Statement-oriented, so it survives line-by-line use (the webui file view
 * calls the tokenizer per line): at every statement start (beginning of
 * input, or just after `{`, `}` or `;`) a quote-aware peek asks whether a
 * `{` comes before the next `;`/`}`. If yes the run names what to style:
 * "selector" (names, `.cls`/`#id`, combinators, pseudo-classes, attribute
 * selectors -- consumed as one run through whitespace and parens like
 * `:not(.x)`). If no, it is a declaration: "property" for the name left of
 * the colon, then value material until the statement end: "number" (unit
 * included: `1.5rem`, `100%`), "color" (`#abc`, `#a1b2c3` -- hex only
 * inside a declaration, where `#` is never an id selector), "variable"
 * (`--custom-props`, inside `var(...)` too), "string", "value" (keywords,
 * function names, anything else right of the colon), with `{} : ; , ( ) !`
 * as "operator". `@media`/`@import`/`@keyframes` open with an "atrule"
 * name and their preludes read through the same rules. Comments ("/* *"
 * and the `//` dialect) and strings always win, so braces inside them
 * never skew anything. An unterminated string stops at the newline (like
 * CSS); an unterminated comment runs to end of input. Honest limits:
 * malformed CSS missing a `;` can paint the next chunk as a selector, and
 * nested `&:hover`-style rules classify by the same peek (correctly, as
 * selectors). Nothing is ever dropped or reordered: concatenating every
 * run reproduces the input exactly, for any input. This is display candy,
 * not a CSS parser.
 */
export function tokenizeCss(text: string): SyntaxRun[] {
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
    if (c === "-" && text[i + 1] === "-") {
      let j = i + 2;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      push("variable", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "#") {
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
 * unterminated string stops before an unescaped newline, like CSS. */
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
 * (quote-aware) until whitespace or structural punctuation. */
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

/** Statement peek: true when a `{` precedes the next `;` or `}`. */
function blockComesFirst(text: string, from: number): boolean {
  const n = text.length;
  let i = from;
  while (i < n) {
    const d = text[i]!;
    if (d === '"' || d === "'") {
      i = endOfString(text, i);
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
 * of input): the parens are "operator", `--vars` ride "variable", numbers
 * keep their class, and everything else inside reads as value material
 * (which is what makes `url(data:...)` and `var(--x)` stay whole). */
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

/** The registry entry for this lang (assembly list: index.ts). */
export const CSS_SYNTAX: SyntaxDef = {
  lang: "css",
  tokenize: tokenizeCss,
  extensions: ["css"],
};
