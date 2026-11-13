// Unit tests for the Go tokenizer (src/utils/syntax/go.ts): typed runs with
// exact classes and spans over targeted fixtures (the reserved-word and
// primitive readings, the Capitalized heuristic and its dot refusal, the
// three string forms, the numeric dialect with its documented
// degradations), line-wise degradation pins for the file view, a
// losslessness sweep over a nasty fixture corpus plus a deterministic
// fragment generator, and the registry wiring pins (including the moved
// guess pin: main.go is a real scanner's lang now, not metadata-only).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeGo } from "@utils/syntax/go.ts";
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
  "operator",
  "default",
]);

/** Drop the whitespace/newline passthrough to assert the interesting runs. */
const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeGo structure", () => {
  it("classifies a whole program", () => {
    expect(significant(tokenizeGo('package main\n\nimport "fmt"\n\nfunc main() {\n\tx := 3\n\tfmt.Println("hi")\n}'))).toEqual([
      run("keyword", "package"),
      run("default", "main"),
      run("keyword", "import"),
      run("string", '"fmt"'),
      run("keyword", "func"),
      run("fn", "main"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", "{"),
      run("default", "x"),
      run("operator", ":="), // one run, the define-assign
      run("number", "3"),
      run("default", "fmt"),
      run("operator", "."),
      run("fn", "Println"), // the call peek survives the dot
      run("operator", "("),
      run("string", '"hi"'),
      run("operator", ")"),
      run("operator", "}"),
    ]);
  });

  it("primitives and Capitalized names are type; after a dot the readings are refused", () => {
    expect(significant(tokenizeGo("var w Widget = T{N: 1_000}; s := sort.Strings"))).toEqual([
      run("keyword", "var"),
      run("default", "w"),
      run("type", "Widget"),
      run("operator", "="),
      run("type", "T"),
      run("operator", "{"),
      run("type", "N"),
      run("operator", ":"),
      run("number", "1"),
      run("default", "_000"), // the `_` separator degradation, documented
      run("operator", "}"),
      run("operator", ";"),
      run("default", "s"),
      run("operator", ":="),
      run("default", "sort"),
      run("operator", "."),
      run("default", "Strings"), // a selector is not the unqualified Capitalized reading
    ]);
  });

  it("the two-char operators are single runs; channels and members ride through", () => {
    expect(significant(tokenizeGo("ch <- v; p := q.r; x.Type; y.Field(z)"))).toEqual([
      run("default", "ch"),
      run("operator", "<-"), // one run, the channel arrow
      run("default", "v"),
      run("operator", ";"),
      run("default", "p"),
      run("operator", ":="),
      run("default", "q"),
      run("operator", "."),
      run("default", "r"),
      run("operator", ";"),
      run("default", "x"),
      run("operator", "."),
      run("default", "Type"),
      run("operator", ";"),
      run("default", "y"),
      run("operator", "."),
      run("fn", "Field"),
      run("operator", "("),
      run("default", "z"),
      run("operator", ")"),
    ]);
  });

  it("function literals keep func keyword-typed, named calls stay fn", () => {
    expect(significant(tokenizeGo("f := func(n int) int { return n }; go worker()"))).toEqual([
      run("default", "f"),
      run("operator", ":="),
      run("keyword", "func"),
      run("operator", "("),
      run("default", "n"),
      run("type", "int"),
      run("operator", ")"),
      run("type", "int"),
      run("operator", "{"),
      run("keyword", "return"),
      run("default", "n"),
      run("operator", "}"),
      run("operator", ";"),
      run("keyword", "go"),
      run("fn", "worker"),
      run("operator", "("),
      run("operator", ")"),
    ]);
  });
});

describe("tokenizeGo strings and comments", () => {
  it("all three string forms ride string; escapes honored; raw strings keep backslashes", () => {
    expect(significant(tokenizeGo('a = "esc\\"x" b = \'q\' c = `raw\\no-esc` d = "unterm'))).toEqual([
      run("default", "a"),
      run("operator", "="),
      run("string", '"esc\\"x"'),
      run("default", "b"),
      run("operator", "="),
      run("string", "'q'"),
      run("default", "c"),
      run("operator", "="),
      run("string", "`raw\\no-esc`"), // no escape processing between backticks
      run("default", "d"),
      run("operator", "="),
      run("string", '"unterm'),
    ]);
  });

  it("a raw string carries real newlines to its closer", () => {
    expect(tokenizeGo("s := `a\nb`")).toEqual([
      run("default", "s"),
      run("default", " "),
      run("operator", ":="),
      run("default", " "),
      run("string", "`a\nb`"),
    ]);
  });

  it("// runs to EOL; the block form runs to its closer or end of input", () => {
    expect(tokenizeGo("a // c\nb /* blk */ c /* unterm")).toEqual([
      run("default", "a"),
      run("default", " "),
      run("comment", "// c"),
      run("default", "\n"),
      run("default", "b"),
      run("default", " "),
      run("comment", "/* blk */"),
      run("default", " "),
      run("default", "c"),
      run("default", " "),
      run("comment", "/* unterm"),
    ]);
  });

  it("comment openers inside strings stay strings", () => {
    expect(significant(tokenizeGo('s := "//x /*y*/" `// not`'))).toEqual([
      run("default", "s"),
      run("operator", ":="),
      run("string", '"//x /*y*/"'),
      run("string", "`// not`"),
    ]);
  });
});

describe("tokenizeGo numbers", () => {
  it("the numeric dialect, distrusting lookalikes and tails", () => {
    const runs = significant(tokenizeGo("[0, 0755, 0xff, 0b1010, 0o17, 1.5, .5, 1e3, 2.5e-3, 1.2.3, 0x, 1e, 1_000]"));
    // Legacy octal (0755) is legal here -- the json.ts leading-zero distrust is json's.
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual([
      "0",
      "0755",
      "0xff",
      "0b1010",
      "0o17",
      "1.5",
      ".5",
      "1e3",
      "2.5e-3",
      "1.2", // the ".3" tail is the lookalike, not a second number
      "1", // `1e`: the exponent never lands, so the digits alone stay a number
      "1", // `1_000`: number plus the identifier-shaped separator tail
    ]);
    const words = runs.filter((r) => r.type === "default").map((r) => r.text);
    expect(words).toContain("0x"); // no digits after the prefix: not a literal
    expect(words).toContain("_000");
    expect(words).toContain(".3");
  });
});

describe("tokenizeGo line-wise degradation (the file view tokenizes per line)", () => {
  it("an unterminated interpreted string stops at the end of input; the next line re-reads", () => {
    expect(tokenizeGo('x := "oops')).toEqual([
      run("default", "x"),
      run("default", " "),
      run("operator", ":="),
      run("default", " "),
      run("string", '"oops'),
    ]);
    expect(significant(tokenizeGo('y := 1'))).toEqual([
      run("default", "y"),
      run("operator", ":="),
      run("number", "1"),
    ]);
  });

  it("an unterminated raw string runs to end of input (per line: to end of line)", () => {
    expect(tokenizeGo("s := `raw")).toEqual([
      run("default", "s"),
      run("default", " "),
      run("operator", ":="),
      run("default", " "),
      run("string", "`raw"),
    ]);
  });

  it("a multi-line string or comment reads whole across lines; a fragment re-reads honest, never garble", () => {
    expect(tokenizeGo('"a\nb"')).toEqual([
      run("string", '"a'), // per-string the scan stops at the newline; lossless either way
      run("default", "\n"),
      run("default", "b"),
      run("string", '"'),
    ]);
    expect(tokenizeGo("/* a\nb */")).toEqual([run("comment", "/* a\nb */")]); // whole-input: all comment
    expect(tokenizeGo("b */")).toEqual([
      run("default", "b"),
      run("default", " "),
      run("operator", "*"),
      run("operator", "/"),
    ]);
  });
});

describe("tokenizeGo losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "x".repeat(50000),
    "`",
    "``",
    "`unterm",
    '"',
    "'",
    '"esc\\',
    "':\\",
    "\\",
    "1..",
    ".5.",
    "0x",
    "0o8 0b2 1_000",
    "1e 1e+ 0xg",
    "🚀 emoji ünïcøde 漢字",
    "func main() { // hi\n}",
    "p := q.(int)",
    "x := 'a' // '",
    "`a // not comment `",
    "a = \"unterminated\nb := /* unterm\nc := // c\nd := 1",
    "type S struct{ X int }\n",
    "ch <- f().g\n",
    "package main\r\nvar x = 1\r",
    "if x := 1; x < 2 { }",
    "1.2.3 .5.6",
    "-> arrow-shaped text",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeGo(input);
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
      ":=",
      "<-",
      "//c\n",
      "/*",
      "*/",
      "'",
      '"',
      "`",
      "'c'",
      '"str"',
      "`raw",
      '"unterminated',
      "'u",
      "/*unterm",
      "\\",
      "1",
      "0x1f",
      "0755",
      ".5",
      "1e5",
      "1.2.3",
      "0x",
      "func",
      "return",
      "int",
      "string",
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
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeGo(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("go tokenizer wiring", () => {
  it("getTokenizer resolves go to tokenizeGo and colors a program sample", () => {
    expect(getTokenizer("go")).toBe(tokenizeGo);
    expect(resolveSyntaxLang("go")).toBe("go"); // the def ships a scanner now
    expect(guessLangForBase("main.go")).toBe("go"); // moved from the metadata-only registry test
    const code = [
      "package main",
      "",
      'import "os"',
      "",
      "type Config struct{ Path string }",
      "",
      "func main() { // entry",
      "\tx := os.Args[1]",
      "\tf := 1.5e3",
      "}",
    ].join("\n");
    const runs = getTokenizer("go")!(code);
    expect(runs.map((r) => r.text).join("")).toBe(code); // the registry contract, held
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "package",
      "import",
      "type",
      "struct",
      "func",
    ]);
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual(["Config", "Path", "string"]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual(["main"]);
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual(['"os"']);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual(["// entry"]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual(["1", "1.5e3"]);
    expect(significant(runs)).toContainEqual(run("operator", ":="));
  });
});
