// Unit tests for the SCSS tokenizer (src/utils/syntax/scss.ts): the css.ts
// scan (statement peek, both comment spellings, --custom-props, #hex vs
// #id, the GENERIC atrule arm -- every Sass at-rule rides it, so there is
// no keyword list to extend, pinned) plus the three scss deltas: `$name`
// variables (the php variable class; `$_private`/`$-x` led, a lone `$`
// still one run, a variable DEFINITION loses the property reading), `#{...}`
// interpolation RIDING the run unparsed (the rust ruling: bytes inside
// strings -- a quote inside a hole closes the literal, the documented
// cost; swallowed whole inside selector runs and the value `#` arm; the
// statement peek skips holes so `$x: #{$y};` is a declaration), and nothing
// else -- `%placeholder` selectors ride the peek, flags (`!default`,
// `!global`, `!optional`, `!important`) are the `!` single plus a value
// word, and `@extend %foo !optional;` degrades honestly (peek sees `;`
// first: default `%` plus a value word). No fn, no keyword, no type class
// (the css family). Plus losslessness and registry pins (.scss claimed,
// .sass honestly UNCLAIMED, no aliases/basenames).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeScss } from "@utils/syntax/scss.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

// The css.ts family palette plus the `variable` lift: no keyword, no fn,
// no type, no preproc (scss knows none).
const TYPES = new Set([
  "comment",
  "string",
  "selector",
  "atrule",
  "property",
  "value",
  "variable",
  "color",
  "number",
  "operator",
  "default",
]);

const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeScss structure", () => {
  it("mixin and include: the generic atrule arm, NO mixin-name reading", () => {
    expect(significant(tokenizeScss("@mixin button-base($h: 40px) { height: $h; }"))).toEqual([
      run("atrule", "@mixin"), // ANY @name rides (css.ts arms the shape, not a list)
      run("selector", "button-base($h: 40px)"), // the prelude reads like @media's does
      run("operator", "{"),
      run("property", "height"),
      run("operator", ":"),
      run("variable", "$h"),
      run("operator", ";"),
      run("operator", "}"),
    ]);
    expect(significant(tokenizeScss("@include ripple-surface;"))).toEqual([
      run("atrule", "@include"),
      run("value", "ripple-surface"), // peek sees the `;` first: value material, pinned
      run("operator", ";"),
    ]);
    expect(significant(tokenizeScss("@use 'sass:math' as *;"))).toEqual([
      run("atrule", "@use"),
      run("string", "'sass:math'"),
      run("value", "as"),
      run("default", "*"), // `*` arms nothing: a plain byte (the css family)
      run("operator", ";"),
    ]);
    // @if/@each/@for prelude words ride selector context exactly like
    // @media's does -- one selector run per word (the parent's behavior).
    expect(significant(tokenizeScss("@each $k, $v in $map {"))).toEqual([
      run("atrule", "@each"),
      run("selector", "$k"),
      run("operator", ","),
      run("selector", "$v"),
      run("selector", "in"),
      run("selector", "$map"),
      run("operator", "{"),
    ]);
  });

  it("$variables: the family php class, dashed and underscored and private", () => {
    expect(significant(tokenizeScss("$base-color: #c6538c;"))).toEqual([
      run("variable", "$base-color"), // a definition LOSES the property reading (pinned)
      run("operator", ":"),
      run("color", "#c6538c"),
      run("operator", ";"),
    ]);
    expect(significant(tokenizeScss("border: 1px solid $border-dark;"))).toEqual([
      run("property", "border"),
      run("operator", ":"),
      run("number", "1px"),
      run("value", "solid"),
      run("variable", "$border-dark"),
      run("operator", ";"),
    ]);
    expect(significant(tokenizeScss("$_private: 1;\n$-x: 2;"))).toEqual([
      run("variable", "$_private"), // `_`-led (the underscore/hyphen equivalence is the language's)
      run("operator", ":"),
      run("number", "1"),
      run("operator", ";"),
      run("variable", "$-x"), // `-`-led
      run("operator", ":"),
      run("number", "2"),
      run("operator", ";"),
    ]);
    expect(significant(tokenizeScss("$"))).toEqual([run("variable", "$")]); // a lone `$` is still one run
    expect(significant(tokenizeScss("border: rgba($base-color, 0.88);"))).toEqual([
      run("property", "border"),
      run("operator", ":"),
      run("value", "rgba"),
      run("operator", "("),
      run("variable", "$base-color"), // the group scan lifts $-vars too
      run("value", ","), // the group value run carries the comma (css.ts behavior)
      run("number", "0.88"),
      run("operator", ")"),
      run("operator", ";"),
    ]);
  });

  it("#{...} interpolation rides the run, unparsed (the rust ruling)", () => {
    expect(significant(tokenizeScss('a: "#{$x} px";'))).toEqual([
      run("property", "a"),
      run("operator", ":"),
      run("string", '"#{$x} px"'), // inside strings: plain bytes
      run("operator", ";"),
    ]);
    // The documented cost: a quote inside a hole closes the literal.
    expect(significant(tokenizeScss('a: "#{"i"}x";'))).toEqual([
      run("property", "a"),
      run("operator", ":"),
      run("string", '"#{"'), // the quote inside the hole CLOSES the literal, quote included
      run("value", "i"),
      run("string", '"}x"'),
      run("operator", ";"),
    ]);
    // Value position outside a string: the hole is swallowed to its
    // matching `}` and rides ONE value run.
    expect(significant(tokenizeScss("$x: #{$y};"))).toEqual([
      run("variable", "$x"), // the peek SKIPS the hole: this is a declaration
      run("operator", ":"),
      run("value", "#{$y}"),
      run("operator", ";"),
    ]);
    // Selector position: the hole rides the selector run.
    expect(significant(tokenizeScss("#{$ns}widget:hover { color: red; }"))).toEqual([
      run("selector", "#{$ns}widget:hover"), // ONE run through the hole
      run("operator", "{"),
      run("property", "color"),
      run("operator", ":"),
      run("value", "red"),
      run("operator", ";"),
      run("operator", "}"),
    ]);
  });

  it("flags: `!` is the parent's single and the flag word rides value", () => {
    expect(significant(tokenizeScss("$black: #000 !default;"))).toEqual([
      run("variable", "$black"),
      run("operator", ":"),
      run("color", "#000"),
      run("operator", "!"),
      run("value", "default"),
      run("operator", ";"),
    ]);
    expect(significant(tokenizeScss("color: red !important;"))).toEqual([
      run("property", "color"),
      run("operator", ":"),
      run("value", "red"),
      run("operator", "!"),
      run("value", "important"),
      run("operator", ";"),
    ]);
  });

  it("%placeholder selectors ride the peek; @extend degrades honestly", () => {
    expect(significant(tokenizeScss("%alert { color: red; }"))).toEqual([
      run("selector", "%alert"), // the peek sees `{` first: a selector statement
      run("operator", "{"),
      run("property", "color"),
      run("operator", ":"),
      run("value", "red"),
      run("operator", ";"),
      run("operator", "}"),
    ]);
    // Scanner reality: `@extend %foo !optional;` ends at `;`, so it is NOT
    // a selector statement -- `%` is a plain byte and `foo` a value word.
    expect(significant(tokenizeScss("@extend %alert !optional;"))).toEqual([
      run("atrule", "@extend"),
      run("default", "%"),
      run("value", "alert"),
      run("operator", "!"),
      run("value", "optional"),
      run("operator", ";"),
    ]);
  });

  it("nested & and the css parent's shapes survive", () => {
    expect(significant(tokenizeScss("&:hover { cursor: pointer; }"))).toEqual([
      run("selector", "&:hover"),
      run("operator", "{"),
      run("property", "cursor"),
      run("operator", ":"),
      run("value", "pointer"),
      run("operator", ";"),
      run("operator", "}"),
    ]);
    // Dynamic custom properties degrade: `--` is the css variable arm's
    // run and the hole reads separately (pinned scanner reality).
    expect(significant(tokenizeScss("--#{$k}: 1;"))).toEqual([
      run("variable", "--"),
      run("value", "#{$k}"),
      run("operator", ":"),
      run("number", "1"),
      run("operator", ";"),
    ]);
  });

  it("comments: both spellings, the block NEVER nested (the css family)", () => {
    expect(significant(tokenizeScss("// line\n/* block */ .a { }"))).toEqual([
      run("comment", "// line"),
      run("comment", "/* block */"),
      run("selector", ".a"),
      run("operator", "{"),
      run("operator", "}"),
    ]);
    expect(significant(tokenizeScss("/* a /* b */ c */"))).toEqual([
      run("comment", "/* a /* b */"), // NEVER nested: the first closer ends it...
      run("value", "c"),
      run("default", "*"), // ...and the tail re-reads as bytes
      run("default", "/"),
    ]);
  });
});

describe("tokenizeScss line-wise degradation (the file view tokenizes per line)", () => {
  it("an unterminated string stops at the newline; the next line re-reads", () => {
    expect(tokenizeScss('a: "abc\nb: 2;')).toEqual([
      run("property", "a"),
      run("operator", ":"),
      run("default", " "),
      run("string", '"abc'),
      run("default", "\n"),
      run("property", "b"),
      run("operator", ":"),
      run("default", " "),
      run("number", "2"),
      run("operator", ";"),
    ]);
  });

  it("a block comment reaches its closer across newlines; unclosed runs on", () => {
    // Scanner reality (the css.ts indexOf shape): block comments are NOT
    // line-bounded; the first closer ends them wherever it lives.
    expect(tokenizeScss("x /* open\ny */ 1")).toEqual([
      run("value", "x"),
      run("default", " "),
      run("comment", "/* open\ny */"),
      run("default", " "),
      run("number", "1"),
    ]);
    expect(tokenizeScss("a /* open")).toEqual([
      run("value", "a"),
      run("default", " "),
      run("comment", "/* open"), // no closer here: end of the given input
    ]);
  });

  it("an unterminated interpolation hole runs to the end of the input", () => {
    expect(significant(tokenizeScss("a: #{$x;"))).toEqual([
      run("property", "a"),
      run("operator", ":"),
      run("value", "#{$x;"), // the hole swallow takes the whole remainder
    ]);
  });
});

describe("tokenizeScss registry contract", () => {
  it("guesses and fences resolve through the registry", () => {
    expect(guessLangForBase("main.scss")).toBe("scss");
    expect(guessLangForBase("_variables.scss")).toBe("scss"); // partials land via the extension
    expect(guessLangForBase("MAIN.SCSS")).toBe("scss"); // extensions are case-insensitive
    expect(guessLangForBase("index.sass")).toBeUndefined(); // the indented syntax: honestly unclaimed
    expect(guessLangForBase("file.scssx")).toBeUndefined();
    expect(guessLangForBase("scss")).toBeUndefined(); // dotless stem
    expect(resolveSyntaxLang("scss")).toBe("scss");
    expect(resolveSyntaxLang("SCSS")).toBeUndefined(); // the canonical name resolves exactly
    expect(resolveSyntaxLang("sass")).toBeUndefined(); // not a registered lang at all
    expect(resolveSyntaxLang("scssx")).toBeUndefined(); // a made-up fence word
    expect(getTokenizer("scss")).toBe(tokenizeScss);
  });
});

describe("tokenizeScss losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\n",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "a".repeat(50000),
    "$",
    "$x",
    "#",
    "#{",
    "#{}",
    "#{$",
    "#{$x",
    "#{'}",
    "%",
    "!default",
    "@",
    "@media",
    "&",
    "--",
    "--x",
    "{",
    "}",
    ";",
    ":",
    ",",
    "(",
    ")",
    '"unterm',
    "'unterm",
    "/*",
    "*/",
    "//",
    "/* a /* b */ c */",
    "#abc",
    "#12",
    "1.5rem",
    "-1px",
    ".5",
    "a\u00a0b", // NBSP is not the isWs family: the high unicode rides words/bytes
    "rocket emoji ünïcøde 漢字",
    "#{'#'}",
    "#{{}}",
    "url(#frag)",
    "[class$='x']",
    "@use 'sass:math' as *;",
    "\u{1F680}$x",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeScss(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "$",
      "#{",
      "}",
      '"',
      "\n",
      "/*",
      "*/",
      "//",
      "@mixin ",
      "%p{",
      "!",
      "&",
      "{",
      ";",
      ",",
      "(",
      ")",
      "--",
      "1.5em",
      "#abc",
      "url(",
      "'",
      "\u{1F680}",
      "$x:",
      "#{$y}",
      " ",
      "\r\n",
      "@",
      "\\",
      ":",
      "a",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeScss(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("scss tokenizer wiring", () => {
  it("getTokenizer resolves scss to tokenizeScss and classes a real partial", () => {
    const code = [
      "// _button.scss -- the button system.",
      "@use 'sass:math';",
      "",
      "$button-height: 40px !default;",
      "$spacing: (sm: 4px, lg: 16px);",
      "",
      "@mixin button-base($h: $button-height) {",
      "  height: $h;",
      "  padding: math.div($h, 4);",
      "",
      "  &:hover {",
      "    cursor: pointer;",
      "  }",
      "}",
      "",
      "%visually-hidden {",
      "  border: 0;",
      "}",
      "",
      ".btn {",
      "  @include button-base;",
      "  background: #22863a;",
      "  min-height: #{$button-height + 4};",
      '  font-family: "Segoe UI", sans-serif;',
      "}",
    ].join("\n");
    const runs = getTokenizer("scss")!(code);
    expect(runs.map((r) => r.text).join("")).toBe(code); // the registry contract, held
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual([
      "// _button.scss -- the button system.",
    ]);
    expect(runs.filter((r) => r.type === "atrule").map((r) => r.text)).toEqual([
      "@use",
      "@mixin",
      "@include",
    ]);
    expect(runs.filter((r) => r.type === "variable").map((r) => r.text)).toEqual([
      "$button-height",
      "$spacing",
      "$h", // the parameter
      "$h", // the use
    ]);
    expect(runs.filter((r) => r.type === "selector").map((r) => r.text)).toEqual([
      "button-base($h: $button-height)", // the mixin header prelude
      "&:hover",
      "%visually-hidden", // the placeholder selector
      ".btn",
    ]);
    expect(runs.filter((r) => r.type === "property").map((r) => r.text)).toEqual([
      "height",
      "padding",
      "cursor",
      "border",
      "background",
      "min-height",
      "font-family",
    ]);
    expect(runs.filter((r) => r.type === "color").map((r) => r.text)).toEqual(["#22863a"]);
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual([
      "'sass:math'",
      '"Segoe UI"',
    ]);
    // The interpolation rides one value run; the map parens read as value
    // material (sm:/lg: ride value chunks, the group scan's behavior).
    expect(runs.filter((r) => r.type === "value").map((r) => r.text)).toEqual([
      "default",
      "sm:",
      ",",
      "lg:",
      "math",
      "div",
      ",",
      "pointer",
      "button-base", // @include's name is value material (no fn class in css-land)
      "#{$button-height + 4}",
      "sans-serif",
    ]);
    // No fn and no keyword classes exist in the css family:
    expect(runs.filter((r) => r.type === "fn")).toEqual([]);
    expect(runs.filter((r) => r.type === "keyword")).toEqual([]);
  });
});
