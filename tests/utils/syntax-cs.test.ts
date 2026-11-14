// Unit tests for the C# tokenizer (src/utils/syntax/cs.ts): typed runs
// with exact classes and spans over targeted fixtures (position-armed
// attributes versus plain array brackets, the string family -- interpreted,
// interpolated (holes inside the run), verbatim with doubled-quote escapes,
// and the `$@` combinations -- the null-conditional member position,
// case-sensitive keywords, contextual words riding default, and the number
// dialect where `0777` is a plain decimal), a losslessness sweep over a
// nasty fixture corpus plus a deterministic fragment generator, and the
// registry wiring pins (.cs now resolves through the registry as "csharp").

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeCs } from "@utils/syntax/cs.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

const TYPES = new Set([
  "comment",
  "string",
  "decorator",
  "keyword",
  "boolean",
  "null",
  "type",
  "fn",
  "number",
  "operator",
  "default",
]);

const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeCs structure", () => {
  it("declaration names, base lists, and typed signatures read cleanly", () => {
    expect(
      significant(
        tokenizeCs("public class Point : Vec2, Renderable { private readonly int count; public void Draw(double amount) {} }"),
      ),
    ).toEqual([
      run("keyword", "public"),
      run("keyword", "class"),
      run("type", "Point"),
      run("operator", ":"),
      run("type", "Vec2"), // the `:` of a base list is a plain operator; Capitalized does the work
      run("operator", ","),
      run("type", "Renderable"),
      run("operator", "{"),
      run("keyword", "private"),
      run("keyword", "readonly"),
      run("type", "int"),
      run("default", "count"),
      run("operator", ";"),
      run("keyword", "public"),
      run("type", "void"),
      run("fn", "Draw"),
      run("operator", "("),
      run("type", "double"),
      run("default", "amount"),
      run("operator", ")"),
      run("operator", "{"),
      run("operator", "}"),
      run("operator", "}"),
    ]);
    // struct/namespace names ride the declaration arm too.
    expect(significant(tokenizeCs("namespace App.Models { record Pair<T>(T key) {} }"))).toEqual([
      run("keyword", "namespace"),
      run("type", "App"), // the declaration arm claims the first name...
      run("operator", "."),
      run("default", "Models"), // ...and the dot spends it: the tail is member position
      run("operator", "{"),
      run("keyword", "record"),
      run("type", "Pair"), // the declaration arm claims the name before the call peek
      run("operator", "<"),
      run("type", "T"),
      run("operator", ">"),
      run("operator", "("),
      run("type", "T"),
      run("default", "key"),
      run("operator", ")"),
      run("operator", "{"),
      run("operator", "}"),
      run("operator", "}"),
    ]);
  });

  it("attributes are armed-position decorators; every other bracket is plain", () => {
    expect(
      significant(
        tokenizeCs('[Serializable]\n[Obsolete("old")]\n[Theory, InlineData(1)]\npublic void T() {}'),
      ),
    ).toEqual([
      run("decorator", "[Serializable]"),
      run("decorator", '[Obsolete("old")]'), // strings skipped inside the balanced run
      run("decorator", "[Theory, InlineData(1)]"),
      run("keyword", "public"),
      run("type", "void"),
      run("fn", "T"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", "{"),
      run("operator", "}"),
    ]);
    // Stacked attributes arm each other; the inner `[]` of the argument
    // balances inside the run.
    expect(significant(tokenizeCs("[A][B]\nstatic void Main() {}"))).toEqual([
      run("decorator", "[A]"),
      run("decorator", "[B]"),
      run("keyword", "static"),
      run("type", "void"),
      run("fn", "Main"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", "{"),
      run("operator", "}"),
    ]);
    // Plain brackets everywhere else: after a word (index, `Foo[]`), a
    // collection expression after `=`, and an armed `[` not glued to a name.
    expect(significant(tokenizeCs("Foo[] arr = list[0]; var x = [1, 2]; y;\n[0] = 1;"))).toEqual([
      run("type", "Foo"),
      run("operator", "["),
      run("operator", "]"),
      run("default", "arr"),
      run("operator", "="),
      run("default", "list"),
      run("operator", "["),
      run("number", "0"),
      run("operator", "]"),
      run("operator", ";"),
      run("default", "var"),
      run("default", "x"),
      run("operator", "="),
      run("operator", "["),
      run("number", "1"),
      run("operator", ","),
      run("number", "2"),
      run("operator", "]"),
      run("operator", ";"),
      run("default", "y"),
      run("operator", ";"),
      run("operator", "["), // armed (after `;` and a newline) but NOT glued to a name: plain
      run("number", "0"),
      run("operator", "]"),
      run("operator", "="),
      run("number", "1"),
      run("operator", ";"),
    ]);
    // Unclosed attribute runs to end of input.
    expect(significant(tokenizeCs('[Foo("a")] [Bar("x'))).toEqual([
      run("decorator", '[Foo("a")]'),
      run("decorator", '[Bar("x'),
    ]);
  });

  it("the string family: interpreted, interpolated (holes inside), verbatim, and the $@ spellings", () => {
    expect(
      significant(tokenizeCs(String.raw`"a\nb" "hi {name}!" $@"x {y}" @"c:\path\nok" @$"raw {z}" "$lit"`)),
    ).toEqual([
      run("string", String.raw`"a\nb"`),
      run("string", '"hi {name}!"'),
      run("string", '$@"x {y}"'),
      run("string", String.raw`@"c:\path\nok"`), // verbatim: the backslashes are plain
      run("string", '@$"raw {z}"'),
      run("string", '"$lit"'),
    ]);
    // The doubled `""` is the only verbatim escape: it cannot close early.
    expect(significant(tokenizeCs('@"a""b" "out"'))).toEqual([
      run("string", '@"a""b"'),
      run("string", '"out"'),
    ]);
    // Interpolation keeps the holes inside the string run (the rust
    // format-string ruling); an unterminated one just runs out.
    expect(significant(tokenizeCs('$"a {x} b'))).toEqual([run("string", '$"a {x} b')]);
    // An unterminated interpreted literal stops at the newline.
    expect(significant(tokenizeCs('"un\ntail'))).toEqual([run("string", '"un'), run("default", "tail")]);
    // A backslash before the newline splices the line (the c.ts endOfString).
    expect(significant(tokenizeCs('"abc\\\ndef"'))).toEqual([run("string", '"abc\\\ndef"')]);
    // A lone `$` is not a prefix and rides default (java's cursed
    // identifier char is not one here).
    expect(significant(tokenizeCs("$ $x"))).toEqual([
      run("default", "$"),
      run("default", "$"),
      run("default", "x"),
    ]);
  });

  it("char literals take the java simple rule; a failing quote rides default", () => {
    expect(
      significant(tokenizeCs(String.raw`'c' '\'' '\n' '\u0041' 'ab' 'a`)),
    ).toEqual([
      run("string", "'c'"),
      run("string", String.raw`'\''`),
      run("string", String.raw`'\n'`),
      run("string", String.raw`'\u0041'`),
      run("default", "'"),
      run("default", "ab"),
      run("string", "' '"), // `' '` IS a java/C# literal: the space character
      run("default", "a"),
    ]);
  });

  it("?. and :: are member positions; =>, ?: and ??= are not operators", () => {
    expect(
      significant(tokenizeCs("a?.b(); a?.ToString(); a?.true; Foo::Bar; global::System.Console.WriteLine(); a => b; a ?: b; a ?? b;")),
    ).toEqual([
      run("default", "a"),
      run("operator", "?."),
      run("fn", "b"), // the call peek survives the null-conditional dot
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("default", "a"),
      run("operator", "?."),
      run("fn", "ToString"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("default", "a"),
      run("operator", "?."),
      run("default", "true"), // member position: the boolean reading is refused
      run("operator", ";"),
      run("type", "Foo"),
      run("operator", "::"),
      run("default", "Bar"),
      run("operator", ";"),
      run("default", "global"), // contextual word: rides default
      run("operator", "::"),
      run("default", "System"), // after `::` even System is a member name
      run("operator", "."),
      run("default", "Console"), // still member position: the peek sees a `.`, not a `(`
      run("operator", "."),
      run("fn", "WriteLine"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("default", "a"),
      run("operator", "="), // no fat arrow in the run list: equals then greater
      run("operator", ">"),
      run("default", "b"),
      run("operator", ";"),
      run("default", "a"),
      run("operator", "?"), // no elvis in C#: question then colon
      run("operator", ":"),
      run("default", "b"),
      run("operator", ";"),
      run("default", "a"),
      run("operator", "??"), // null-coalescing IS an operator
      run("default", "b"),
      run("operator", ";"),
    ]);
    // The nullable marker rides the plain `?`.
    expect(significant(tokenizeCs("int? x = null;"))).toEqual([
      run("type", "int"),
      run("operator", "?"),
      run("default", "x"),
      run("operator", "="),
      run("null", "null"),
      run("operator", ";"),
    ]);
  });

  it("keywords are case-sensitive; contextual words ride default; nameof takes the peek", () => {
    expect(
      significant(tokenizeCs("true false null TRUE NULL False Class INT int var async await nameof(x)")),
    ).toEqual([
      run("boolean", "true"),
      run("boolean", "false"),
      run("null", "null"),
      run("default", "TRUE"),
      run("default", "NULL"),
      run("type", "False"), // the Capitalized heuristic, not the boolean reading
      run("type", "Class"), // same: `Class` is only a type, never the keyword
      run("default", "INT"),
      run("type", "int"),
      run("default", "var"), // contextual: rides default, honest
      run("default", "async"), // contextual: rides default
      run("default", "await"), // contextual: rides default
      run("fn", "nameof"), // not a keyword: it takes the call peek
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
    ]);
  });

  it("numbers: hex/binary/decimals with separators and the suffix zoo; no octal, no .5", () => {
    expect(
      significant(
        tokenizeCs("10 1_000 0xFF_FF 0777 0778 0b10_1 6.02e23 1.5 42L 1.5f 2.0m 3.0d 0xFFUL 0 0x 1_ 0o7 .5 1.2.3 1..2"),
      ),
    ).toEqual([
      run("number", "10"),
      run("number", "1_000"),
      run("number", "0xFF_FF"),
      // C# has NO octal spelling: `0NNN` is a plain leading-zero decimal
      // (the opposite of the php/java `0777` reading, and `0778` is fine
      // here where php distrusts it).
      run("number", "0777"),
      run("number", "0778"),
      run("number", "0b10_1"),
      run("number", "6.02e23"),
      run("number", "1.5"),
      run("number", "42L"),
      run("number", "1.5f"),
      run("number", "2.0m"),
      run("number", "3.0d"),
      run("number", "0xFFUL"),
      run("number", "0"),
      run("default", "0x"),
      run("default", "1_"),
      run("number", "0"), // `0o` is not a radix prefix: the number 0 plus...
      run("default", "o7"), // ...the word o7
      run("operator", "."), // no leading-dot float: `.5` is a dot and a number
      run("number", "5"),
      run("number", "1.2"),
      run("operator", "."),
      run("number", "3"),
      run("number", "1"),
      run("operator", "."),
      run("operator", "."),
      run("number", "2"),
    ]);
  });

  it("comments: two spellings, no nesting, unclosed runs out", () => {
    expect(significant(tokenizeCs("// line\n/// xmldoc\nx"))).toEqual([
      run("comment", "// line"),
      run("comment", "/// xmldoc"),
      run("default", "x"),
    ]);
    expect(significant(tokenizeCs("/* outer /* inner */ still */ tail"))).toEqual([
      run("comment", "/* outer /* inner */"),
      run("default", "still"),
      run("operator", "*"),
      run("operator", "/"),
      run("default", "tail"),
    ]);
    expect(significant(tokenizeCs("/* unclosed"))).toEqual([run("comment", "/* unclosed")]);
  });
});

describe("tokenizeCs registry contract", () => {
  it("guesses and fences resolve through the registry", () => {
    expect(guessLangForBase("Program.cs")).toBe("csharp");
    expect(guessLangForBase("Program.CS")).toBe("csharp");
    expect(resolveSyntaxLang("csharp")).toBe("csharp");
    expect(resolveSyntaxLang("cs")).toBeUndefined(); // an extension is not an alias
    expect(getTokenizer("csharp")).toBe(tokenizeCs);
  });
});

describe("tokenizeCs losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\n",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "a".repeat(50000),
    "\\",
    "'",
    '"',
    "//",
    "/*",
    "*/",
    "/* /* */",
    "@",
    "$",
    "$$",
    "$@",
    "@$",
    '$"',
    '@"',
    '@"',
    '@$"',
    '@"a""',
    '"unterminated',
    "'unterminated",
    '"splice\\',
    "@class",
    "[",
    "[]",
    "[a]",
    "= [1]",
    "'''",
    "0x",
    "1_",
    "0777",
    "0778",
    "0o7",
    "0b",
    ".5",
    "1..2",
    "1.2.3",
    "?.",
    "??",
    "=>",
    "?:",
    "::",
    "->",
    "TRUE NULL False",
    "//x\n",
    "🚀 emoji ünïcøde 漢字",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeCs(input);
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
      '"str"',
      '@"',
      "$\"",
      "$@\"",
      "@$",
      "$",
      "@",
      "[",
      "[Foo]",
      "[Foo(",
      "]",
      "class",
      "record",
      "public",
      "true",
      "TRUE",
      "null",
      "int",
      "string",
      "var",
      "Widget",
      "MAX_SIZE",
      "Foo",
      "1",
      "0x",
      "1_",
      "1_2",
      "0777",
      ".5",
      "1..2",
      "?.",
      "??",
      "=>",
      "?:",
      "::",
      "->",
      "==",
      "!",
      "=",
      "(",
      ")",
      "{",
      "}",
      ";",
      ",",
      "?",
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
      const runs = tokenizeCs(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("csharp tokenizer wiring", () => {
  it("getTokenizer resolves csharp to tokenizeCs and classifies a sample", () => {
    const doc = [
      "using System.Collections.Generic;",
      "",
      "[Serializable]",
      "public class Greeter : Base, Wire {",
      "    // greeting cache",
      "    private static readonly int limit = 10;",
      "    private readonly string name;",
      "",
      "    public Greeter(string name) {",
      '        this.name = name ?? "anon";',
      "    }",
      "",
      "    public IEnumerable<string> GreetAll() {",
      "        return names.Select(s => prefix + s.Trim()).ToList(); // pipeline",
      "    }",
      "}",
    ].join("\n");
    const runs = getTokenizer("csharp")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual([
      "// greeting cache",
      "// pipeline",
    ]);
    expect(runs.filter((r) => r.type === "decorator").map((r) => r.text)).toEqual(["[Serializable]"]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "using",
      "public",
      "class",
      "private",
      "static",
      "readonly",
      "private",
      "readonly",
      "public",
      "this",
      "public",
      "return",
    ]);
    // The constructor declaration reads "fn" via the call peek (the
    // `class Greeter` declaration arm claimed the first occurrence only).
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual([
      "Greeter",
      "GreetAll",
      "Select",
      "Trim",
      "ToList",
    ]);
    // The dotted `using` tail is member position: only `System` (the first
    // Capitalized name) reads as a type there, and `IEnumerable` is not
    // Capitalized by the heuristic (the mixed-case "IE" prefix, the c.ts
    // ruling: `GtkWidget` stays a plain word too).
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual([
      "System",
      "Greeter",
      "Base",
      "Wire",
      "int",
      "string",
      "string",
      "string",
    ]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual(["10"]);
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual(['"anon"']);
  });
});
