// Unit tests for the TOML tokenizer (src/utils/syntax/toml.ts): typed runs
// with exact classes and spans over targeted fixtures (headers, dotted keys,
// every scalar shape, multi-line strings), line-wise degradation pins for
// the file view, a losslessness sweep over a nasty fixture corpus plus a
// deterministic fragment generator, and the registry wiring pins.

import { describe, it, expect } from "bun:test";
import { getTokenizer } from "@utils/syntax/index.ts";
import { tokenizeToml } from "@utils/syntax/toml.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

/** The tokenizer's declared class vocabulary (every run must live here). */
const TYPES = new Set(["section", "key", "string", "number", "boolean", "comment", "operator", "default"]);

/** Drop the whitespace/newline passthrough to assert the interesting runs. */
const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeToml structure", () => {
  it("classifies a header, a key/value line and a trailing comment", () => {
    expect(significant(tokenizeToml('[package] # the project\ntitle = "hotdog"'))).toEqual([
      run("section", "[package]"),
      run("comment", "# the project"),
      run("key", "title"),
      run("operator", "="),
      run("string", '"hotdog"'),
    ]);
  });

  it("reads [[array of tables]] headers as one section run", () => {
    expect(tokenizeToml("[[bin]]")).toEqual([run("section", "[[bin]]")]);
    expect(tokenizeToml("[[a.b]]\nx = 1")).toEqual([
      run("section", "[[a.b]]"),
      run("default", "\n"),
      run("key", "x"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("number", "1"),
    ]);
  });

  it("dotted keys ride one run; the peek still needs a separator after the word", () => {
    expect(significant(tokenizeToml("a.b.c = 1\nbare word"))).toEqual([
      run("key", "a.b.c"),
      run("operator", "="),
      run("number", "1"),
      run("default", "bare"), // no separator after it: default, never a key
      run("default", "word"),
    ]);
  });

  it("quoted keys promote through the value reader", () => {
    expect(significant(tokenizeToml('"quoted key" = 1'))).toEqual([
      run("key", '"quoted key"'),
      run("operator", "="),
      run("number", "1"),
    ]);
  });
});

describe("tokenizeToml values", () => {
  it("booleans and the distrusted numeric dialect", () => {
    const runs = significant(tokenizeToml("a = true\nb = 0x1f\nc = 07\nd = 3.14\ne = 1e3\nf = +inf\ng = nan\nh = 1__0"));
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual(["0x1f", "3.14", "1e3", "+inf"]);
    expect(runs.filter((r) => r.type === "boolean").map((r) => r.text)).toEqual(["true"]);
    // 07 (leading zero), nan (unsigned) and 1__0 (doubled underscore) ride
    // default -- the json.ts distrust rule, TOML-flavored.
    expect(runs.filter((r) => r.type === "default").map((r) => r.text)).toEqual(["07", "nan", "1__0"]);
  });

  it("every datetime shape is one scalar run on the number family", () => {
    const runs = significant(
      tokenizeToml("a = 1979-05-27T07:32:00Z\nb = 1979-05-27\nc = 1979-05-27 07:32:00\nd = 07:32:00"),
    );
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual([
      "1979-05-27T07:32:00Z",
      "1979-05-27",
      "1979-05-27 07:32:00", // the space-separated form re-joins into one run
      "07:32:00",
    ]);
  });

  it("basic, literal and multi-line strings", () => {
    expect(significant(tokenizeToml('a = "x\\"y"\nb = \'raw\\n\'\nc = """\nline\n"""tail'))).toEqual([
      run("key", "a"),
      run("operator", "="),
      run("string", '"x\\"y"'),
      run("key", "b"),
      run("operator", "="),
      run("string", "'raw\\n'"),
      run("key", "c"),
      run("operator", "="),
      run("string", '"""\nline\n"""'),
      run("default", "tail"),
    ]);
  });

  it("arrays and inline tables pass through as one default run", () => {
    expect(significant(tokenizeToml("a = [1, 'x', [2]] # c\nb = { k = 1 }"))).toEqual([
      run("key", "a"),
      run("operator", "="),
      run("default", "[1, 'x', [2]]"),
      run("comment", "# c"),
      run("key", "b"),
      run("operator", "="),
      run("default", "{ k = 1 }"),
    ]);
  });

  it("a # glued to a bare value starts the comment there", () => {
    expect(tokenizeToml("x = 1#c")).toEqual([
      run("key", "x"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("number", "1"),
      run("comment", "#c"),
    ]);
  });

  it("comment openers inside strings stay strings", () => {
    expect(significant(tokenizeToml('a = "# not a comment" # b"'))).toEqual([
      run("key", "a"),
      run("operator", "="),
      run("string", '"# not a comment"'),
      run("comment", '# b"'),
    ]);
  });
});

describe("tokenizeToml line-wise degradation (the file view tokenizes per line)", () => {
  it("an unclosed header stops at the line end, never paints the file", () => {
    expect(tokenizeToml("[table\nx = 1")).toEqual([
      run("section", "[table"),
      run("default", "\n"),
      run("key", "x"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("number", "1"),
    ]);
  });

  it("an unterminated multi-line string runs to end of input", () => {
    expect(tokenizeToml('x = """\nopen "forever')).toEqual([
      run("key", "x"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("string", '"""\nopen "forever'),
    ]);
  });

  it("an unterminated single-line string stops at the newline; the next line re-reads", () => {
    expect(tokenizeToml('a = "oops\nb = 1')).toEqual([
      run("key", "a"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("string", '"oops'),
      run("default", "\n"),
      run("key", "b"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("number", "1"),
    ]);
  });

  it("an unterminated array runs to end of input", () => {
    expect(tokenizeToml("a = [1, 2")).toContainEqual(run("default", "[1, 2"));
  });
});

describe("tokenizeToml losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "x".repeat(50000),
    "[",
    "[]",
    "[[",
    "[[]]",
    "[[]]]",
    "]",
    "]",
    "]]",
    '"',
    '""',
    '"""',
    '""""',
    "'''",
    '"trail\\',
    "'trail\\",
    "#",
    "=",
    "= =",
    "a=",
    '"k"=',
    '"k" =',
    "[1",
    "{1",
    "[{a = 1}",
    "'",
    '""',
    "1979-05-27 07:32:00",
    "1979-05-27 99:99:99",
    "🚀 emoji ünïcøde 漢字 = 🚀",
    "a = 1\r\nb = 2\r",
    "# c\r\n[d]\r\n",
    "x = \"\"\"\n\"\" \"\"\" tail",
    "x = '''\n'''",
    "key\nword\nx = 1",
    "0x\n0b2\n0o8\n-inf\n+nan",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeToml(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "[",
      "]",
      "[[",
      "]]",
      "{",
      "}",
      "=",
      ",",
      "#c\n",
      "#",
      "'",
      '"',
      '"str"',
      '"""',
      "'''",
      "\\",
      "1",
      "3.14",
      "0x1f",
      "true",
      "false",
      "1979-05-27",
      "07:32:00",
      " ",
      "\n",
      "\r\n",
      "\t",
      "🚀",
      "key",
      "a.b",
      '"unterminated',
      "x = ",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeToml(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("toml tokenizer wiring", () => {
  it("getTokenizer resolves toml to tokenizeToml and colors a hotdog.toml sample", () => {
    expect(getTokenizer("toml")).toBe(tokenizeToml);
    const doc = [
      "# harness config",
      "[webui]",
      'title = "workbench"',
      "port = 8765 # display",
      "tags = ['a', 'b']",
    ].join("\n");
    const runs = getTokenizer("toml")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc); // the registry contract, held
    expect(runs.filter((r) => r.type === "section").map((r) => r.text)).toEqual(["[webui]"]);
    expect(significant(runs)).toContainEqual(run("comment", "# harness config"));
    expect(significant(runs)).toContainEqual(run("comment", "# display"));
    expect(runs.filter((r) => r.type === "key").map((r) => r.text)).toEqual(["title", "port", "tags"]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual(["8765"]);
  });
});
