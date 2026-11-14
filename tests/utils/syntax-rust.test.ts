// Unit tests for the Rust tokenizer (src/utils/syntax/rust.ts): typed runs
// with exact classes and spans over targeted fixtures (fn/type/keyword
// readings, the quote zoo and lifetimes, nested block comments, attributes,
// macros, ranges and suffixed numbers), a losslessness sweep over a nasty
// fixture corpus plus a deterministic fragment generator, and the registry
// wiring pins (.rs now resolves through the registry, not guess-only).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeRust } from "@utils/syntax/rust.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

const TYPES = new Set([
  "comment",
  "string",
  "number",
  "boolean",
  "keyword",
  "type",
  "fn",
  "operator",
  "decorator",
  "variable",
  "default",
]);

const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeRust structure", () => {
  it("generic fn signatures, lifetimes, and return types read cleanly", () => {
    expect(significant(tokenizeRust("fn parse<'a>(input: &'a str) -> Option<&'a str> { None }"))).toEqual([
      run("keyword", "fn"),
      run("fn", "parse"),
      run("operator", "<"),
      run("variable", "'a"),
      run("operator", ">"),
      run("operator", "("),
      run("default", "input"),
      run("operator", ":"),
      run("operator", "&"),
      run("variable", "'a"),
      run("type", "str"),
      run("operator", ")"),
      run("operator", "->"),
      run("type", "Option"),
      run("operator", "<"),
      run("operator", "&"),
      run("variable", "'a"),
      run("type", "str"),
      run("operator", ">"),
      run("operator", "{"),
      run("type", "None"),
      run("operator", "}"),
    ]);
  });

  it("attributes, struct names, and primitives classify", () => {
    expect(significant(tokenizeRust("#[derive(Debug, Clone)]\npub struct Point { x: f64, y: f64 }"))).toEqual([
      run("decorator", "#[derive(Debug, Clone)]"),
      run("keyword", "pub"),
      run("keyword", "struct"),
      run("type", "Point"),
      run("operator", "{"),
      run("default", "x"),
      run("operator", ":"),
      run("type", "f64"),
      run("operator", ","),
      run("default", "y"),
      run("operator", ":"),
      run("type", "f64"),
      run("operator", "}"),
    ]);
  });

  it("macro invocations ride fn, bodies stay ordinary code, != stays comparison", () => {
    expect(significant(tokenizeRust('println!("hi {}", name); let xs = vec![1, 2]; while i != n {}'))).toEqual([
      run("fn", "println!"),
      run("operator", "("),
      run("string", '"hi {}"'),
      run("operator", ","),
      run("default", "name"),
      run("operator", ")"),
      run("operator", ";"),
      run("keyword", "let"),
      run("default", "xs"),
      run("operator", "="),
      run("fn", "vec!"),
      run("operator", "["),
      run("number", "1"),
      run("operator", ","),
      run("number", "2"),
      run("operator", "]"),
      run("operator", ";"),
      run("keyword", "while"),
      run("default", "i"),
      run("operator", "!="),
      run("default", "n"),
      run("operator", "{"),
      run("operator", "}"),
    ]);
  });

  it("line comments swallow everything and block comments nest", () => {
    expect(significant(tokenizeRust("// line // not nested /* outer /* inner */ still */ after"))).toEqual([
      run("comment", "// line // not nested /* outer /* inner */ still */ after"),
    ]);
    expect(significant(tokenizeRust("/* a /* b */ c */ let x = 1;"))).toEqual([
      run("comment", "/* a /* b */ c */"),
      run("keyword", "let"),
      run("default", "x"),
      run("operator", "="),
      run("number", "1"),
      run("operator", ";"),
    ]);
  });

  it("the quote zoo: raw, hash-raw, byte, escapes, and chars vs lifetimes", () => {
    expect(
      significant(tokenizeRust('r"raw" + r#"say "hi" "# + br"b" + b"esc\\"x" + String::from("ok")')),
    ).toEqual([
      run("string", 'r"raw"'),
      run("operator", "+"),
      run("string", 'r#"say "hi" "#'),
      run("operator", "+"),
      run("string", 'br"b"'),
      run("operator", "+"),
      run("string", 'b"esc\\"x"'),
      run("operator", "+"),
      run("type", "String"),
      run("operator", "::"),
      run("fn", "from"),
      run("operator", "("),
      run("string", '"ok"'),
      run("operator", ")"),
    ]);
    expect(significant(tokenizeRust("let c = 'a'; let q = '\\''; let u = '\\u{1F600}'; let l = 'static;"))).toEqual([
      run("keyword", "let"),
      run("default", "c"),
      run("operator", "="),
      run("string", "'a'"),
      run("operator", ";"),
      run("keyword", "let"),
      run("default", "q"),
      run("operator", "="),
      run("string", "'\\''"),
      run("operator", ";"),
      run("keyword", "let"),
      run("default", "u"),
      run("operator", "="),
      run("string", "'\\u{1F600}'"),
      run("operator", ";"),
      run("keyword", "let"),
      run("default", "l"),
      run("operator", "="),
      run("variable", "'static"),
      run("operator", ";"),
    ]);
  });

  it("numbers: separators, radix, exponent, suffixes; ranges keep their dots; half-literals distrust", () => {
    expect(
      significant(tokenizeRust("for i in 0..=9 { s = 1..2; } let g = 1_000 + 0xFF_FF + 6.02e23 + 42u64 + 1.5f32; let bad = 0x + 1_;")),
    ).toEqual([
      run("keyword", "for"),
      run("default", "i"),
      run("keyword", "in"),
      run("number", "0"),
      run("operator", "..="),
      run("number", "9"),
      run("operator", "{"),
      run("default", "s"),
      run("operator", "="),
      run("number", "1"),
      run("operator", ".."),
      run("number", "2"),
      run("operator", ";"),
      run("operator", "}"),
      run("keyword", "let"),
      run("default", "g"),
      run("operator", "="),
      run("number", "1_000"),
      run("operator", "+"),
      run("number", "0xFF_FF"),
      run("operator", "+"),
      run("number", "6.02e23"),
      run("operator", "+"),
      run("number", "42u64"),
      run("operator", "+"),
      run("number", "1.5f32"),
      run("operator", ";"),
      run("keyword", "let"),
      run("default", "bad"),
      run("operator", "="),
      run("default", "0x"),
      run("operator", "+"),
      run("default", "1_"),
      run("operator", ";"),
    ]);
  });

  it("member dots refuse type/keyword readings, calls still peek, and .await keeps the keyword", () => {
    expect(
      significant(tokenizeRust("impl Widget for Foo { fn draw(&self) -> Self { self.inner.await } let n = x.field; x.len(); }")),
    ).toEqual([
      run("keyword", "impl"),
      run("type", "Widget"),
      run("keyword", "for"),
      run("type", "Foo"),
      run("operator", "{"),
      run("keyword", "fn"),
      run("fn", "draw"),
      run("operator", "("),
      run("operator", "&"),
      run("keyword", "self"),
      run("operator", ")"),
      run("operator", "->"),
      run("keyword", "Self"),
      run("operator", "{"),
      run("keyword", "self"),
      run("operator", "."),
      run("default", "inner"),
      run("operator", "."),
      run("keyword", "await"),
      run("operator", "}"),
      run("keyword", "let"),
      run("default", "n"),
      run("operator", "="),
      run("default", "x"),
      run("operator", "."),
      run("default", "field"),
      run("operator", ";"),
      run("default", "x"),
      run("operator", "."),
      run("fn", "len"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("operator", "}"),
    ]);
  });
});

describe("tokenizeRust registry contract", () => {
  it("guesses and fences resolve through the registry (rust is no longer guess-only)", () => {
    expect(guessLangForBase("main.rs")).toBe("rust");
    expect(guessLangForBase("lib.RS")).toBe("rust");
    expect(resolveSyntaxLang("rust")).toBe("rust");
    expect(getTokenizer("rust")).toBe(tokenizeRust);
  });
});

describe("tokenizeRust losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\n",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "a".repeat(50000),
    "//",
    "/*",
    "*/",
    "/* /* */",
    "///",
    "#",
    "#[",
    "#![",
    "#[]",
    "]#",
    '"',
    '"unterminated',
    "\\",
    "'",
    "''",
    "'a'",
    "'a",
    "r",
    "r#",
    "r##",
    'r"',
    'r#"',
    'r##"no closer',
    'b"',
    "br#",
    "'\\",
    "'\\u{",
    "0x",
    "0b",
    "0o",
    "1_",
    "1.",
    "1..",
    "..=",
    "1e",
    "1e+",
    "42usize!",
    "=>",
    "::",
    "&&",
    "t.0",
    "x.0.1",
    "r#try",
    "!",
    "!=x",
    "🚀 emoji ünïcøde 漢字",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeRust(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "//",
      "/*",
      "*/",
      "//x\n",
      '"',
      "'",
      "\\",
      "'a'",
      "'a",
      "r#",
      "r##",
      'r"',
      '"#',
      "b\"",
      "br",
      "#[",
      "#![",
      "]",
      "fn",
      "let",
      "true",
      "await",
      "Self",
      "1",
      "0x",
      "1_",
      "1_2",
      "..",
      "..=",
      "::",
      "->",
      "=>",
      "!=",
      "!",
      "(",
      ")",
      "{",
      "}",
      "<",
      ">",
      "x.y",
      ".0",
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
      const runs = tokenizeRust(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("rust tokenizer wiring", () => {
  it("getTokenizer resolves rust to tokenizeRust and classifies a sample", () => {
    const doc = [
      "//! Module docs",
      "use std::fmt;",
      "",
      "/// Prints a greeting.",
      "#[derive(Debug)]",
      "pub fn greet(name: &str) -> String {",
      '    format!("hi {name}")',
      "}",
    ].join("\n");
    const runs = getTokenizer("rust")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual([
      "//! Module docs",
      "/// Prints a greeting.",
    ]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual(["use", "pub", "fn"]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual(["greet", "format!"]);
    expect(runs.filter((r) => r.type === "decorator").map((r) => r.text)).toEqual(["#[derive(Debug)]"]);
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual(['"hi {name}"']);
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual(["str", "String"]);
  });
});
