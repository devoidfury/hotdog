// Unit tests for the C tokenizer (src/utils/syntax/c.ts): typed runs with
// exact classes and spans over targeted fixtures (whole-line directives,
// both comment forms, every quote form, the distrusted numeric dialect,
// the type/fn readings), line-wise degradation pins for the file view, a
// losslessness sweep over a nasty fixture corpus plus a deterministic
// fragment generator, and the registry wiring pins.

import { describe, it, expect } from "bun:test";
import { getTokenizer } from "@utils/syntax/index.ts";
import { tokenizeC } from "@utils/syntax/c.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

/** The tokenizer's declared class vocabulary (every run must live here). */
const TYPES = new Set([
  "keyword",
  "type",
  "fn",
  "string",
  "comment",
  "number",
  "preproc",
  "operator",
  "default",
]);

/** Drop the whitespace/newline passthrough to assert the interesting runs. */
const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeC structure", () => {
  it("classifies a whole program line", () => {
    expect(significant(tokenizeC("#include <stdio.h>\nint main(void) { return 0; }"))).toEqual([
      run("preproc", "#include <stdio.h>"), // the whole directive line, header included
      run("type", "int"),
      run("fn", "main"),
      run("operator", "("),
      run("type", "void"),
      run("operator", ")"),
      run("operator", "{"),
      run("keyword", "return"),
      run("number", "0"),
      run("operator", ";"),
      run("operator", "}"),
    ]);
  });

  it("struct names are type, calls are fn, ALL_CAPS macros stay default", () => {
    expect(significant(tokenizeC("struct Widget *w = mk(MAX_SIZE);\nw->next = 0x1fUL;"))).toEqual([
      run("keyword", "struct"),
      run("type", "Widget"),
      run("operator", "*"),
      run("default", "w"),
      run("operator", "="),
      run("fn", "mk"),
      run("operator", "("),
      run("default", "MAX_SIZE"), // all-caps: a constant, not the Capitalized type reading
      run("operator", ")"),
      run("operator", ";"),
      run("default", "w"),
      run("operator", "->"), // one run, the member arrow
      run("default", "next"),
      run("operator", "="),
      run("number", "0x1fUL"),
      run("operator", ";"),
    ]);
  });

  it("a word after a dot or arrow keeps no keyword/type reading; the call peek survives", () => {
    expect(significant(tokenizeC("s.in; s.type; p->fn(x); x.int"))).toEqual([
      run("default", "s"),
      run("operator", "."),
      run("default", "in"),
      run("operator", ";"),
      run("default", "s"),
      run("operator", "."),
      run("default", "type"),
      run("operator", ";"),
      run("default", "p"),
      run("operator", "->"),
      run("fn", "fn"), // before `(`: the call reading is a member too
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
      run("operator", ";"),
      run("default", "x"),
      run("operator", "."),
      run("default", "int"),
    ]);
  });

  it("a glued colon (bitfield, label) gets no key reading", () => {
    expect(significant(tokenizeC("flags:3;\ndone:"))).toEqual([
      run("default", "flags"),
      run("operator", ":"),
      run("number", "3"),
      run("operator", ";"),
      run("default", "done"),
      run("operator", ":"),
    ]);
  });
});

describe("tokenizeC directives and comments", () => {
  it("a line-leading # runs whole to EOL, trailing junk included", () => {
    expect(significant(tokenizeC("#define A(x) ((x)*2) // trailing"))).toEqual([
      run("preproc", "#define A(x) ((x)*2) // trailing"), // the // never splits the directive
    ]);
  });

  it("indentation still arms a directive; a mid-line # is not one", () => {
    expect(tokenizeC("  #ifdef X")).toEqual([run("default", "  "), run("preproc", "#ifdef X")]);
    expect(significant(tokenizeC("y = 3 # not a directive"))).toEqual([
      run("default", "y"),
      run("operator", "="),
      run("number", "3"),
      run("default", "#"), // mid-line: bytes, not a directive
      run("default", "not"),
      run("default", "a"),
      run("default", "directive"),
    ]);
  });

  it("// runs to EOL; the block form runs to its closer or end of input", () => {
    expect(tokenizeC("a // c\nb /* block */ c")).toEqual([
      run("default", "a"),
      run("default", " "),
      run("comment", "// c"),
      run("default", "\n"),
      run("default", "b"),
      run("default", " "),
      run("comment", "/* block */"),
      run("default", " "),
      run("default", "c"),
    ]);
    expect(tokenizeC("/* unterm forever")).toEqual([run("comment", "/* unterm forever")]);
  });

  it("comment openers inside strings stay strings", () => {
    expect(significant(tokenizeC('s = "a//b/*c*/" // real'))).toEqual([
      run("default", "s"),
      run("operator", "="),
      run("string", '"a//b/*c*/"'),
      run("comment", "// real"),
    ]);
  });
});

describe("tokenizeC literals", () => {
  it("the numeric dialect, distrusting lookalikes", () => {
    const runs = significant(tokenizeC("[0, 07, 0xff, 0b1010, 1.5, .5, 1e3, 10u, 42ull, 1.5f, 1.2.3, 0x, 1e, _Bool]"));
    // C octal (07) is legal here -- the json.ts leading-zero distrust is json's.
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual([
      "0",
      "07",
      "0xff",
      "0b1010",
      "1.5",
      ".5",
      "1e3",
      "10u",
      "42ull",
      "1.5f",
      "1.2", // the ".3" tail is the lookalike, not a second number
      "1", // `1e`: the exponent never lands, so the digits alone stay a number
    ]);
    expect(runs.filter((r) => r.type === "default").map((r) => r.text)).toContain("0x");
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual(["_Bool"]);
  });

  it("strings and char literals ride one class; escapes honored; prefixes join", () => {
    expect(significant(tokenizeC('x = "a\\"b" \'q\' \'\\n\' L"w" u8"x"'))).toEqual([
      run("default", "x"),
      run("operator", "="),
      run("string", '"a\\"b"'),
      run("string", "'q'"),
      run("string", "'\\n'"),
      run("string", 'L"w"'),
      run("string", 'u8"x"'),
    ]);
    // A word that only looks like a prefix keeps its identifier class.
    expect(significant(tokenizeC('lX"tail"'))).toEqual([
      run("default", "lX"),
      run("string", '"tail"'),
    ]);
  });
});

describe("tokenizeC line-wise degradation (the file view tokenizes per line)", () => {
  it("an unterminated string stops at the newline; the next line re-reads", () => {
    expect(tokenizeC('a = "oops\nb = 1')).toEqual([
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
    ]);
  });

  it("a directive stops at the newline; the continuation tail re-reads as its own line", () => {
    expect(tokenizeC("#define F(x) \\\n  ((x)+1)\n#endif")).toEqual([
      run("preproc", "#define F(x) \\"),
      run("default", "\n  "),
      run("operator", "("),
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
      run("operator", "+"),
      run("number", "1"),
      run("operator", ")"),
      run("default", "\n"),
      run("preproc", "#endif"),
    ]);
  });

  it("a # inside an open block comment is comment bytes; per line it reads honest junk, never garble", () => {
    expect(tokenizeC("/* a\n#define X\n*/")).toEqual([
      run("comment", "/* a\n#define X\n*/"), // whole-input pass: all comment
    ]);
    // The file view's per-line call sees the middle line fresh: a directive
    // (the documented misread) and a closing arrow pair -- lossless either way.
    expect(tokenizeC("#define X")).toEqual([run("preproc", "#define X")]);
    expect(tokenizeC("*/")).toEqual([run("operator", "*"), run("operator", "/")]);
  });
});

describe("tokenizeC losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "x".repeat(50000),
    "#",
    "#\n",
    "#include",
    '"',
    "'",
    '""',
    "''",
    '"trail\\',
    "'trail\\",
    "\\",
    "1..",
    ".5.",
    "0x",
    "0b2 0o8 1__0",
    "1e 1e+ 0xfflU",
    "1'000", // C++14 separator: number plus an open char scan, lossless
    "struct\nenum union",
    "_Bool bool size_t",
    "$_nope if_ else2",
    "🚀 emoji ünïcøde 漢字",
    "GtkWidget *g; Foo f; MAX_SIZE Eof",
    "a = \"unterminated\nb = /* unterm\nc = // comment\nd = 1",
    "#define X(a) a##b",
    "# line with 'quote and \"dquote",
    "/* only a comment",
    "// only a comment",
    "x = (1 +\n2) * 3.0f;",
    "p->q->r.s = *t;",
    "case 'c': goto done;",
    "#endif\r\nx = 1\r",
    "L'\0'",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeC(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "(",
      ")",
      "[",
      "]",
      "{",
      "}",
      ",",
      ":",
      ";",
      ".",
      "->",
      "#",
      "#define X\n",
      "#include <a.h>\n",
      "//c\n",
      "/*",
      "*/",
      "'",
      '"',
      "'c'",
      '"str"',
      'L"',
      "\\",
      "1",
      "0x1f",
      "07",
      ".5",
      "1e5",
      "10ul",
      "int",
      "void",
      "struct",
      "return",
      "Foo",
      "MAX_SIZE",
      "x",
      " ",
      "\n",
      "\r\n",
      "\t",
      "🚀",
      "$",
      "@",
      '"unterminated',
      "/*unterm",
      "'u",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeC(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("c tokenizer wiring", () => {
  it("getTokenizer resolves c to tokenizeC and colors a program sample", () => {
    expect(getTokenizer("c")).toBe(tokenizeC);
    const code = [
      "#include <stdio.h>",
      "#define NAME \"world\"",
      "struct Point { int x, y; };",
      "int main(void) { /* greet */ printf(\"hi\\n\"); return 0; }",
    ].join("\n");
    const runs = getTokenizer("c")!(code);
    expect(runs.map((r) => r.text).join("")).toBe(code); // the registry contract, held
    expect(runs.filter((r) => r.type === "preproc").map((r) => r.text)).toEqual([
      "#include <stdio.h>",
      '#define NAME "world"',
    ]);
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual(["Point", "int", "int", "void"]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual(["main", "printf"]);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual(["/* greet */"]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual(["0"]);
    expect(significant(runs)).toContainEqual(run("string", '"hi\\n"'));
  });
});
