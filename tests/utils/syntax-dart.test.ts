// Unit tests for the Dart tokenizer (src/utils/syntax/dart.ts): typed runs
// with exact classes and spans over targeted fixtures (no prevFn arm and no
// char literals -- both java pieces dropped -- raw `r` strings taking the
// glued-prefix arm with no escape processing, the reserved async family and
// get/set/factory riding keyword against the cs contextual precedent, the
// simplest number dialect of the three (no octal, no binary, no separators,
// no suffixes), and the cascade/spread/function-arrow runs against the
// `::`/`<=>`/`->` rejections), a losslessness sweep over a nasty fixture
// corpus plus a deterministic fragment generator, and the registry wiring
// pins (.dart now resolves through the registry).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeDart } from "@utils/syntax/dart.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

// No "variable": dart identifiers have no sigils ($ only interpolates
// inside strings, where it rides the string run).
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

describe("tokenizeDart structure", () => {
  it("class/mixin/getter declarations read cleanly; getters ride honestly", () => {
    expect(
      significant(
        tokenizeDart("class Point extends Offset with Comparable {\n  final int x;\n  String get label => 'p';\n  void draw(double amount) {}\n}"),
      ),
    ).toEqual([
      run("keyword", "class"),
      run("type", "Point"), // the declaration arm claims the name before the call peek
      run("keyword", "extends"),
      run("type", "Offset"),
      run("keyword", "with"),
      run("type", "Comparable"),
      run("operator", "{"),
      run("keyword", "final"),
      run("default", "int"), // no primitive set: `int` is an ordinary lowercase class name
      run("default", "x"),
      run("operator", ";"),
      run("type", "String"),
      run("keyword", "get"), // get/set are RESERVED in the dart grammar (the honest call against cs)
      run("default", "label"), // getters take no fn reading: `label` is glued to `=>`, not `(`
      run("operator", "=>"), // the function arrow IS a real dart operator run
      run("string", "'p'"),
      run("operator", ";"),
      run("type", "void"), // void is reserved and rides type with the java family
      run("fn", "draw"), // the call peek is the only fn arm (dart has no def keyword)
      run("operator", "("),
      run("default", "double"),
      run("default", "amount"),
      run("operator", ")"),
      run("operator", "{"),
      run("operator", "}"),
      run("operator", "}"),
    ]);
    // Named constructors and constructor calls take the peek; the dot
    // refuses every other reading.
    expect(significant(tokenizeDart("Point.empty(); Point(1); a.int; x.False"))).toEqual([
      run("type", "Point"),
      run("operator", "."),
      run("fn", "empty"), // the call peek survives the dot
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("fn", "Point"), // constructor call: the peek claims it, like java
      run("operator", "("),
      run("number", "1"),
      run("operator", ")"),
      run("operator", ";"),
      run("default", "a"),
      run("operator", "."),
      run("default", "int"),
      run("operator", ";"),
      run("default", "x"),
      run("operator", "."),
      run("default", "False"), // member position: the Capitalized reading is refused too
    ]);
  });

  it("mixin/extension/typedef names, and the reserved async family", () => {
    expect(
      significant(tokenizeDart("mixin Loud on Animal {}\nextension X on String {}\ntypedef Handler = void Function(int);")),
    ).toEqual([
      run("keyword", "mixin"),
      run("type", "Loud"),
      run("keyword", "on"),
      run("type", "Animal"),
      run("operator", "{"),
      run("operator", "}"),
      run("keyword", "extension"),
      run("type", "X"), // single letter IS Capitalized by the heuristic
      run("keyword", "on"),
      run("type", "String"),
      run("operator", "{"),
      run("operator", "}"),
      run("keyword", "typedef"),
      run("type", "Handler"),
      run("operator", "="),
      run("type", "void"),
      run("fn", "Function"), // `Function(` takes the call peek, the constructor-call road (documented, honest)
      run("operator", "("),
      run("default", "int"),
      run("operator", ")"),
      run("operator", ";"),
    ]);
    // async/await/yield/sync are reserved words in the dart grammar (the
    // plan draft's cs-contextual precedent stays in cs).
    expect(significant(tokenizeDart("Future<void> run() async => await fetch();"))).toEqual([
      run("type", "Future"),
      run("operator", "<"), // generics ride plain operators
      run("type", "void"),
      run("operator", ">"),
      run("fn", "run"),
      run("operator", "("),
      run("operator", ")"),
      run("keyword", "async"),
      run("operator", "=>"),
      run("keyword", "await"),
      run("fn", "fetch"), // the call peek, as ever
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
    ]);
  });

  it("raw strings: glued r prefix, no escape processing, both triple forms", () => {
    expect(significant(tokenizeDart(String.raw`x = r'\d+'`))).toEqual([
      run("default", "x"),
      run("operator", "="),
      run("string", String.raw`r'\d+'`), // the backslash is literal: no escape consumption
    ]);
    // A raw TRIPLE runs to the closer; the backslash cannot shield it
    // (dart agrees: a raw string cannot contain its quote at all).
    expect(significant(tokenizeDart('r"""a\\"""'))).toEqual([run("string", 'r"""a\\"""')]);
    // The prefix must be the GLUED single `r`: a longer word rides as the
    // word and the quote opens the ordinary scan.
    expect(significant(tokenizeDart("raw 'x' rx'y'"))).toEqual([
      run("default", "raw"),
      run("string", "'x'"),
      run("default", "rx"),
      run("string", "'y'"),
    ]);
    // A lone `r` (no glued quote) is an ordinary word; an unclosed raw
    // runs to end of input.
    expect(significant(tokenizeDart("r = 1"))).toEqual([
      run("default", "r"),
      run("operator", "="),
      run("number", "1"),
    ]);
    expect(significant(tokenizeDart("r'ab"))).toEqual([run("string", "r'ab")]);
  });

  it("strings: interpolation inside the run, triples scan, no char literals", () => {
    expect(significant(tokenizeDart('"a$x" \'${y}\''))).toEqual([
      run("string", '"a$x"'), // the hole stays inside (the rust format-string ruling)
      run("string", "'${y}'"),
    ]);
    expect(significant(tokenizeDart('"""two\nlines ${x}"""'))).toEqual([run("string", '"""two\nlines ${x}"""')]);
    expect(significant(tokenizeDart("'''two\nlines'''"))).toEqual([run("string", "'''two\nlines'''")]);
    expect(significant(tokenizeDart('"""raw'))).toEqual([run("string", '"""raw')]);
    // NO char literals in the java sense: `'ab'` is one whole string run.
    expect(significant(tokenizeDart("'ab'"))).toEqual([run("string", "'ab'")]);
    // Adjacent-literal concatenation rides as the separate runs the scan
    // gives (the language's join is a parse-time gesture).
    expect(significant(tokenizeDart("'a' 'b'"))).toEqual([run("string", "'a'"), run("string", "'b'")]);
    // A quote inside an interpolation hole closes the literal, and the
    // hole's closing quote opens a fresh string over the tail (kotlin's
    // documented cost, identical here).
    expect(significant(tokenizeDart('x = "a${"in"}b" c'))).toEqual([
      run("default", "x"),
      run("operator", "="),
      run("string", '"a${"'),
      run("keyword", "in"),
      run("string", '"}b"'),
      run("default", "c"),
    ]);
    // The house splice/stop rules on ordinary literals.
    expect(significant(tokenizeDart('"un\ntail'))).toEqual([run("string", '"un'), run("default", "tail")]);
    expect(significant(tokenizeDart('"abc\\\ndef"'))).toEqual([run("string", '"abc\\\ndef"')]);
  });

  it("comments: // (doc comments included), blocks never nest", () => {
    expect(significant(tokenizeDart("/// doc\n// line\nx"))).toEqual([
      run("comment", "/// doc"), // dart's doc comments are ordinary line comments
      run("comment", "// line"),
      run("default", "x"),
    ]);
    // Dart does NOT nest block comments (unlike kotlin): the inner closer
    // ends the run.
    expect(significant(tokenizeDart("/* outer /* inner */ still */ tail"))).toEqual([
      run("comment", "/* outer /* inner */"),
      run("default", "still"),
      run("operator", "*"),
      run("operator", "/"),
      run("default", "tail"),
    ]);
    expect(significant(tokenizeDart("/* unclosed"))).toEqual([run("comment", "/* unclosed")]);
  });

  it("keywords are case-sensitive: the async family and get/set/factory ride keyword", () => {
    expect(
      significant(tokenizeDart("true false null TRUE NULL False var final const late async await yield sync get set factory void it")),
    ).toEqual([
      run("boolean", "true"),
      run("boolean", "false"),
      run("null", "null"),
      run("default", "TRUE"),
      run("default", "NULL"),
      run("type", "False"), // the Capitalized heuristic, not the boolean reading
      run("keyword", "var"),
      run("keyword", "final"),
      run("keyword", "const"),
      run("keyword", "late"),
      run("keyword", "async"), // reserved words here, not cs's contextual defaults
      run("keyword", "await"),
      run("keyword", "yield"),
      run("keyword", "sync"),
      run("keyword", "get"),
      run("keyword", "set"),
      run("keyword", "factory"),
      run("type", "void"),
      run("default", "it"), // dart has no implicit `it` at all
    ]);
  });

  it("numbers: the simplest dialect -- hex only, no octal, no binary, no separators, no suffixes", () => {
    expect(
      significant(tokenizeDart("10 0xFF 0xff00 6.02e23 1.0e-3 1.5 0 0777 0x 1_000 0b101 42L .5 1.2.3 1..2 0X1")),
    ).toEqual([
      run("number", "10"),
      run("number", "0xFF"),
      run("number", "0xff00"),
      run("number", "6.02e23"),
      run("number", "1.0e-3"),
      run("number", "1.5"),
      run("number", "0"),
      // NO octal in any spelling: `0777` is a plain decimal (the cs pin).
      run("number", "0777"),
      run("default", "0x"),
      // NO digit separators (unlike java/kotlin/groovy): the number 1
      // plus the identifier `_000`, since `_` starts a dart identifier.
      run("number", "1"),
      run("default", "_000"),
      // NO binary radix either (the reverse of every other family
      // member): the number 0 plus the word b101.
      run("number", "0"),
      run("default", "b101"),
      // NO suffix zoo: the number 42 plus the word L (a lone Capitalized
      // letter is a class-shaped name, the java `K`/`V` reading).
      run("number", "42"),
      run("type", "L"),
      run("operator", "."), // no leading-dot float: `.5` is a dot and a number
      run("number", "5"),
      run("number", "1.2"),
      run("operator", "."),
      run("number", "3"),
      run("number", "1"),
      run("operator", ".."), // the cascade IS an operator run
      run("number", "2"),
      // hex is the lowercase `0x` spelling only, as the grammar's own:
      // the number 0 plus the word X1 (Capitalized-shaped, so type).
      run("number", "0"),
      run("type", "X1"),
    ]);
  });

  it("operators: cascade/spread/arrow/??= are runs; ?. sets dot; ::, <=>, -> degrade", () => {
    expect(
      significant(tokenizeDart("c..a = 1; [ ...xs, ...?ys ]; x?..save(); o?.trim(); v ??= 2; f(x) => x ?? 0")),
    ).toEqual([
      run("default", "c"),
      run("operator", ".."), // the cascade IS one run
      run("default", "a"),
      run("operator", "="),
      run("number", "1"),
      run("operator", ";"),
      run("operator", "["),
      run("operator", "..."), // the spread IS one run (dart 3)
      run("default", "xs"),
      run("operator", ","),
      run("operator", "..."), // the null-aware spread decomposes: `...` then `?`
      run("operator", "?"),
      run("default", "ys"),
      run("operator", "]"),
      run("operator", ";"),
      run("default", "x"),
      run("operator", "?.."), // the null-aware cascade IS a three-char run
      run("fn", "save"), // the call peek takes the name after it
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("default", "o"),
      run("operator", "?."), // the null-aware method call IS a member position (the cs ruling)
      run("fn", "trim"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("default", "v"),
      run("operator", "??="), // null-assign: one three-char run
      run("number", "2"),
      run("operator", ";"),
      run("fn", "f"), // a function DECLARATION `f(x) =>` takes the peek, like the java signature
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
      run("operator", "=>"), // the function arrow: a real dart token
      run("default", "x"),
      run("operator", "??"), // null-patience: one run
      run("number", "0"),
    ]);
    // `::` is NOT a dart operator (static access is a plain dot) and
    // degrades to two single colons; `<=>` and `->` do not exist either.
    expect(significant(tokenizeDart("A::B; a <=> b; a -> b"))).toEqual([
      run("type", "A"),
      run("operator", ":"),
      run("operator", ":"),
      run("type", "B"),
      run("operator", ";"),
      run("default", "a"),
      run("operator", "<="),
      run("operator", ">"),
      run("default", "b"),
      run("operator", ";"),
      run("default", "a"),
      run("operator", "-"),
      run("operator", ">"),
      run("default", "b"),
    ]);
    // The `?...` spelling maximal-munches into the three-char null-aware
    // cascade plus a dot (the three-char check runs first, as the real
    // lexer does).
    expect(significant(tokenizeDart("a ?...b"))).toEqual([
      run("default", "a"),
      run("operator", "?.."),
      run("operator", "."),
      run("default", "b"),
    ]);
  });

  it("annotations are one decorator run; at most one paren group; bare @ rides default", () => {
    expect(
      significant(tokenizeDart("@override\n@Component(name: 'greeter')\n@Foo(\"a)b\")\n@Foo.Bar (x: 1)\n@deprecated x\n@\n@[x]")),
    ).toEqual([
      run("decorator", "@override"), // lowercase annotation names ride (glue is the rule, not case)
      run("decorator", "@Component(name: 'greeter')"),
      run("decorator", '@Foo("a)b")'), // the string is skipped: its `)` cannot cut the run short
      run("decorator", "@Foo.Bar (x: 1)"), // dotted names and whitespace before `(` (the java arm)
      run("decorator", "@deprecated"), // no group: just the glued name
      run("default", "x"),
      run("default", "@"), // unglued: plain
      run("default", "@"),
      run("operator", "["), // dart has no bracket-attribute form
      run("default", "x"),
      run("operator", "]"),
    ]);
    // Unclosed argument group: runs to end of input.
    expect(significant(tokenizeDart('@Foo("a") @Bar("x'))).toEqual([
      run("decorator", '@Foo("a")'),
      run("decorator", '@Bar("x'),
    ]);
  });
});

describe("tokenizeDart registry contract", () => {
  it("guesses and fences resolve through the registry", () => {
    expect(guessLangForBase("main.dart")).toBe("dart");
    expect(guessLangForBase("MAIN.DART")).toBe("dart");
    expect(resolveSyntaxLang("dart")).toBe("dart");
    expect(resolveSyntaxLang("dartx")).toBeUndefined(); // no aliases: the fence word is the name
    expect(getTokenizer("dart")).toBe(tokenizeDart);
  });
});

describe("tokenizeDart losslessness", () => {
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
    "#",
    "//",
    "/*",
    "*/",
    "/* /* */",
    "'''",
    "''",
    "'''''",
    '"""',
    '""""',
    '"""""',
    "r",
    "r'",
    'r"',
    "r'''",
    'r"""',
    'r""""',
    "r'\\",
    "@",
    "@[",
    "@Foo(",
    '@Foo("\'',
    "$",
    "${",
    "..",
    "...",
    "...?",
    "?..",
    "?...",
    "=>",
    "?.",
    "??",
    "??=",
    "::",
    "->",
    "<=>",
    "0x",
    "0b",
    "0b2",
    "0777",
    "1_",
    "1_000",
    ".5",
    "1..2",
    "1.2.3",
    "TRUE False",
    '"unterminated',
    "'unterminated",
    '"splice\\',
    '"""raw',
    "async",
    "get",
    "it",
    "🚀 emoji ünïcøde 漢字",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeDart(input);
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
      "'''",
      "'''\\",
      '"""',
      '"""\n',
      "r",
      "r'",
      'r"',
      "r'''",
      'r"""',
      "@",
      "@Foo",
      "@Foo(",
      "class",
      "mixin",
      "extension",
      "typedef",
      "get",
      "set",
      "var",
      "const",
      "late",
      "async",
      "await",
      "true",
      "null",
      "TRUE",
      "void",
      "int",
      "Widget",
      "MAX_SIZE",
      "1",
      "0x",
      "1_",
      "1_2",
      "0777",
      "0b1",
      "42L",
      ".5",
      "..",
      "...",
      "...?",
      "?..",
      "=>",
      "?.",
      "??",
      "??=",
      "::",
      "->",
      "<=>",
      "==",
      "!",
      "=",
      "<",
      ">",
      "(",
      ")",
      "{",
      "}",
      ";",
      ",",
      "?",
      ":",
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
      const runs = tokenizeDart(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("dart tokenizer wiring", () => {
  it("getTokenizer resolves dart to tokenizeDart and classifies a sample", () => {
    const doc = [
      "// greeting service",
      "import 'dart:core';",
      "",
      "@Component(name: 'greeter')",
      "class Greeter extends Base {",
      "  static const int LIMIT = 10;",
      "",
      "  // pipeline",
      "  Future<String> greet(String name) async {",
      "    return 'hi $name!';",
      "  }",
      "}",
    ].join("\n");
    const runs = getTokenizer("dart")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual([
      "// greeting service",
      "// pipeline",
    ]);
    expect(runs.filter((r) => r.type === "decorator").map((r) => r.text)).toEqual([
      "@Component(name: 'greeter')",
    ]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "import",
      "class",
      "extends",
      "static",
      "const",
      "async",
      "return",
    ]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual(["greet"]);
    // `LIMIT` is an all-caps constant (not Capitalized) and `int` is an
    // ordinary lowercase class name; the annotation's argument name rides
    // the decorator run whole.
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual([
      "Greeter",
      "Base",
      "Future",
      "String",
      "String",
    ]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual(["10"]);
    // The annotation's argument string rides the decorator run (skipped,
    // not re-classified), like rust attributes and the java pin.
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual([
      "'dart:core'",
      "'hi $name!'",
    ]);
  });
});
