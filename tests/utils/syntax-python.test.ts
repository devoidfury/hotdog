// Unit tests for the Python tokenizer (src/utils/syntax/python.ts): typed
// runs with exact classes and spans over targeted fixtures (def/class names,
// calls, decorators, every quote form, the distrusted numeric dialect),
// line-wise degradation pins for the file view, a losslessness sweep over a
// nasty fixture corpus plus a deterministic fragment generator, and the
// registry wiring pins.

import { describe, it, expect } from "bun:test";
import { getTokenizer } from "@utils/syntax/index.ts";
import { tokenizePython } from "@utils/syntax/python.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

/** The tokenizer's declared class vocabulary (every run must live here). */
const TYPES = new Set([
  "keyword",
  "fn",
  "string",
  "number",
  "boolean",
  "null",
  "comment",
  "decorator",
  "key",
  "operator",
  "default",
]);

/** Drop the whitespace/newline passthrough to assert the interesting runs. */
const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizePython statements", () => {
  it("classifies a whole program line", () => {
    expect(significant(tokenizePython('def foo(x):  # note'))).toEqual([
      run("keyword", "def"),
      run("fn", "foo"),
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
      run("operator", ":"),
      run("comment", "# note"),
    ]);
  });

  it("class and function names are fn; calls are fn; attributes stay default", () => {
    expect(significant(tokenizePython("class Foo(Bar):\n    z = obj.method(1)"))).toEqual([
      run("keyword", "class"),
      run("fn", "Foo"),
      run("operator", "("),
      run("default", "Bar"),
      run("operator", ")"),
      run("operator", ":"),
      run("default", "z"),
      run("operator", "="),
      run("default", "obj"),
      run("operator", "."),
      run("fn", "method"),
      run("operator", "("),
      run("number", "1"),
      run("operator", ")"),
    ]);
  });

  it("keywords, booleans and None", () => {
    expect(significant(tokenizePython("if x is None or True:\n    return False"))).toEqual([
      run("keyword", "if"),
      run("default", "x"),
      run("keyword", "is"),
      run("null", "None"),
      run("keyword", "or"),
      run("boolean", "True"),
      run("operator", ":"),
      run("keyword", "return"),
      run("boolean", "False"),
    ]);
  });

  it("keywords win before a glued colon; dict keys still read as keys", () => {
    expect(significant(tokenizePython("else:\n    d = {a: 1, b: 2}"))).toEqual([
      run("keyword", "else"), // the clause colon does not demote the keyword
      run("operator", ":"),
      run("default", "d"),
      run("operator", "="),
      run("operator", "{"),
      run("key", "a"),
      run("operator", ":"),
      run("number", "1"),
      run("operator", ","),
      run("key", "b"),
      run("operator", ":"),
      run("number", "2"),
      run("operator", "}"),
    ]);
  });

  it("a word after a dot is never a keyword or key", () => {
    expect(significant(tokenizePython("x.in; y.type"))).toEqual([
      run("default", "x"),
      run("operator", "."),
      run("default", "in"),
      run("operator", ";"),
      run("default", "y"),
      run("operator", "."),
      run("default", "type"),
    ]);
  });

  it("decorators are one run; the bare @ (matrix op) rides default", () => {
    expect(significant(tokenizePython("@app.route\nc = a @ b"))).toEqual([
      run("decorator", "@app"),
      run("operator", "."),
      run("default", "route"),
      run("default", "c"),
      run("operator", "="),
      run("default", "a"),
      run("default", "@"),
      run("default", "b"),
    ]);
  });
});

describe("tokenizePython literals", () => {
  it("the numeric dialect, distrusting lookalikes", () => {
    const runs = significant(tokenizePython("[0, 1.5, .5, 0xff, 0b1010, 0o17, 1_000, 3j, 1.2.3, 0x]"));
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual([
      "0",
      "1.5",
      ".5",
      "0xff",
      "0b1010",
      "0o17",
      "1_000",
      "3j",
      "1.2", // the ".3" tail is the lookalike, not a second number
    ]);
    expect(runs.filter((r) => r.type === "default").map((r) => r.text)).toContain("0x");
  });

  it("single and double quotes honor escapes and stop at the newline", () => {
    expect(tokenizePython('a = "x\\"y"')).toContainEqual(run("string", '"x\\"y"'));
    expect(tokenizePython("a = 'oops\nb = 1")).toEqual([
      run("default", "a"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("string", "'oops"),
      run("default", "\n"),
      run("default", "b"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("number", "1"),
    ]);
  });

  it("triple-quoted strings ride one run, newlines included", () => {
    expect(significant(tokenizePython('s = """a\nb""" + 1'))).toEqual([
      run("default", "s"),
      run("operator", "="),
      run("string", '"""a\nb"""'),
      run("operator", "+"),
      run("number", "1"),
    ]);
  });

  it("string prefixes join the run; an f-string interior is never parsed", () => {
    expect(significant(tokenizePython('f"hi {name} {1+1}" rb\'x\' b"x" u"y"'))).toEqual([
      run("string", 'f"hi {name} {1+1}"'),
      run("string", "rb'x'"),
      run("string", 'b"x"'),
      run("string", 'u"y"'),
    ]);
    // A word that only looks like a prefix keeps its identifier class.
    expect(significant(tokenizePython('b64"tail"'))).toEqual([
      run("default", "b64"),
      run("string", '"tail"'),
    ]);
  });

  it("comment openers inside strings stay strings", () => {
    expect(significant(tokenizePython('s = "a#b" # c'))).toEqual([
      run("default", "s"),
      run("operator", "="),
      run("string", '"a#b"'),
      run("comment", "# c"),
    ]);
  });
});

describe("tokenizePython comments and line-wise degradation", () => {
  it("a comment runs to just before the newline", () => {
    expect(tokenizePython("# note\nx = 1")).toEqual([
      run("comment", "# note"),
      run("default", "\n"),
      run("default", "x"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("number", "1"),
    ]);
  });

  it("an unterminated triple-quoted string runs to end of input (never garbles)", () => {
    expect(tokenizePython('a = """oops\nmore { code;')).toEqual([
      run("default", "a"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("string", '"""oops\nmore { code;'),
    ]);
  });

  it("a line-continuation backslash rides default; the next line re-reads", () => {
    expect(tokenizePython("x = 1 + \\\n    2")).toEqual([
      run("default", "x"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("number", "1"),
      run("default", " "),
      run("operator", "+"),
      run("default", " "),
      run("default", "\\"),
      run("default", "\n    "),
      run("number", "2"),
    ]);
  });

  it("per-line calls behave: a lone call line and an annotation both stay clean", () => {
    expect(significant(tokenizePython("print(x)"))).toEqual([
      run("fn", "print"),
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
    ]);
    expect(significant(tokenizePython("x: int = 3"))).toEqual([
      run("key", "x"),
      run("operator", ":"),
      run("default", "int"),
      run("operator", "="),
      run("number", "3"),
    ]);
  });
});

describe("tokenizePython losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "x".repeat(50000),
    '"',
    "'",
    '"""',
    "'''",
    '""""""',
    '"trail\\',
    "f'",
    "r\\",
    "#",
    "#\n",
    "\\",
    "1..",
    ".5.",
    "0x.",
    "0b2 0o8 1__0 07",
    "3jj 1j2",
    "def\nclass",
    "else:",
    "@ @dec @ 3",
    "$_nope if_ else2",
    "🚀 emoji ünïcøde 漢字",
    'a = "unterminated\nb = """unterm\nc = # comment\nd = 1',
    "s = '''line1\nline2 ''' tail",
    "# only a comment",
    "x = (1 +\n2) * 3j",
    "self.cls = None",
    "lambda x: x",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizePython(input);
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
      "#c\n",
      "#",
      "'",
      '"',
      "'str'",
      '"str"',
      '"""',
      "'''",
      "\\",
      "1",
      "1.5",
      "0x1f",
      ".5",
      "3j",
      "True",
      "False",
      "None",
      "def",
      "class",
      "return",
      "else:",
      "x",
      "Foo",
      "self",
      " ",
      "\n",
      "\r\n",
      "\t",
      "🚀",
      "@",
      "f",
      "f\"tpl{x}\"",
      "'unterminated",
      '"""unterm',
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizePython(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("python tokenizer wiring", () => {
  it("getTokenizer resolves python to tokenizePython and colors a script sample", () => {
    expect(getTokenizer("python")).toBe(tokenizePython);
    const script = [
      "import sys  # entry",
      '@cache',
      "def main(argv):",
      '    print(f"hi {argv}", file=sys.stderr)',
      "    return None",
    ].join("\n");
    const runs = getTokenizer("python")!(script);
    expect(runs.map((r) => r.text).join("")).toBe(script); // the registry contract, held
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual(["import", "def", "return"]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual(["main", "print"]);
    expect(runs.filter((r) => r.type === "null").map((r) => r.text)).toEqual(["None"]);
    expect(significant(runs)).toContainEqual(run("comment", "# entry"));
    expect(significant(runs)).toContainEqual(run("decorator", "@cache"));
    expect(significant(runs)).toContainEqual(run("string", 'f"hi {argv}"'));
  });
});
