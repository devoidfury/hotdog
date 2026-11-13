import type { SyntaxRun } from "./index.ts";

/**
 * Dockerfile tokenizer.
 *
 * One pass, line-aware: a line-leading instruction word (`FROM`, `RUN`,
 * `COPY`, the whole closed set, matched case-insensitively -- the spec
 * allows any case) is "keyword"; a line-leading `#` is "comment" to EOL
 * (builder directives like `# syntax=` ride it, they are comments to the
 * parser too); `$VAR` and `${VAR}` (with whatever the braces hold,
 * `${VAR:-default}` included) ride "variable" on the css custom-property
 * reading, while a bare `$` is text; quoted arguments are "string"
 * (escapes honored, an unterminated one stops at the newline, the css/js
 * line-wise family); `=` is "operator"; everything else -- and that
 * includes the shell inside `RUN`, which is NOT parsed -- rides "default".
 * Honest limits: the trailing-backslash continuation is pervasive in real
 * Dockerfiles and is not modeled; each physical line tokenizes on its own,
 * so a continuation's tail (`--mount=... && make`) reads as its own junk
 * line (instruction-shaped words mid-continuation do read as keyword, a
 * cheerful false positive the display happily lives with), and stage names
 * (`AS build`), ENV names and JSON-array arguments are not distinguished
 * from plain words. Nothing is ever dropped or reordered: concatenating
 * every run reproduces the input exactly, for any input. One run per
 * token; adjacent runs may share a type (sinks coalesce as they like).
 * This is display candy, not a Dockerfile parser.
 */
export function tokenizeDockerfile(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let lineStart = true; // nothing significant pushed since the last newline
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
      if (sawNewline) lineStart = true; // a newline arms the next instruction; spaces never spend it
      continue;
    }
    if (lineStart && c === "#") {
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      push("comment", text.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }
    if (lineStart) {
      const m = INSTRUCTION_RE.exec(text.slice(i));
      if (m) {
        push("keyword", m[0]);
        i += m[0].length;
        lineStart = false;
        continue;
      }
    }
    if (c === '"' || c === "'") {
      const end = endOfString(text, i);
      push("string", text.slice(i, end));
      i = end;
      lineStart = false;
      continue;
    }
    if (c === "$") {
      const end = endOfVariable(text, i);
      push(end > i + 1 ? "variable" : "default", text.slice(i, end));
      i = end;
      lineStart = false;
      continue;
    }
    if (c === "=") {
      push("operator", c);
      i++;
      lineStart = false;
      continue;
    }
    // Plain argument bytes: run to the next thing that means something.
    let j = i;
    while (j < n && !isWs(text[j]) && !SPECIAL_RE.test(text[j]!)) j++;
    push("default", text.slice(i, j === i ? i + 1 : j));
    i = j === i ? i + 1 : j;
    lineStart = false;
  }
  return runs;
}

/** The instruction set (buildkit's, MAINTAINER kept for the older files).
 * Matched case-insensitively at line start, and only when the word ends
 * there (`FORM` is not `FOR`... and not an instruction at all). */
const INSTRUCTION_RE =
  /^(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)(?![A-Za-z0-9_-])/i;

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

/** `$NAME` or `${...}` (everything to the closing brace, or to the line
 * end when the brace never closes); a `$` that opens neither is one
 * character of plain text. */
function endOfVariable(text: string, from: number): number {
  const n = text.length;
  if (text[from + 1] === "{") {
    let j = from + 2;
    while (j < n && text[j] !== "}" && text[j] !== "\n" && text[j] !== "\r") j++;
    return text[j] === "}" ? j + 1 : j;
  }
  let j = from + 1;
  while (j < n && /[A-Za-z0-9_]/.test(text[j]!)) j++;
  return j;
}

/** Quoted argument: escapes honored (a backslash before the newline splices
 * past it, the js family), unterminated stops before the newline. */
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

/** Characters that break a plain-run anywhere (a mid-line `#` is literal
 * Dockerfile bytes, so it is NOT here). */
const SPECIAL_RE = /["'$=]/;
