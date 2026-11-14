import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Diff/patch tokenizer.
 *
 * The line family (gitignore.ts / dockerfile.ts), taken to its honest end:
 * a patch line IS its class, so ONE RUN PER LINE is the shape. The file
 * view tokenizes per line, so every rule arms at the start of the given
 * text (the gitignore position-blind doctrine), and the whole pass simply
 * re-arms the same rules after each newline; whole-pass and per-line calls
 * agree by construction. Line classes: `+++ ` or `--- ` opens a file
 * header and rides "meta" (the exact prefix WITH SPACE, so an added line
 * whose content starts with `++` -- `+++i;` -- is `+` plus text and reads
 * "added"; the same space rule saves a removed `--foo` line from becoming
 * a header, and the residual ambiguity (a removed line whose content
 * starts exactly with `-- `) is the format's own, cheerfully inherited);
 * `@@` opens a hunk header and the WHOLE line rides "hunk" (one run, no
 * range parsing); the git metadata prefixes (`diff --git`, `index `,
 * `new file mode`, `deleted file mode`, `old mode`, `new mode`, `rename
 * from`, `rename to`, `copy from`, `copy to`, `similarity index`, `Binary
 * files `, `GIT binary patch`) and the leading `\` of the "No newline at
 * end of file" notice ride "meta"; a line starting `+` is "added" whole
 * (its content is NOT sub-tokenized -- an added hunk line is not parsed
 * as its language here), a line starting `-` is "removed", and everything
 * else (context lines, empty lines, patch body junk) rides "default".
 * The class decision, stated: "added"/"removed"/"hunk"/"meta" are NEW
 * classes the sinks do not know yet; unknown classes render unstyled by
 * design (the index.ts contract) and the palette work is sink-side, NOT
 * this batch. Reusing "string"/"boolean" for display effect was rejected:
 * the classes name what the line IS. Trivia shape: the newline (LF, CR, or
 * CRLF pair) is its own "default" run, so empty lines and line endings
 * survive every filter. Nothing is ever dropped or reordered:
 * concatenating every run reproduces the input exactly, for any input.
 * This is display candy, not a patch applicator.
 */
export function tokenizeDiff(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
    const line = text.slice(i, j);
    push(classifyLine(line), line); // one run per line: the line IS its class
    if (j < n) {
      // The line ending is its own default run (the house trivia shape):
      // an empty content line plus its newline never collapses to nothing.
      const end = text[j] === "\r" && text[j + 1] === "\n" ? j + 2 : j + 1;
      push("default", text.slice(j, end));
      j = end;
    }
    i = j;
  }
  return runs;
}

/** The whole of the language, per line. Order: hunk, then the two header
 * spellings (before the `+`/`-` arms, space required), then the backslash
 * notice and the git metadata prefixes, then added/removed, then plain. */
function classifyLine(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return "meta";
  if (line.startsWith("\\")) return "meta"; // "\ No newline at end of file"
  if (META_PREFIX_RE.test(line)) return "meta";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "default";
}

/** Git's own header/preamble lines. No prefix here starts with `+`, `-`,
 * `@`, or `\`, so this arm cannot shadow the classes above; context lines
 * carry a leading space, so they cannot shadow this one either. */
const META_PREFIX_RE =
  /^(?:diff |index |new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to|similarity index|Binary files |GIT binary patch)/;

/** The registry entry for this lang (assembly list: index.ts). `.rej` --
 * the conflict output -- is deliberately unclaimed: it is its own honest
 * shape, not a patch. */
export const DIFF_SYNTAX: SyntaxDef = {
  lang: "diff",
  tokenize: tokenizeDiff,
  extensions: ["diff", "patch"],
};
