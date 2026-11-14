// Unit tests for the Env/dotenv tokenizer (src/utils/syntax/env.ts): typed
// runs with exact classes and spans over targeted fixtures (the assignment
// rule, the optional export prefix, inline-comment behavior, quoted values),
// line-wise degradation pins for the file view, a losslessness sweep over a
// nasty fixture corpus plus a deterministic fragment generator, and the
// registry wiring pins (extensions, basenames, and fence aliases).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeEnv } from "@utils/syntax/env.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

const TYPES = new Set(["keyword", "comment", "key", "operator", "string", "default"]);

const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeEnv structure", () => {
  it("keys are key and values are string; spaces around = are allowed", () => {
    expect(significant(tokenizeEnv("FOO=bar\nBAZ = 1\n"))).toEqual([
      run("key", "FOO"),
      run("operator", "="),
      run("string", "bar"),
      run("key", "BAZ"),
      run("operator", "="),
      run("string", "1"),
    ]);
  });

  it("export is keyword only when it reaches an assignment", () => {
    expect(significant(tokenizeEnv("export FOO=1\nexport FOO\nexport"))).toEqual([
      run("keyword", "export"),
      run("key", "FOO"),
      run("operator", "="),
      run("string", "1"),
      run("default", "export"),
      run("default", "FOO"),
      run("default", "export"),
    ]);
  });

  it("inline comments require whitespace, but a glued hash stays value bytes", () => {
    expect(significant(tokenizeEnv("A=1 # inline\nB=2#c\n"))).toEqual([
      run("key", "A"),
      run("operator", "="),
      run("string", "1"),
      run("comment", "# inline"),
      run("key", "B"),
      run("operator", "="),
      run("string", "2#c"),
    ]);
  });

  it("quoted values are one string run and do not swallow trailing comments", () => {
    expect(significant(tokenizeEnv(`A='a # b' # comment\nB="say \\"hi\\""\n`))).toEqual([
      run("key", "A"),
      run("operator", "="),
      run("string", "'a # b'"),
      run("comment", "# comment"),
      run("key", "B"),
      run("operator", "="),
      run("string", '"say \\"hi\\""'),
    ]);
  });

  it("an unterminated quoted value stops at the end of the line", () => {
    expect(significant(tokenizeEnv('A="oops\n'))).toEqual([
      run("key", "A"),
      run("operator", "="),
      run("string", '"oops'),
    ]);
  });
});

describe("tokenizeEnv registry contract", () => {
  it("guesses: basenames and variant spellings outrank extensions", () => {
    expect(guessLangForBase(".env")).toBe("env");
    expect(guessLangForBase(".env.local")).toBe("env");
    expect(guessLangForBase(".ENV.PRODUCTION")).toBe("env");
    expect(guessLangForBase("foo.env")).toBe("env");
    expect(resolveSyntaxLang("dotenv")).toBe("env");
    expect(resolveSyntaxLang("envfile")).toBe("env");
    expect(getTokenizer("env")).toBe(tokenizeEnv);
  });
});

describe("tokenizeEnv losslessness", () => {
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
    "=",
    "=\n",
    "export",
    "export FOO",
    "export FOO=1",
    "FOO=bar",
    "FOO = bar",
    "FOO=",
    "FOO= ",
    "FOO= # c\n",
    "FOO=a # c\n",
    "FOO=a#c\n",
    "FOO='x'\n",
    'FOO="say \\"hi\\""\n',
    'FOO="oops\n',
    "🚀 emoji ünïcøde 漢字",
    "export FOO=1 # ok\nBAR=2\n",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeEnv(input);
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
      "#c\n",
      "=",
      "export",
      "FOO",
      "FOO=",
      "FOO = ",
      "bar",
      '"',
      "'",
      '"str"',
      "'str'",
      '"unterminated',
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
      const runs = tokenizeEnv(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("env tokenizer wiring", () => {
  it("getTokenizer resolves env to tokenizeEnv and classifies a sample", () => {
    const doc = [
      "# runtime",
      "export FOO=1 # one",
      "BAR='two # three'",
      "BAZ=#glued",
    ].join("\n");
    const runs = getTokenizer("env")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual(["# runtime", "# one"]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual(["export"]);
    expect(runs.filter((r) => r.type === "key").map((r) => r.text)).toEqual(["FOO", "BAR", "BAZ"]);
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual(["1", "'two # three'", "#glued"]);
  });
});
