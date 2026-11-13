// Unit tests for the CSS tokenizer (src/utils/syntax/css.ts): typed runs
// with exact classes and spans over targeted fixtures (statement peek:
// selector versus declaration), line-wise behavior for the file view, a
// losslessness sweep over a nasty fixture corpus plus a deterministic
// fragment generator, and the registry wiring pin.

import { describe, it, expect } from "bun:test";
import { getTokenizer, type SyntaxRun } from "@utils/syntax/index.ts";
import { tokenizeCss } from "@utils/syntax/css.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

/** The tokenizer's declared class vocabulary (every run must live here). */
const TYPES = new Set([
  "atrule",
  "selector",
  "property",
  "value",
  "number",
  "color",
  "variable",
  "string",
  "comment",
  "operator",
  "default",
]);

/** Drop the whitespace/newline passthrough to assert the interesting runs. */
const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeCss rules and declarations", () => {
  it("classifies a whole rule", () => {
    expect(significant(tokenizeCss(".btn { color: red; z-index: -2 }"))).toEqual([
      run("selector", ".btn"),
      run("operator", "{"),
      run("property", "color"),
      run("operator", ":"),
      run("value", "red"),
      run("operator", ";"),
      run("property", "z-index"),
      run("operator", ":"),
      run("number", "-2"),
      run("operator", "}"),
    ]);
  });

  it("keeps combinators and pseudo-classes in the selector", () => {
    const runs = significant(tokenizeCss("main > a:hover, #nav li + li { display: none }"));
    expect(runs.filter((r) => r.type === "selector").map((r) => r.text)).toEqual([
      "main",
      ">",
      "a:hover",
      "#nav",
      "li",
      "+",
      "li",
    ]);
  });

  it("reads attribute selectors (quoted and with brackets) as one selector", () => {
    const runs = significant(tokenizeCss('input[type="a;b"] { border: 0 }'));
    expect(runs[0]).toEqual(run("selector", 'input[type="a;b"]'));
  });

  it("classifies units, percents and hex colors in values", () => {
    expect(significant(tokenizeCss("div { margin: 1.5rem auto; width: 100%; color: #a1b2c3 }"))).toEqual([
      run("selector", "div"),
      run("operator", "{"),
      run("property", "margin"),
      run("operator", ":"),
      run("number", "1.5rem"),
      run("value", "auto"),
      run("operator", ";"),
      run("property", "width"),
      run("operator", ":"),
      run("number", "100%"),
      run("operator", ";"),
      run("property", "color"),
      run("operator", ":"),
      run("color", "#a1b2c3"),
      run("operator", "}"),
    ]);
  });

  it("keeps # as an id selector outside declarations", () => {
    const runs = significant(tokenizeCss("#main { --brand: #0a0 }"));
    expect(runs).toEqual([
      run("selector", "#main"),
      run("operator", "{"),
      run("variable", "--brand"),
      run("operator", ":"),
      run("color", "#0a0"),
      run("operator", "}"),
    ]);
  });

  it("classifies functions, nested parens and vars as value material", () => {
    const runs = significant(tokenizeCss("div { color: var(--accent); background: url(data:image/png;base64,xx) no-repeat }"));
    expect(runs.filter((r) => r.type === "variable").map((r) => r.text)).toEqual(["--accent"]);
    expect(runs.filter((r) => r.type === "value").map((r) => r.text)).toEqual([
      "var",
      "url",
      "data:image/png;base64,xx",
      "no-repeat",
    ]);
  });

  it("keeps `!important` as operator plus keyword", () => {
    expect(significant(tokenizeCss("p { color: red !important; }"))).toContainEqual(run("operator", "!"));
  });
});

describe("tokenizeCss at-rules, comments and strings", () => {
  it("classifies at-rule names and nests media bodies", () => {
    const runs = significant(tokenizeCss("@media (min-width: 600px) { .a { color: red } }"));
    expect(runs[0]).toEqual(run("atrule", "@media"));
    expect(runs.filter((r) => r.type === "property").map((r) => r.text)).toEqual(["color"]);
  });

  it("reads keyframe names and selectors as selectors", () => {
    const runs = significant(tokenizeCss("@keyframes fade { from { opacity: 0 } 50% { opacity: .5 } }"));
    expect(runs.filter((r) => r.type === "selector").map((r) => r.text)).toEqual(["fade", "from", "50%"]);
    expect(runs.filter((r) => r.type === "property").map((r) => r.text)).toEqual(["opacity", "opacity"]);
  });

  it("classifies block and line comments", () => {
    expect(significant(tokenizeCss("/* a */ x { y: z } // scss-ish\n"))).toEqual([
      run("comment", "/* a */"),
      run("selector", "x"),
      run("operator", "{"),
      run("property", "y"),
      run("operator", ":"),
      run("value", "z"),
      run("operator", "}"),
      run("comment", "// scss-ish"),
    ]);
  });

  it("never lets braces inside comments or strings skew the statement peek", () => {
    const runs = significant(tokenizeCss('a { content: "}{"; /* { */ color: red }'));
    expect(runs.filter((r) => r.type === "property").map((r) => r.text)).toEqual(["content", "color"]);
    expect(runs).toContainEqual(run("string", '"}{"'));
  });

  it("stops an unterminated string at the newline but runs a comment to EOF", () => {
    expect(tokenizeCss('a { content: "x\n}')).toEqual([
      run("selector", "a"),
      run("default", " "),
      run("operator", "{"),
      run("default", " "),
      run("property", "content"),
      run("operator", ":"),
      run("default", " "),
      run("string", '"x'),
      run("default", "\n"),
      run("operator", "}"),
    ]);
    expect(significant(tokenizeCss("/* nope"))).toEqual([run("comment", "/* nope")]);
  });
});

describe("tokenizeCss line-wise (the file view tokenizes per line)", () => {
  it("classifies declaration and selector lines independently", () => {
    expect(significant(tokenizeCss("  color: red;"))).toEqual([
      run("property", "color"),
      run("operator", ":"),
      run("value", "red"),
      run("operator", ";"),
    ]);
    expect(significant(tokenizeCss(".a:hover {"))).toEqual([
      run("selector", ".a:hover"),
      run("operator", "{"),
    ]);
    expect(significant(tokenizeCss("}"))).toEqual([run("operator", "}")]);
  });
});

describe("tokenizeCss losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "{}",
    ";",
    "}{].@",
    "a{}",
    "a{};}.]",
    "@",
    "@media",
    "@media{",
    "a/b { }",
    ".a, .b { }",
    "/*",
    "//",
    "/**/",
    "/*/",
    "/x /* y // z */ w",
    'content: "a;b" "c{d"',
    "content: 'x",
    "url(a(b(c))) { }",
    "[data-x]{y:z}",
    ":not(.a, .b) { m: n(1px, calc(2px + 3px)) }",
    "--custom: { --inner: x }",
    "#fff #f #gg { c: # }",
    "1.5rem -2px .5% 1e3 1.2.3 .",
    "kéy: 値\n.rocket-🚀 { c: red }",
    "c: " + "v".repeat(50000),
    "\r\n.a{\r\nb:c;\r\n}\r\n",
    "lone\rcr { x: y }",
    "@import \"x.css\";",
    "@charset \"utf-8\";@media(min-width:1px){a{b:c}}",
    "!important !",
    "a:hover{",
    "a { b: c d",
    "%host { p: q }",
    "&::before { c: #000 }",
    "div{color:red}div{color:blue}",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeCss(input);
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
      ";",
      ":",
      ",",
      "(",
      ")",
      "[",
      "]",
      " ",
      "  ",
      "\n",
      "\t",
      ".cls",
      "#id",
      "@media",
      "--v",
      "prop",
      "1px",
      "#fff",
      '"s"',
      "'q",
      "/*",
      "//",
      "*/",
      "&",
      ">",
      "+",
      "~",
      "*",
      "!",
      "\\",
      "🚀",
      "url(",
      "calc(",
      "\r\n",
      "\n\n",
    ];
    let seed = 5;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeCss(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("css tokenizer wiring", () => {
  it("getTokenizer resolves css to tokenizeCss and colors a styles sample", () => {
    expect(getTokenizer("css")).toBe(tokenizeCss);
    const sheet = [
      "/* header */",
      ".tok-key { color: var(--accent); }",
      "@media (min-width: 600px) { .wide { margin: 0 auto } }",
    ].join("\n");
    const runs = getTokenizer("css")!(sheet);
    expect(runs.map((r) => r.text).join("")).toBe(sheet); // the registry contract, held
    expect(significant(runs)).toContainEqual(run("comment", "/* header */"));
    expect(runs.filter((r) => r.type === "property").map((r) => r.text)).toEqual(["color", "margin"]);
    expect(runs.filter((r) => r.type === "variable").map((r) => r.text)).toEqual(["--accent"]);
  });
});
