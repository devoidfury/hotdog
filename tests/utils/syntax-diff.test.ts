// Unit tests for the diff tokenizer (src/utils/syntax/diff.ts): the line
// family (gitignore.ts/dockerfile.ts) taken to its honest end -- ONE RUN PER
// LINE, whole-pass == per-line by construction -- with the exact-structure
// fixtures over a git patch, the `+++ `/`--- ` header-vs-content space rule
// (and the residual `-- `-content ambiguity pinned as the format's own),
// the git metadata prefix zoo, the "\ No newline" notice, the whole-line
// hunk header, CRLF/CR/LF trivia as their own default runs, the new classes
// (added/removed/hunk/meta) the sinks do not know yet, a losslessness sweep
// over a nasty fixture corpus plus a deterministic fragment generator, and
// the registry wiring pins (.rej honestly unclaimed, .patch never an alias).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeDiff } from "@utils/syntax/diff.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

// One run per line: the classes are the NEW diff family (unknown to the
// sinks until the palette follow-up, which is sink-side work) plus the
// default trivia carrier. No comment/string/keyword exists here -- added
// content is never sub-tokenized.
const TYPES = new Set(["default", "added", "removed", "hunk", "meta"]);

const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeDiff structure", () => {
  it("a full git patch: meta header, hunk, context, added, removed, no-newline notice", () => {
    const code = [
      "diff --git a/b.txt b/b.txt",
      "index 1234567..89abcde 100644",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1,3 +1,4 @@",
      " context line",
      "-removed line",
      "+added line",
      "+another added",
      "\\ No newline at end of file",
    ].join("\n");
    expect(significant(tokenizeDiff(code))).toEqual([
      run("meta", "diff --git a/b.txt b/b.txt"),
      run("meta", "index 1234567..89abcde 100644"),
      run("meta", "--- a/b.txt"),
      run("meta", "+++ b/b.txt"),
      run("hunk", "@@ -1,3 +1,4 @@"),
      run("default", " context line"), // context is a plain line, leading space and all
      run("removed", "-removed line"),
      run("added", "+added line"),
      run("added", "+another added"),
      run("meta", "\\ No newline at end of file"),
    ]);
  });

  it("the header space rule: `+++ `/`--- ` with the exact prefix, everything else is +/-", () => {
    const code = [
      "+++ b/file.c", // header: prefix + space
      "+++i;", // added content starting with `++`: no space, no header
      "++x", // added content starting with `+` of a `++` operator
      "--- a/file.c", // header
      "---x", // removed content: two dashes are not `--- `
      "-- foo", // removed content starting with `--`: not the header shape
      "+--- fake header", // added (starts with `+`)
      "-+++ fake header", // removed (starts with `-`)
    ].join("\n");
    expect(significant(tokenizeDiff(code))).toEqual([
      run("meta", "+++ b/file.c"),
      run("added", "+++i;"),
      run("added", "++x"),
      run("meta", "--- a/file.c"),
      run("removed", "---x"),
      run("removed", "-- foo"),
      run("added", "+--- fake header"),
      run("removed", "-+++ fake header"),
    ]);
  });

  it("the format's own ambiguity: removed content starting with `-- ` wears the header", () => {
    // A removed line is `-` + content, so content starting `-- ` produces
    // the `--- ` prefix. Git's own parsers face the same collision; this
    // scanner reads the line as meta and the loss stays pinned here.
    expect(tokenizeDiff('--- this was "-- content"')).toEqual([run("meta", '--- this was "-- content"')]);
  });

  it("hunk headers ride whole: ranges, function context, combined-diff @@@ all one run", () => {
    for (const line of [
      "@@ -1 +1 @@",
      "@@ -1,3 +1,4 @@",
      "@@ -10,7 +10,8 @@ void greet(const char *name) {",
      "@@@ -1,2,3 +1,2,3 @@@ combined merge header",
    ]) {
      expect(tokenizeDiff(line)).toEqual([run("hunk", line)]);
    }
  });

  it("the git metadata prefix zoo", () => {
    const code = [
      "diff --git a/x b/x",
      "index abc..def 100644",
      "old mode 100644",
      "new mode 100755",
      "new file mode 100644",
      "deleted file mode 100644",
      "rename from old.txt",
      "rename to new.txt",
      "copy from a.txt",
      "copy to b.txt",
      "similarity index 95%",
      "Binary files a/x and b/x differ",
      "GIT binary patch",
    ].join("\n");
    expect(tokenizeDiff(code).filter((r) => r.type !== "default")).toHaveLength(13);
    expect(significant(tokenizeDiff(code))).toEqual(code.split("\n").map((l) => run("meta", l)));
    // Near-misses are not metadata: they lack the exact prefix. Matching
    // is by PREFIX, so `rename fromX` (junk line) does read meta and the
    // bare `GIT binary patch extra` is just what it names; the space-
    // terminated prefixes (`diff `, `index `), though, hold the line.
    expect(significant(tokenizeDiff("diffx --git\nindexed 1\nrename fromX"))).toEqual([
      run("default", "diffx --git"),
      run("default", "indexed 1"),
      run("meta", "rename fromX"),
    ]);
  });

  it("added lines are never sub-tokenized: the language inside a + line is bytes", () => {
    expect(significant(tokenizeDiff('+return "<a href=\'x\'> # comment 42";'))).toEqual([
      run("added", '+return "<a href=\'x\'> # comment 42";'),
    ]);
  });

  it("whole pass and per-line calls agree (the file-view contract)", () => {
    const code = [
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-drop",
      "+keep2",
      "\\ No newline at end of file",
    ].join("\n");
    const perLine = code
      .split("\n")
      .flatMap((l) => tokenizeDiff(l));
    expect(significant(tokenizeDiff(code))).toEqual(significant(perLine));
  });
});

describe("tokenizeDiff trivia and line endings", () => {
  it("the newline is its own default run; empty lines survive as bare newlines", () => {
    expect(tokenizeDiff("+a\n\n+b")).toEqual([
      run("added", "+a"),
      run("default", "\n"),
      run("default", "\n"),
      run("added", "+b"),
    ]);
    expect(tokenizeDiff("")).toEqual([]);
    expect(tokenizeDiff("\n")).toEqual([run("default", "\n")]);
    expect(tokenizeDiff("   \n")).toEqual([run("default", "   "), run("default", "\n")]);
  });

  it("CRLF and lone CR count as line endings", () => {
    expect(significant(tokenizeDiff("+a\r\n- b\r\nctx\r\n"))).toEqual([
      run("added", "+a"),
      run("removed", "- b"),
      run("default", "ctx"),
    ]);
    expect(tokenizeDiff("+x\r+y\r")).toEqual([
      run("added", "+x"),
      run("default", "\r"),
      run("added", "+y"),
      run("default", "\r"),
    ]);
    // A bare CR inside a line would end it, so a lone \r never rides INSIDE
    // a classified line.
    expect(tokenizeDiff("@\r@")).toEqual([
      run("default", "@"),
      run("default", "\r"),
      run("default", "@"),
    ]);
  });

  it("unicode and junk lines ride default whole", () => {
    expect(significant(tokenizeDiff("🚀 emoji ünïcøde 漢字"))).toEqual([run("default", "🚀 emoji ünïcøde 漢字")]);
  });
});

describe("tokenizeDiff registry contract", () => {
  it("guesses and fences resolve through the registry; .rej stays unclaimed", () => {
    expect(guessLangForBase("a.diff")).toBe("diff");
    expect(guessLangForBase("0001-fix.patch")).toBe("diff"); // git-format-patch naming
    expect(guessLangForBase("MAIN.DIFF")).toBe("diff"); // extensions are case-insensitive
    expect(guessLangForBase("my.patch")).toBe("diff");
    expect(guessLangForBase("file.rej")).toBeUndefined(); // conflict output: its own honest shape
    expect(guessLangForBase("file.diffx")).toBeUndefined();
    expect(guessLangForBase("diff")).toBeUndefined(); // dotless, no basename claim
    expect(resolveSyntaxLang("diff")).toBe("diff");
    expect(resolveSyntaxLang("patch")).toBeUndefined(); // extensions are never aliases
    expect(resolveSyntaxLang("DIFF")).toBeUndefined(); // the canonical name resolves exactly
    expect(getTokenizer("diff")).toBe(tokenizeDiff);
  });
});

describe("tokenizeDiff losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\n",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "a".repeat(50000),
    "\\",
    "\\",
    "+",
    "-",
    "@",
    "@@",
    "+++",
    "---",
    "+++ ",
    "--- ",
    "++",
    "--",
    "+\r\n",
    "diff ",
    "index ",
    "GIT binary patch",
    "Binary files ",
    "similarity index",
    "rename from",
    "\\ No newline at end of file",
    "🚀",
    "+++🚀",
    "-" + "-".repeat(100),
    "a\r\n\r\nb",
    "\r\r",
    "\n\r",
    '"',
    "#",
    "'",
    '"unterminated',
    "@@\n@@",
    "+++ a\n--- b",
    "no trailing newline",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeDiff(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "+++",
      "--- ",
      "---",
      "@@",
      "@@ -1 +1 @@",
      "+++ b/f.c",
      "--- a/f.c",
      "+add",
      "-rem",
      " ctx",
      " ",
      "\n",
      "\r\n",
      "\r",
      "\t",
      "\\",
      "\\ No newline at end of file",
      "diff --git a/x b/x",
      "index 1..2",
      "Binary files a b differ",
      "GIT binary patch",
      "new file mode",
      "rename from a",
      "+",
      "-",
      "plain",
      "🚀",
      "#",
      '"',
      "'",
      "++i;",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeDiff(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("diff tokenizer wiring", () => {
  it("getTokenizer resolves diff to tokenizeDiff and classes a real git patch", () => {
    const code = [
      "diff --git a/greet.py b/greet.py",
      "index 8a9f3c1..4b2d9e0 100644",
      "--- a/greet.py",
      "+++ b/greet.py",
      "@@ -1,3 +1,4 @@",
      " def greet(name):",
      "-    return 'hello'",
      "+    msg = 'hello, ' + name",
      "+    return msg",
      "     # unchanged",
    ].join("\n");
    const runs = getTokenizer("diff")!(code);
    expect(runs.map((r) => r.text).join("")).toBe(code); // the registry contract, held
    expect(runs.filter((r) => r.type === "meta").map((r) => r.text)).toEqual([
      "diff --git a/greet.py b/greet.py",
      "index 8a9f3c1..4b2d9e0 100644",
      "--- a/greet.py",
      "+++ b/greet.py",
    ]);
    expect(runs.filter((r) => r.type === "hunk").map((r) => r.text)).toEqual(["@@ -1,3 +1,4 @@"]);
    expect(runs.filter((r) => r.type === "added").map((r) => r.text)).toEqual([
      "+    msg = 'hello, ' + name", // the inner + is bytes, never an operator run
      "+    return msg",
    ]);
    expect(runs.filter((r) => r.type === "removed").map((r) => r.text)).toEqual(["-    return 'hello'"]);
    // No string/keyword/comment runs exist: the python inside never parsed.
    for (const t of ["string", "keyword", "comment", "number", "operator"]) {
      expect(runs.filter((r) => r.type === t)).toEqual([]);
    }
  });
});
