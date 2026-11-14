// Unit tests for the Gitignore tokenizer (src/utils/syntax/gitignore.ts):
// typed runs with exact classes and spans over targeted fixtures (comment
// lines, the leading negation marker, path separators and glob metacharacters),
// line-wise degradation pins for the file view, a losslessness sweep over a
// nasty fixture corpus plus a deterministic fragment generator, and the
// registry wiring pins (basenames and aliases).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeGitignore } from "@utils/syntax/gitignore.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

const TYPES = new Set(["comment", "operator", "default"]);

const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeGitignore structure", () => {
  it("comment lines and leading negation markers read cleanly", () => {
    expect(significant(tokenizeGitignore("# ignore\n!keep\n"))).toEqual([
      run("comment", "# ignore"),
      run("operator", "!"),
      run("default", "keep"),
    ]);
  });

  it("glob metacharacters and separators are operators", () => {
    expect(significant(tokenizeGitignore("logs/**\n/src/*.js\n"))).toEqual([
      run("default", "logs"),
      run("operator", "/"),
      run("operator", "*"),
      run("operator", "*"),
      run("operator", "/"),
      run("default", "src"),
      run("operator", "/"),
      run("operator", "*"),
      run("default", ".js"),
    ]);
  });

  it("escaped bytes stay literal default text", () => {
    expect(significant(tokenizeGitignore("tmp\\ dir\nfoo\\*bar\n"))).toEqual([
      run("default", "tmp"),
      run("default", "\\ "),
      run("default", "dir"),
      run("default", "foo"),
      run("default", "\\*"),
      run("default", "bar"),
    ]);
  });

  it("a non-leading ! and a non-leading # stay ordinary pattern text", () => {
    expect(significant(tokenizeGitignore("foo!bar\nfoo#bar\n"))).toEqual([
      run("default", "foo!bar"),
      run("default", "foo#bar"),
    ]);
  });
});

describe("tokenizeGitignore line-wise degradation", () => {
  it("each line is tokenized independently, even when it opens with spaces", () => {
    expect(significant(tokenizeGitignore("   # comment\n  !keep\n"))).toEqual([
      run("comment", "# comment"),
      run("operator", "!"),
      run("default", "keep"),
    ]);
  });
});

describe("tokenizeGitignore registry contract", () => {
  it("guesses: .gitignore and global spelling land; aliases never guess files", () => {
    expect(guessLangForBase(".gitignore")).toBe("gitignore");
    expect(guessLangForBase(".gitignore_global")).toBe("gitignore");
    expect(guessLangForBase(".gitignore.local")).toBe("gitignore");
    expect(guessLangForBase("foo.gitignore")).toBeUndefined();
    expect(resolveSyntaxLang("gitignore")).toBe("gitignore");
    expect(getTokenizer("gitignore")).toBe(tokenizeGitignore);
  });
});

describe("tokenizeGitignore losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\n",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "a".repeat(50000),
    "#",
    "#\n",
    "!",
    "!keep",
    "foo!bar",
    "logs/**",
    "/src/*.js",
    "tmp\\ dir",
    "foo\\*bar",
    "[abc]/x",
    "🚀 emoji ünïcøde 漢字",
    "  \t  \n",
    "**/*",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeGitignore(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "#",
      "!/",
      "/",
      "*",
      "?",
      "[",
      "]",
      "{",
      "}",
      "\\",
      "\\",
      "foo",
      "bar",
      " ",
      "\n",
      "\r\n",
      "\t",
      "🚀",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeGitignore(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("gitignore tokenizer wiring", () => {
  it("getTokenizer resolves gitignore to tokenizeGitignore and classifies a sample", () => {
    const doc = ["# build", "!dist", "src/**", "*.log"].join("\n");
    const runs = getTokenizer("gitignore")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual(["# build"]);
    expect(runs.filter((r) => r.type === "operator").map((r) => r.text)).toEqual([
      "!",
      "/",
      "*",
      "*",
      "*",
    ]);
  });
});
