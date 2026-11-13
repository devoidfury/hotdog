// Unit tests for the JavaScript tokenizer (src/utils/syntax/javascript.ts):
// typed runs with exact classes and spans over targeted fixtures (the
// regex-vs-division heuristic included), line-wise degradation pins for the
// file view, a losslessness sweep over a nasty fixture corpus plus a
// deterministic fragment generator, and the registry wiring pins.

import { describe, it, expect } from "bun:test";
import { getTokenizer, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeJavaScript } from "@utils/syntax/javascript.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

/** The tokenizer's declared class vocabulary (every run must live here). */
const TYPES = new Set([
  "keyword",
  "fn",
  "string",
  "template",
  "number",
  "boolean",
  "null",
  "comment",
  "decorator",
  "regexp",
  "key",
  "operator",
  "default",
]);

/** Drop the whitespace/newline passthrough to assert the interesting runs. */
const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeJavaScript statements", () => {
  it("classifies a whole program line", () => {
    expect(significant(tokenizeJavaScript('const x = foo(1) + "s"; // note'))).toEqual([
      run("keyword", "const"),
      run("default", "x"),
      run("operator", "="),
      run("fn", "foo"),
      run("operator", "("),
      run("number", "1"),
      run("operator", ")"),
      run("operator", "+"),
      run("string", '"s"'),
      run("operator", ";"),
      run("comment", "// note"),
    ]);
  });

  it("keys need a glued colon, so ternaries stay clean", () => {
    expect(significant(tokenizeJavaScript("const v = { a: 1 }; const t = a ? b : c;"))).toEqual([
      run("keyword", "const"),
      run("default", "v"),
      run("operator", "="),
      run("operator", "{"),
      run("key", "a"),
      run("operator", ":"),
      run("number", "1"),
      run("operator", "}"),
      run("operator", ";"),
      run("keyword", "const"),
      run("default", "t"),
      run("operator", "="),
      run("default", "a"),
      run("operator", "?"),
      run("default", "b"),
      run("operator", ":"),
      run("default", "c"),
      run("operator", ";"),
    ]);
  });

  it("default:/case: keep the keyword class before a colon", () => {
    expect(significant(tokenizeJavaScript("switch (x) { default: break; }"))).toEqual([
      run("keyword", "switch"),
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
      run("operator", "{"),
      run("keyword", "default"),
      run("operator", ":"),
      run("keyword", "break"),
      run("operator", ";"),
      run("operator", "}"),
    ]);
  });

  it("names before ( are fn, including method shorthand and calls", () => {
    expect(significant(tokenizeJavaScript("function f(a) { return obj.map(a); }"))).toEqual([
      run("keyword", "function"),
      run("fn", "f"),
      run("operator", "("),
      run("default", "a"),
      run("operator", ")"),
      run("operator", "{"),
      run("keyword", "return"),
      run("default", "obj"),
      run("operator", "."),
      run("fn", "map"),
      run("operator", "("),
      run("default", "a"),
      run("operator", ")"),
      run("operator", ";"),
      run("operator", "}"),
    ]);
  });

  it("contextual keywords yield to object keys", () => {
    expect(significant(tokenizeJavaScript('const o = { from: "a", as: b, get: 1 };'))).toEqual([
      run("keyword", "const"),
      run("default", "o"),
      run("operator", "="),
      run("operator", "{"),
      run("key", "from"),
      run("operator", ":"),
      run("string", '"a"'),
      run("operator", ","),
      run("key", "as"),
      run("operator", ":"),
      run("default", "b"),
      run("operator", ","),
      run("key", "get"),
      run("operator", ":"),
      run("number", "1"),
      run("operator", "}"),
      run("operator", ";"),
    ]);
  });

  it("a word after a dot is never a keyword", () => {
    expect(significant(tokenizeJavaScript("a.default; b.if;"))).toEqual([
      run("default", "a"),
      run("operator", "."),
      run("default", "default"),
      run("operator", ";"),
      run("default", "b"),
      run("operator", "."),
      run("default", "if"),
      run("operator", ";"),
    ]);
  });

  it("literals: boolean, null (undefined included)", () => {
    expect(significant(tokenizeJavaScript("[true, false, null, undefined]"))).toEqual([
      run("operator", "["),
      run("boolean", "true"),
      run("operator", ","),
      run("boolean", "false"),
      run("operator", ","),
      run("null", "null"),
      run("operator", ","),
      run("null", "undefined"),
      run("operator", "]"),
    ]);
  });

  it("arrow functions and decorators", () => {
    expect(significant(tokenizeJavaScript("@dec const f = (x) => x * 2;"))).toEqual([
      run("decorator", "@dec"),
      run("keyword", "const"),
      run("default", "f"),
      run("operator", "="),
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
      run("operator", "=>"),
      run("default", "x"),
      run("operator", "*"),
      run("number", "2"),
      run("operator", ";"),
    ]);
  });
});

describe("tokenizeJavaScript literals", () => {
  it("classifies the numeric dialect and distrusts lookalikes", () => {
    const runs = significant(tokenizeJavaScript("[0, 1.5, .5, 0xff, 0b1010, 0o17, 1_000, 10n, 1.2.3, 0x, 1e]"));
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual([
      "0",
      "1.5",
      ".5",
      "0xff",
      "0b1010",
      "0o17",
      "1_000",
      "10n",
      "1.2", // the ".3" tail is the lookalike, not a second number
      "1", // `1e` splits: "1" is the valid literal, "e" a bare identifier
    ]);
    expect(runs.filter((r) => r.type === "default").map((r) => r.text)).toEqual([".3", "0x", "e"]);
  });

  it("reads regex literals (classes, escapes, flags)", () => {
    expect(significant(tokenizeJavaScript('s.replace(/[/]a\\\\/gi, "x");'))).toEqual([
      run("default", "s"),
      run("operator", "."),
      run("fn", "replace"),
      run("operator", "("),
      run("regexp", "/[/]a\\\\/gi"),
      run("operator", ","),
      run("string", '"x"'),
      run("operator", ")"),
      run("operator", ";"),
    ]);
  });

  it("division stays division", () => {
    expect(significant(tokenizeJavaScript("const h = w / 2; a++ / 2; x[i] / 2;"))).toEqual([
      run("keyword", "const"),
      run("default", "h"),
      run("operator", "="),
      run("default", "w"),
      run("operator", "/"),
      run("number", "2"),
      run("operator", ";"),
      run("default", "a"),
      run("operator", "+"),
      run("operator", "+"), // the doubled + is one tracking step (division follows)
      run("operator", "/"),
      run("number", "2"),
      run("operator", ";"),
      run("default", "x"),
      run("operator", "["),
      run("default", "i"),
      run("operator", "]"),
      run("operator", "/"),
      run("number", "2"),
      run("operator", ";"),
    ]);
  });

  it("regex after return/typeof/case, division after values", () => {
    expect(significant(tokenizeJavaScript("return /x/.test(y); typeof /y/; case /a/: b;"))).toEqual([
      run("keyword", "return"),
      run("regexp", "/x/"),
      run("operator", "."),
      run("fn", "test"),
      run("operator", "("),
      run("default", "y"),
      run("operator", ")"),
      run("operator", ";"),
      run("keyword", "typeof"),
      run("regexp", "/y/"),
      run("operator", ";"),
      run("keyword", "case"),
      run("regexp", "/a/"),
      run("operator", ":"),
      run("default", "b"),
      run("operator", ";"),
    ]);
  });

  it("the documented heuristic miss: `if (x) /re/.test(y)` reads as division", () => {
    const runs = significant(tokenizeJavaScript("if (x) /re/.test(y);"));
    expect(runs.filter((r) => r.type === "regexp")).toEqual([]);
    expect(runs.some((r) => r.type === "operator" && r.text === "/")).toBe(true);
  });

  it("templates ride one run, ${...} interpolations included", () => {
    expect(significant(tokenizeJavaScript("const t = `a ${b + `c`} d`;"))).toEqual([
      run("keyword", "const"),
      run("default", "t"),
      run("operator", "="),
      run("template", "`a ${b + `c`} d`"),
      run("operator", ";"),
    ]);
  });

  it("strings honor escapes and stop at the newline (line-wise use)", () => {
    expect(tokenizeJavaScript('a = "x\\"y";')).toContainEqual(run("string", '"x\\"y"'));
    expect(tokenizeJavaScript('a = "oops\nb = 1;')).toEqual([
      run("default", "a"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("string", '"oops'),
      run("default", "\n"),
      run("default", "b"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("number", "1"),
      run("operator", ";"),
    ]);
  });
});

describe("tokenizeJavaScript comments and line-wise degradation", () => {
  it("line comment to EOL, block comment through its closer", () => {
    expect(tokenizeJavaScript("// n\n/* a\nb */ x")).toEqual([
      run("comment", "// n"),
      run("default", "\n"),
      run("comment", "/* a\nb */"),
      run("default", " "),
      run("default", "x"),
    ]);
  });

  it("an unterminated block comment runs to end of input", () => {
    expect(tokenizeJavaScript("a /* nope")).toEqual([
      run("default", "a"),
      run("default", " "),
      run("comment", "/* nope"),
    ]);
  });

  it("an unterminated template runs to end of input (never garbles)", () => {
    expect(tokenizeJavaScript("a = `oops\nmore { code;")).toEqual([
      run("default", "a"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("template", "`oops\nmore { code;"),
    ]);
  });

  it("JSX tag regions degrade: brackets are operator, markup rides plain runs", () => {
    expect(significant(tokenizeJavaScript('const el = <div className="a">hi</div>;'))).toEqual([
      run("keyword", "const"),
      run("default", "el"),
      run("operator", "="),
      run("operator", "<"),
      run("default", "div"),
      run("default", "className"),
      run("operator", "="),
      run("string", '"a"'),
      run("operator", ">"),
      run("default", "hi"),
      run("operator", "</"),
      run("default", "div"),
      run("operator", ">"),
      run("operator", ";"),
    ]);
  });

  it("per-line calls behave: regex at a line start, division continuation", () => {
    expect(tokenizeJavaScript("/re/g.test(s)")).toContainEqual(run("regexp", "/re/g"));
    expect(tokenizeJavaScript("/ 2;")).toEqual([
      run("operator", "/"),
      run("default", " "),
      run("number", "2"),
      run("operator", ";"),
    ]);
  });
});

describe("tokenizeJavaScript losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "x".repeat(50000),
    "`".repeat(500),
    "/".repeat(999),
    "\\",
    '"\\',
    "`${}",
    "`${",
    "${}",
    "/*/",
    "//",
    "/*",
    "`a`${b}c`",
    "/re/g",
    "</",
    "<div",
    "?.",
    "++",
    "--",
    "1..",
    ".5.",
    "0x.",
    "case:",
    "default:",
    "=>",
    ">>>",
    "🚀 emoji ünïcøde 漢字",
    'a = "unterminated\nb = `unterm\nc = /* block\nd = / regex? / x;',
    "const t = `line1\nline2 ${nested(`deep`)} tail`;",
    "// only a comment",
    "/* block only */",
    "@ @dec @ 3",
    "0b2 0o8 1__0 07n",
    "$_allowed if_ else2",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeJavaScript(input);
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
      "(",
      ")",
      "[",
      "]",
      ",",
      ":",
      ";",
      ".",
      "=>",
      "/",
      "//c\n",
      "/*c*/",
      "/*",
      "*/",
      "'",
      '"',
      '"str"',
      "`",
      "`tpl${x}`",
      "\\",
      "1",
      "1.5",
      "0x1f",
      ".5",
      "10n",
      "true",
      "null",
      "undefined",
      "function",
      "return",
      "const",
      "x",
      "Foo",
      " ",
      "\n",
      "\r\n",
      "\t",
      "🚀",
      "<",
      "</",
      "@",
      "++",
      '"unterminated',
      "`unterm",
      "/*unterm",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeJavaScript(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("javascript tokenizer wiring", () => {
  it("getTokenizer resolves javascript; jsx is a def alias, not a second name", () => {
    expect(getTokenizer("javascript")).toBe(tokenizeJavaScript);
    expect(resolveSyntaxLang("jsx")).toBe("javascript");
    expect(getTokenizer("jsx")).toBeUndefined(); // resolve the alias, fetch by canonical name
    const sample = 'import { get } from "./x.ts"; const ok = /y/.test(v); // end';
    const runs = getTokenizer("javascript")!(sample);
    expect(runs.map((r) => r.text).join("")).toBe(sample); // the registry contract, held
    expect(significant(runs)).toContainEqual(run("comment", "// end"));
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual(["import", "get", "from", "const"]);
    expect(runs.filter((r) => r.type === "regexp").map((r) => r.text)).toEqual(["/y/"]);
  });
});
