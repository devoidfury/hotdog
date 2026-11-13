import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Make tokenizer.
 *
 * One pass, line-based (the dockerfile/c lineStart family): a line whose
 * first significant character is a TAB is a RECIPE and gets no parsing
 * inside (the shell-inside-RUN doctrine verbatim) -- the whole line rides "default"
 * except a `#`, which opens a "comment" to EOL (make strips comments in
 * recipes, and make has no string quotes to guard one), and `$(NAME)`,
 * `${NAME}` and the single-character automatics (`$@`, `$<`, `$^`) which
 * lift to "variable" (the css custom-property reading, the dockerfile
 * precedent -- an interpolation lift, not shell parsing). On a non-recipe
 * line: `#` anywhere is "comment" to EOL (make strips comments outside
 * recipes too); a directive word at line start (`ifeq ifneq ifdef ifndef
 * endif include export define endef undefine override vpath`, lowercase --
 * make is not dockerfile, the directives are case-sensitive) is
 * "keyword"; a target-or-variable NAME followed (across horizontal
 * whitespace) by an
 * assignment or rule operator rides "key" -- targets and variables share
 * one accent reading, the yaml-keys precedent -- with the whole glued
 * operator (`:=`, `::=`, `+=`, `?=`, `::`, `:`, `=`) as one "operator"
 * run; `$(`, `${` and `$X` anywhere else lift to "variable". Honest
 * limits: backslash continuations degrade line-wise (each physical line
 * tokenizes on its own, so a continuation tail reads as its own junk
 * line); the recipe-prefix characters `@`, `-`, `+` ride default (they
 * only exist at a recipe start, already covered by the tab rule);
 * `-include`/`sinclude` read as plain words; a value that merely looks
 * like `NAME:` (a URL on a define line) gets the key reading, a cheerful
 * false positive the display happily lives with. Nothing is ever dropped
 * or reordered: concatenating every run reproduces the input exactly, for
 * any input. One run per token; adjacent runs may share a type (sinks
 * coalesce as they like). This is display candy, not a Make parser.
 */
export function tokenizeMake(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let lineStart = true; // nothing significant pushed since the last newline
  while (i < n) {
    const c = text[i]!;
    if (lineStart && c === "\t") {
      i = recipeLine(text, runs, i);
      lineStart = false; // the recipe branch ran the line to its end
      continue;
    }
    if (isWs(c)) {
      let j = i;
      let sawNewline = false;
      while (j < n && isWs(text[j])) {
        if (text[j] === "\n") {
          sawNewline = true;
          j++;
          if (text[j] === "\t") break; // the recipe tab stays visible to the tab rule
          continue;
        }
        j++;
      }
      push("default", text.slice(i, j));
      i = j;
      if (sawNewline) lineStart = true; // a newline arms the next line; spaces never spend it
      continue;
    }
    if (c === "#") {
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      push("comment", text.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }
    if (lineStart) {
      const m = DIRECTIVE_RE.exec(text.slice(i));
      if (m) {
        push("keyword", m[0]);
        i += m[0].length;
        lineStart = false;
        continue;
      }
    }
    if (c === "$") {
      const end = endOfVariable(text, i);
      push(end > i + 1 ? "variable" : "default", text.slice(i, end));
      i = end;
      lineStart = false;
      continue;
    }
    if (NAME_START_RE.test(c)) {
      let j = i;
      while (j < n && NAME_RE.test(text[j]!)) j++;
      const op = assignmentOpAt(text, j);
      if (op > j) {
        push("key", text.slice(i, j));
        i = j;
        lineStart = false;
        continue;
      }
      push("default", text.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }
    if (OPERATOR_RE.test(c)) {
      const end = scanOperator(text, i);
      push("operator", text.slice(i, end));
      i = end;
      lineStart = false;
      continue;
    }
    push("default", c);
    i++;
    lineStart = false;
  }
  return runs;
}

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

/** The tab-led recipe: no parsing inside (the shell body is opaque), so
 * only the two constructs make it past the wash: a # comment (make strips
 * those) and the variable interpolations the recipe exists to expand. */
function recipeLine(text: string, runs: SyntaxRun[], from: number): number {
  const n = text.length;
  let i = from;
  let plain = i; // start of the pending default run
  while (i < n && text[i] !== "\n" && text[i] !== "\r") {
    const c = text[i]!;
    if (c === "#") {
      if (i > plain) runs.push({ type: "default", text: text.slice(plain, i) });
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      runs.push({ type: "comment", text: text.slice(i, j) });
      return j;
    }
    if (c === "$") {
      const end = endOfVariable(text, i);
      if (end > i + 1) {
        if (i > plain) runs.push({ type: "default", text: text.slice(plain, i) });
        runs.push({ type: "variable", text: text.slice(i, end) });
        i = plain = end;
        continue;
      }
    }
    i++;
  }
  if (i > plain) runs.push({ type: "default", text: text.slice(plain, i) });
  return i;
}

/** The directive set (GNU make, lowercase, matched only at line start;
 * `endif` rides with its openers, the pair to the plan's set -- dropping
 * it while `endef` stays would read lopsided). */
const DIRECTIVE_RE =
  /^(?:ifeq|ifneq|ifdef|ifndef|endif|include|export|define|endef|undefine|override|vpath)(?![A-Za-z0-9_-])/;

/** Target/variable names: word characters plus the target spellings (dots,
 * slashes, hyphens, pattern `%`). */
const NAME_START_RE = /[A-Za-z_%./-]/;
const NAME_RE = /[\w.$%/-]/;

/** The assignment/rule operators, tried longest-first; `+=`/`?=` only
 * count when glued right behind the name (make requires that). */
const ASSIGN_OPS = ["::=", ":=", "::", "+=", "?=", "=", ":"];

/** The position after the glued operator if an assignment/rule operator
 * follows the name at `after` (across horizontal whitespace), else `after`
 * itself -- the peek that decides the "key" reading. */
function assignmentOpAt(text: string, after: number): number {
  let j = after;
  while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
  for (const op of ASSIGN_OPS) {
    if (text.startsWith(op, j)) return j + op.length;
  }
  return after;
}

/** A leftover operator run (unreached by the name peek -- e.g. the `=` of
 * a value-less define line): the whole glued [:=] gesture. */
function scanOperator(text: string, from: number): number {
  let i = from;
  while (i < text.length && ":=+?".includes(text[i]!)) i++;
  return i;
}

/** `$(NAME)`, `${NAME}` or a single-character automatic (`$@`, `$<`,
 * `$*`, `$?`, `$^`, `$+`, `$%`, `$|`, `$-`); a `$` that opens none of
 * these is one character of plain text. */
function endOfVariable(text: string, from: number): number {
  const n = text.length;
  const open = text[from + 1];
  if (open === "(" || open === "{") {
    const close = open === "(" ? ")" : "}";
    let j = from + 2;
    while (j < n && text[j] !== close && text[j] !== "\n" && text[j] !== "\r") j++;
    return text[j] === close ? j + 1 : j;
  }
  if (open !== undefined && /[A-Za-z0-9_@<*?^+%|-]/.test(open)) {
    return from + 2;
  }
  return from + 1;
}

const OPERATOR_RE = /[:=+?]/;

/** The registry entry for this lang (assembly list: index.ts). */
export const MAKE_SYNTAX: SyntaxDef = {
  lang: "make",
  tokenize: tokenizeMake,
  aliases: ["makefile"],
  basenames: ["Makefile", "GNUmakefile"],
  extensions: ["mk", "mak"],
};
