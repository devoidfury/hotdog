// Unit tests for the Lua tokenizer (src/utils/syntax/lua.ts): typed runs with
// exact classes and spans over targeted fixtures (keywords, function names,
// member access, long comments/strings, numbers, and punctuation), a
// losslessness sweep over a nasty fixture corpus plus a deterministic fragment
// generator, and the registry wiring pins (extensions and aliases).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeLua } from "@utils/syntax/lua.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

const TYPES = new Set([
  "comment",
  "string",
  "number",
  "boolean",
  "null",
  "keyword",
  "fn",
  "operator",
  "default",
]);

const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeLua structure", () => {
  it("keywords and function names lift cleanly", () => {
    expect(significant(tokenizeLua("local function greet(name) end"))).toEqual([
      run("keyword", "local"),
      run("keyword", "function"),
      run("fn", "greet"),
      run("operator", "("),
      run("default", "name"),
      run("operator", ")"),
      run("keyword", "end"),
    ]);
  });

  it("strings, numbers, booleans, and nil classify", () => {
    expect(significant(tokenizeLua('local x = "hi" .. name, 0x1f, -1.25, true, nil'))).toEqual([
      run("keyword", "local"),
      run("default", "x"),
      run("operator", "="),
      run("string", '"hi"'),
      run("operator", ".."),
      run("default", "name"),
      run("operator", ","),
      run("number", "0x1f"),
      run("operator", ","),
      run("number", "-1.25"),
      run("operator", ","),
      run("boolean", "true"),
      run("operator", ","),
      run("null", "nil"),
    ]);
  });

  it("member method calls are fn, but member fields stay plain words", () => {
    expect(significant(tokenizeLua('obj.method("x")\nlocal y = obj.field'))).toEqual([
      run("default", "obj"),
      run("operator", "."),
      run("fn", "method"),
      run("operator", "("),
      run("string", '"x"'),
      run("operator", ")"),
      run("keyword", "local"),
      run("default", "y"),
      run("operator", "="),
      run("default", "obj"),
      run("operator", "."),
      run("default", "field"),
    ]);
  });

  it("long comments and long strings survive newlines", () => {
    expect(significant(tokenizeLua("--[[ block\ncomment ]]\nlocal s = [[raw\nstring]]"))).toEqual([
      run("comment", "--[[ block\ncomment ]]"),
      run("keyword", "local"),
      run("default", "s"),
      run("operator", "="),
      run("string", "[[raw\nstring]]"),
    ]);
  });

  it("punctuation and varargs read as operators", () => {
    expect(significant(tokenizeLua("f(...)\nlocal a = b == c ~= d <= e >= g"))) .toEqual([
      run("fn", "f"),
      run("operator", "("),
      run("operator", "..."),
      run("operator", ")"),
      run("keyword", "local"),
      run("default", "a"),
      run("operator", "="),
      run("default", "b"),
      run("operator", "=="),
      run("default", "c"),
      run("operator", "~="),
      run("default", "d"),
      run("operator", "<="),
      run("default", "e"),
      run("operator", ">="),
      run("default", "g"),
    ]);
  });
});

describe("tokenizeLua registry contract", () => {
  it("guesses: extensions and aliases resolve", () => {
    expect(guessLangForBase("init.lua")).toBe("lua");
    expect(guessLangForBase("plugin.lua")).toBe("lua");
    expect(resolveSyntaxLang("lua")).toBe("lua");
    expect(getTokenizer("lua")).toBe(tokenizeLua);
  });
});

describe("tokenizeLua losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\n",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "a".repeat(50000),
    "--",
    "--[[",
    "--[==[",
    "[[",
    "[==[",
    "--[==[x",
    "[[x",
    '"',
    "'oops",
    "0x",
    "0x1p",
    "-1.",
    ".5",
    "01",
    "true",
    "nil",
    "...",
    "..",
    "==",
    "~=",
    "<=",
    ">=",
    "f()",
    "obj.method",
    "local t = { [\"k\"] = 1 }",
    "🚀 emoji ünïcøde 漢字",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeLua(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "--",
      "--[[",
      "--]]",
      "[[",
      "[==[",
      "[==]]",
      '"',
      "'",
      '"str"',
      "'str'",
      "local",
      "function",
      "true",
      "false",
      "nil",
      "0x",
      "0x1f",
      "-1",
      ".5",
      "1.25",
      "...",
      "..",
      "==",
      "~=",
      "<=",
      ">=",
      "{",
      "}",
      "(",
      ")",
      "obj.method",
      "f(",
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
      const runs = tokenizeLua(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("lua tokenizer wiring", () => {
  it("getTokenizer resolves lua to tokenizeLua and classifies a sample", () => {
    const doc = [
      "-- plugin",
      "local function greet(name)",
      '  print("hello " .. name)',
      "end",
    ].join("\n");
    const runs = getTokenizer("lua")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual(["-- plugin"]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual(["local", "function", "end"]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual(["greet", "print"]);
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual(['"hello "']);
  });
});
