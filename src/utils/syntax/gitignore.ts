import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Gitignore tokenizer.
 *
 * One pass, line-aware: a line-leading `#` is one "comment" run through the
 * line end; a line-leading `!` is one "operator" run for the negation marker;
 * path separators and glob metacharacters (`/`, `*`, `?`, `[`, `]`, `{`, `}`)
 * are single "operator" runs; a backslash escapes the following byte as literal
 * pattern text; everything else rides "default". Honest limits: git's trailing
 * whitespace trimming, escaped quotes, and `**` as a unit are not modeled --
 * `**` reads as two ordinary glob operators, which is fine for display. Nothing
 * is ever dropped or reordered: concatenating every run reproduces the input
 * exactly, for any input. One run per token; adjacent runs may share a type
 * (sinks coalesce as they like). This is display candy, not a gitignore
 * matcher.
 */
export function tokenizeGitignore(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let lineStart = true;

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
      if (sawNewline) lineStart = true;
      continue;
    }
    if (c === "#" && lineStart) {
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      push("comment", text.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }
    if (c === "\\") {
      const next = text[i + 1];
      if (next !== undefined && next !== "\n" && next !== "\r") {
        push("default", text.slice(i, i + 2));
        i += 2;
      } else {
        push("default", c);
        i++;
      }
      lineStart = false;
      continue;
    }
    if (c === "!" && lineStart) {
      push("operator", c);
      i++;
      lineStart = false;
      continue;
    }
    if (SPECIAL_RE.test(c)) {
      push("operator", c);
      i++;
      lineStart = false;
      continue;
    }

    let j = i;
    while (j < n && !isWs(text[j]) && !SPECIAL_RE.test(text[j]!)) j++;
    push("default", text.slice(i, j === i ? i + 1 : j));
    i = j === i ? i + 1 : j;
    lineStart = false;
  }
  return runs;
}

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const SPECIAL_RE = /[/*?[\]{}\\]/;

/** The registry entry for this lang (assembly list: index.ts). */
export const GITIGNORE_SYNTAX: SyntaxDef = {
  lang: "gitignore",
  tokenize: tokenizeGitignore,
  aliases: ["gitignore"],
  basenames: [".gitignore", ".gitignore_global"],
};
