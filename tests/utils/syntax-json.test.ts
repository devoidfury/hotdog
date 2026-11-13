// Unit tests for the JSON tokenizer (src/utils/syntax/json.ts): typed runs
// with exact classes and spans over targeted fixtures (JSONC dialect
// included), a losslessness sweep over a nasty fixture corpus plus a
// deterministic fragment generator, and the registry wiring pins.

import { describe, it, expect } from "bun:test";
import { getTokenizer, type SyntaxRun } from "@utils/syntax/index.ts";
import { tokenizeJson } from "@utils/syntax/json.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

/** The tokenizer's declared class vocabulary (every run must live here). */
const TYPES = new Set(["key", "string", "number", "boolean", "null", "comment", "operator", "default"]);

/** Drop the whitespace passthrough to assert the interesting runs. */
const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeJson values", () => {
  it("classifies a whole document", () => {
    expect(significant(tokenizeJson('{"name": "hotdog", "n": 42, "ok": true, "gone": null}'))).toEqual([
      run("operator", "{"),
      run("key", '"name"'),
      run("operator", ":"),
      run("string", '"hotdog"'),
      run("operator", ","),
      run("key", '"n"'),
      run("operator", ":"),
      run("number", "42"),
      run("operator", ","),
      run("key", '"ok"'),
      run("operator", ":"),
      run("boolean", "true"),
      run("operator", ","),
      run("key", '"gone"'),
      run("operator", ":"),
      run("null", "null"),
      run("operator", "}"),
    ]);
  });

  it("keys only where a colon follows, across newlines", () => {
    expect(significant(tokenizeJson('{\n  "a"\n  : 1,\n  "b"\n}'))).toEqual([
      run("operator", "{"),
      run("key", '"a"'),
      run("operator", ":"),
      run("number", "1"),
      run("operator", ","),
      run("string", '"b"'), // no colon after it: a value, not a key
      run("operator", "}"),
    ]);
  });

  it("honors escapes inside strings", () => {
    expect(significant(tokenizeJson('["a\\"b", "c\\\\", "d\\"] }"]'))).toEqual([
      run("operator", "["),
      run("string", '"a\\"b"'),
      run("operator", ","),
      run("string", '"c\\\\"'),
      run("operator", ","),
      run("string", '"d\\"] }"'),
      run("operator", "]"),
    ]);
  });

  it("classifies well-formed numbers and distrusts lookalikes", () => {
    expect(significant(tokenizeJson("[0, -2, 1.5, 1e3, -1.5e-3, 1.2.3, 01, 1e]"))).toEqual([
      run("operator", "["),
      run("number", "0"),
      run("operator", ","),
      run("number", "-2"),
      run("operator", ","),
      run("number", "1.5"),
      run("operator", ","),
      run("number", "1e3"),
      run("operator", ","),
      run("number", "-1.5e-3"),
      run("operator", ","),
      run("default", "1.2.3"),
      run("operator", ","),
      run("default", "01"), // JSON forbids leading zeros; no number class
      run("operator", ","),
      run("default", "1e"),
      run("operator", "]"),
    ]);
  });
});

describe("tokenizeJson comments (the JSONC dialect)", () => {
  it("runs a line comment to just before the newline", () => {
    expect(tokenizeJson("// note\n{}")).toEqual([
      run("comment", "// note"),
      run("default", "\n"),
      run("operator", "{"),
      run("operator", "}"),
    ]);
  });

  it("runs a block comment through its closer, multi-line included", () => {
    const runs = significant(tokenizeJson("/* a\nb */ { /*c*/ }"));
    expect(runs).toEqual([
      run("comment", "/* a\nb */"),
      run("operator", "{"),
      run("comment", "/*c*/"),
      run("operator", "}"),
    ]);
  });

  it("keeps comment openers inside strings out of the comment class", () => {
    expect(significant(tokenizeJson('["// not", "/* nor */"]'))).toEqual([
      run("operator", "["),
      run("string", '"// not"'),
      run("operator", ","),
      run("string", '"/* nor */"'),
      run("operator", "]"),
    ]);
  });
});

describe("tokenizeJson broken input", () => {
  it("runs an unterminated string to the end of input", () => {
    expect(tokenizeJson('{"k": "abc')).toEqual([
      run("operator", "{"),
      run("key", '"k"'),
      run("operator", ":"),
      run("default", " "),
      run("string", '"abc'),
    ]);
  });

  it("runs an unterminated block comment to the end of input", () => {
    expect(tokenizeJson("/* nope")).toEqual([run("comment", "/* nope")]);
  });

  it("keeps bare words default", () => {
    expect(significant(tokenizeJson("{ key: True }"))).toEqual([
      run("operator", "{"),
      run("default", "key"),
      run("operator", ":"),
      run("default", "True"), // capital T is not the JSON literal
      run("operator", "}"),
    ]);
  });
});

describe("tokenizeJson losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "{}",
    "[]",
    "\r\n{\"a\":1}\r\n",
    '"unterminated',
    '"trail\\',
    '{"k":"v"',
    "//",
    "/",
    "/*",
    "/**/",
    "/*/",
    '{"a": "b // c", "d": "e /* f */ g"}',
    '{"emoji": "🚀 ünïcøde", "tab": "\\t"}',
    "0 00 - + -e 1. .5 1e+999999 0x1F",
    "true tru fals null NULL nul",
    '{"nested": {"deep": [1, [2, [3, {"why": []}]]]}}',
    "}{][,:",
    '{"a":1,}',
    "," + "1,".repeat(5000),
    "k: " + "v".repeat(50000),
    '"multi\nline broken"',
    "\u0000\u001b",
    "/x /* y // z */ w // v",
    "[1,2,3",
    '{"":""}',
    '["":"" ]', // a string key shape inside an array: honest colon peek
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeJson(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "{",
      "}",
      "[",
      "]",
      ",",
      ":",
      '"key"',
      '"str\\"ing"',
      " ",
      "\n",
      "  ",
      "\t",
      "123",
      "-1.5e3",
      "true",
      "false",
      "null",
      "//c\n",
      "/*c*/",
      "/*",
      "//",
      "/",
      '"unterminated',
      "\\",
      "'",
      "🚀",
      "bare",
      "\r\n",
      "\n\n",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeJson(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("json tokenizer wiring", () => {
  it("getTokenizer resolves json to tokenizeJson and colors a defaults.json sample", () => {
    expect(getTokenizer("json")).toBe(tokenizeJson);
    const doc = [
      "{",
      '  // house config dialect',
      '  "logLevel": "error",',
      '  "maxRetries": 5,',
      '  "gate": { "enabled": true, "off": null }',
      "}",
    ].join("\n");
    const runs = getTokenizer("json")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc); // the registry contract, held
    expect(significant(runs)).toContainEqual(run("comment", "// house config dialect"));
    expect(runs.filter((r) => r.type === "key").map((r) => r.text)).toEqual([
      '"logLevel"',
      '"maxRetries"',
      '"gate"',
      '"enabled"',
      '"off"',
    ]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual(["5"]);
  });
});
