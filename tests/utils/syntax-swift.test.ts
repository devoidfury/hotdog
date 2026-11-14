// Unit tests for the Swift tokenizer (src/utils/syntax/swift.ts): typed runs
// with exact classes and spans over targeted fixtures (the kotlin.ts family
// transfer with the swift deltas: NESTED block comments and the overflow
// operator family -- both spec overrides of the plan draft; the interpolation
// hole closing single-line strings while the escape-aware multiline scan
// survives it; hash-delimited raw strings in single-line and multiline form
// with the newline stop and the closer-shape cost; the `init(`/`init?(` fn
// quirk; `?.` as member but `->` not; the octal `0o` reverse pin and the
// no-suffix-zoo ruling; `nil` riding null and `Self` riding the Capitalized
// heuristic), a losslessness sweep over a nasty fixture corpus plus a
// deterministic fragment generator, and the registry wiring pins.

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeSwift } from "@utils/syntax/swift.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

// No "variable": swift identifiers have no sigils, and no "preproc": `#`
// is not a directive class here (the documented degrade).
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

describe("tokenizeSwift structure", () => {
  it("class declarations read cleanly; the arrow keeps its type reading", () => {
    expect(
      significant(tokenizeSwift("class Greeter: Base {\n  static let limit = 10\n  func greet(_ name: String) -> String { return \"hi\" }\n}")),
    ).toEqual([
      run("keyword", "class"),
      run("type", "Greeter"), // the declaration arm claims the name before the call peek
      run("operator", ":"),
      run("type", "Base"), // the Capitalized heuristic
      run("operator", "{"),
      run("keyword", "static"),
      run("keyword", "let"),
      run("default", "limit"),
      run("operator", "="),
      run("number", "10"),
      run("keyword", "func"),
      run("fn", "greet"), // prevFn (kotlin's shape) and the peek agree here
      run("operator", "("),
      run("default", "_"),
      run("default", "name"),
      run("operator", ":"),
      run("type", "String"), // no primitive set: Int/String are ordinary classes
      run("operator", ")"),
      run("operator", "->"), // the function arrow: a run, NOT a member position (java's ruling)
      run("type", "String"), // ...so the return type keeps its reading (the cpp contrast)
      run("operator", "{"),
      run("keyword", "return"),
      run("string", '"hi"'),
      run("operator", "}"),
      run("operator", "}"),
    ]);
    // The declaration keywords all arm the name; member position refuses it.
    expect(
      significant(tokenizeSwift("protocol Shape {}\nextension Shape: Codable {}\nactor Counter {}\ntypealias Handler = (Int) -> Void\nx.Int")),
    ).toEqual([
      run("keyword", "protocol"),
      run("type", "Shape"),
      run("operator", "{"),
      run("operator", "}"),
      run("keyword", "extension"),
      run("type", "Shape"),
      run("operator", ":"),
      run("type", "Codable"),
      run("operator", "{"),
      run("operator", "}"),
      run("keyword", "actor"),
      run("type", "Counter"),
      run("operator", "{"),
      run("operator", "}"),
      run("keyword", "typealias"),
      run("type", "Handler"),
      run("operator", "="),
      run("operator", "("),
      run("type", "Int"),
      run("operator", ")"),
      run("operator", "->"),
      run("type", "Void"), // `Void` is a Capitalized class name, honest via the heuristic
      run("default", "x"),
      run("operator", "."),
      run("default", "Int"), // member position: the Capitalized reading is refused
    ]);
  });

  it("fn readings: func, the init quirk, trailing closures honestly miss", () => {
    expect(significant(tokenizeSwift("func run() {}\ninit(name: String) {}\ninit?(rawValue: Int) { return nil }\ndeinit { cleanup() }\nfoo { print(\"x\") }"))).toEqual([
      run("keyword", "func"),
      run("fn", "run"), // the name after func (and the peek agrees)
      run("operator", "("),
      run("operator", ")"),
      run("operator", "{"),
      run("operator", "}"),
      run("fn", "init"), // init IS the member name: a paren takes fn over keyword (the pin)
      run("operator", "("),
      run("default", "name"),
      run("operator", ":"),
      run("type", "String"),
      run("operator", ")"),
      run("operator", "{"),
      run("operator", "}"),
      run("fn", "init"), // the failable `init?` takes it too (the peek runs past the mark)
      run("operator", "?"),
      run("operator", "("),
      run("default", "rawValue"),
      run("operator", ":"),
      run("type", "Int"),
      run("operator", ")"),
      run("operator", "{"),
      run("keyword", "return"),
      run("null", "nil"), // nil rides null (the spelling pin)
      run("operator", "}"),
      run("keyword", "deinit"), // not `init`: the keyword stands
      run("operator", "{"),
      run("fn", "cleanup"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", "}"),
      run("default", "foo"), // trailing closures get no fn reading (the ruby ceiling)
      run("operator", "{"),
      run("fn", "print"), // ...but parenthesized calls take it, as ever
      run("operator", "("),
      run("string", '"x"'),
      run("operator", ")"),
      run("operator", "}"),
    ]);
    // An `init` with no paren (a protocol requirement spelled bare, or a
    // reference) stays the keyword.
    expect(significant(tokenizeSwift("init required"))).toEqual([
      run("keyword", "init"),
      run("keyword", "required"),
    ]);
  });

  it("strings: interpolation inside the run, the hole closes single lines", () => {
    expect(significant(tokenizeSwift(String.raw`"a\(x)"`))).toEqual([run("string", String.raw`"a\(x)"`)]);
    // A quote inside an interpolation hole closes the literal, and the
    // hole's closing quote opens a fresh string over the tail (kotlin's
    // documented cost, identical here -- and `in` is a keyword in the tail).
    expect(significant(tokenizeSwift(String.raw`"a\("in")b"`))).toEqual([
      run("string", String.raw`"a\("`),
      run("keyword", "in"),
      run("string", String.raw`")b"`),
    ]);
    expect(significant(tokenizeSwift('"""two\nlines"""'))).toEqual([run("string", '"""two\nlines"""')]);
    // The multiline scan SKIPS backslash pairs (swift multiline processes
    // escapes): the escaped closer does NOT close (the opposite cost from
    // kotlin's raw scan, where a backslash is literal).
    expect(significant(tokenizeSwift(String.raw`"""a\"""b"""`))).toEqual([
      run("string", String.raw`"""a\"""b"""`),
    ]);
    expect(significant(tokenizeSwift('""""""'))).toEqual([run("string", '""""""')]); // the empty multiline
    // A lone quote never closes the triple, so holes inside multiline
    // strings survive (documented): one run over the whole thing.
    expect(significant(tokenizeSwift(String.raw`"""a\("x")b"""`))).toEqual([
      run("string", String.raw`"""a\("x")b"""`),
    ]);
    // The house splice/stop rules on ordinary literals.
    expect(significant(tokenizeSwift('"un\ntail'))).toEqual([run("string", '"un'), run("default", "tail")]);
    expect(significant(tokenizeSwift('"abc\\\ndef"'))).toEqual([run("string", '"abc\\\ndef"')]);
  });

  it("raw strings: N hashes glued, no escapes, single-line stops at the newline", () => {
    expect(significant(tokenizeSwift(String.raw`#"a\nb"#`))).toEqual([
      run("string", String.raw`#"a\nb"#`), // the backslash is raw: no escape consumption
    ]);
    expect(significant(tokenizeSwift('#"He said "hi""#'))).toEqual([
      run("string", '#"He said "hi""#'), // a bare quote cannot close it: only `"#` does
    ]);
    expect(significant(tokenizeSwift('##"a"##'))).toEqual([run("string", '##"a"##')]); // two-hash form
    expect(significant(tokenizeSwift('#""#'))).toEqual([run("string", '#""#')]); // the empty raw
    // The multiline raw form: hashes + triple quotes, closer + hashes.
    const ml = [String.raw`#"""`, "multi \\(x)", String.raw`"""#`].join("\n");
    expect(significant(tokenizeSwift(ml))).toEqual([run("string", ml)]);
    // The single-line raw stops at the newline like its interpreted cousin.
    expect(significant(tokenizeSwift('#"a\nb"#'))).toEqual([
      run("string", '#"a'),
      run("default", "b"),
      run("string", '"#'), // the tail re-opens an ordinary (unterminated) string
    ]);
    // The hashes must be GLUED to the quote: `# "x"` is not a raw string,
    // and there is no directive reading for `#` either (the documented
    // degrade of `#if` and friends).
    expect(significant(tokenizeSwift('# "x"'))).toEqual([run("default", "#"), run("string", '"x"')]);
    expect(significant(tokenizeSwift("#if DEBUG"))).toEqual([
      run("default", "#"), // no preproc class in this language
      run("keyword", "if"), // ...but the word after is still the ordinary keyword
      run("default", "DEBUG"),
    ]);
    expect(significant(tokenizeSwift("#available"))).toEqual([
      run("default", "#"),
      run("default", "available"),
    ]);
  });

  it("char literals: the java arm; failing shapes and apostrophes ride default", () => {
    expect(significant(tokenizeSwift("let c = 'x'"))).toEqual([
      run("keyword", "let"),
      run("default", "c"),
      run("operator", "="),
      run("string", "'x'"), // the tolerant single-quote reading (see the doc comment)
    ]);
    expect(significant(tokenizeSwift("'\\n' '\\u0041'"))).toEqual([
      run("string", "'\\n'"),
      run("string", "'\\u0041'"),
    ]);
    // Two chars is NOT a literal: the java rule, the quotes ride default.
    expect(significant(tokenizeSwift("'ab'"))).toEqual([
      run("default", "'"),
      run("default", "ab"),
      run("default", "'"),
    ]);
    // An apostrophe inside a word never eats the line.
    expect(significant(tokenizeSwift("don't"))).toEqual([
      run("default", "don"),
      run("default", "'"),
      run("default", "t"),
    ]);
    // The common typo `'''` does read as one literal, lossless either way
    // (the java/kotlin pin).
    expect(significant(tokenizeSwift("'''"))).toEqual([run("string", "'''")]);
  });

  it("annotations are one decorator run; at most one paren group; bare @ rides default", () => {
    expect(
      significant(tokenizeSwift('@escaping\n@available(*, deprecated, message: "x")\n@Foo("a)b")\n@Foo.Bar (x: 1)\n@State var count\n@\n@Foo("x')),
    ).toEqual([
      run("decorator", "@escaping"), // no group: just the glued name
      run("decorator", '@available(*, deprecated, message: "x")'),
      run("decorator", '@Foo("a)b")'), // the string is skipped: its `)` cannot cut the run short
      run("decorator", "@Foo.Bar (x: 1)"), // dotted names and whitespace before `(` (the java arm)
      run("decorator", "@State"),
      run("keyword", "var"),
      run("default", "count"),
      run("default", "@"), // unglued: plain
      run("decorator", '@Foo("x'), // unclosed argument group: end of input
    ]);
  });

  it("keywords are case-sensitive; nil rides null; Self rides the heuristic", () => {
    expect(
      significant(tokenizeSwift("true false TRUE False nil NIL self super Self guard defer where some any async await throws try init deinit let var; get set weak Int Void")),
    ).toEqual([
      run("boolean", "true"),
      run("boolean", "false"),
      run("default", "TRUE"),
      run("type", "False"), // the Capitalized heuristic, not the boolean reading
      run("null", "nil"),
      run("default", "NIL"),
      run("keyword", "self"),
      run("keyword", "super"),
      run("type", "Self"), // a type name in the grammar; the heuristic does it (documented)
      run("keyword", "guard"),
      run("keyword", "defer"),
      run("keyword", "where"),
      run("keyword", "some"),
      run("keyword", "any"),
      run("keyword", "async"),
      run("keyword", "await"),
      run("keyword", "throws"),
      run("keyword", "try"),
      run("keyword", "init"), // no paren follows: the keyword stands (see the fn pin)
      run("keyword", "deinit"),
      run("keyword", "let"),
      run("keyword", "var"),
      run("operator", ";"),
      run("default", "get"), // accessors ride default (kotlin's ruling)
      run("default", "set"),
      run("default", "weak"), // the property-attribute words ride default too
      run("type", "Int"), // no primitive set: ordinary Capitalized classes
      run("type", "Void"),
    ]);
  });

  it("numbers: the 0o reverse pin, the p-exponent, no suffix zoo, no leading dot", () => {
    expect(
      significant(tokenizeSwift("0 07 0xFF 0x1f 0o17 0b101 1_000 1.5 6.02e23 1.0e-3 0x1p3 0x1p-2 1u 0x 0o 0b 1_ 0b2 0o8 .5 1.2.3 1..<5 0X1 0xFF.bitWidth")),
    ).toEqual([
      run("number", "0"),
      run("number", "07"), // plain decimal, no octal semantics either way
      run("number", "0xFF"),
      run("number", "0x1f"),
      // THE REVERSE PIN: swift HAS the `0o` octal radix the
      // kotlin/groovy/dart batch had no word for.
      run("number", "0o17"),
      run("number", "0b101"),
      run("number", "1_000"), // `_` separators are real here
      run("number", "1.5"),
      run("number", "6.02e23"),
      run("number", "1.0e-3"),
      run("number", "0x1p3"), // hex float with p-exponent (decided: supported)
      run("number", "0x1p-2"),
      // NO suffix zoo: the number 1 plus the word u (the dart precedent).
      run("number", "1"),
      run("default", "u"),
      run("default", "0x"), // half-literals fail shape validation
      run("default", "0o"),
      run("default", "0b"),
      run("default", "1_"),
      run("default", "0b2"),
      run("default", "0o8"),
      run("operator", "."), // no leading-dot float: `.5` is a dot and a number
      run("number", "5"),
      run("number", "1.2"),
      run("operator", "."),
      run("number", "3"),
      run("number", "1"),
      run("operator", "..<"), // the half-open range wins the three-char check
      run("number", "5"),
      // hex is the lowercase `0x` spelling only: the number 0 plus the
      // word X1 (Capitalized-shaped, so type -- the dart precedent).
      run("number", "0"),
      run("type", "X1"),
      // The hex FRACTIONAL mantissa degrades... and that is what keeps
      // member access on hex literals reading right.
      run("number", "0xFF"),
      run("operator", "."),
      run("default", "bitWidth"),
    ]);
  });

  it("operators: ranges/??=/overflow family are runs; ?. sets dot; ?: and :: degrade", () => {
    expect(
      significant(tokenizeSwift("user?.name; x ?? y ??= z; r = 1...5; e = f &/ g; s &<< 2; v = a &+ b &- c")),
    ).toEqual([
      run("default", "user"),
      run("operator", "?."), // optional chaining IS a member position (the cs/kotlin ruling)
      run("default", "name"),
      run("operator", ";"),
      run("default", "x"),
      run("operator", "??"), // nil-coalescing: one run
      run("default", "y"),
      run("operator", "??="), // nil-assign: one three-char run
      run("default", "z"),
      run("operator", ";"),
      run("default", "r"),
      run("operator", "="),
      run("number", "1"),
      run("operator", "..."), // the closed range IS a run
      run("number", "5"),
      run("operator", ";"),
      run("default", "e"),
      run("operator", "="),
      run("default", "f"),
      run("operator", "&/"), // the overflow family ARE runs (spec override: real swift tokens)
      run("default", "g"),
      run("operator", ";"),
      run("default", "s"),
      run("operator", "&<<"),
      run("number", "2"),
      run("operator", ";"),
      run("default", "v"),
      run("operator", "="),
      run("default", "a"),
      run("operator", "&+"),
      run("default", "b"),
      run("operator", "&-"),
      run("default", "c"),
    ]);
    // The ternary rides plain singles; the elvis `?:` does NOT exist
    // (contrast kotlin's pin), and neither do `!!`, `=>`, `<-`, `::`,
    // `<=>` -- all degrade to their single-char pieces.
    expect(
      significant(tokenizeSwift("flag ? 1 : 2; q ?: z; p !! q; s => t; w <- 1; A::B; a <=> b")),
    ).toEqual([
      run("default", "flag"),
      run("operator", "?"),
      run("number", "1"),
      run("operator", ":"),
      run("number", "2"),
      run("operator", ";"),
      run("default", "q"),
      run("operator", "?"),
      run("operator", ":"),
      run("default", "z"),
      run("operator", ";"),
      run("default", "p"),
      run("operator", "!"),
      run("operator", "!"),
      run("default", "q"),
      run("operator", ";"),
      run("default", "s"),
      run("operator", "="),
      run("operator", ">"),
      run("default", "t"),
      run("operator", ";"),
      run("default", "w"),
      run("operator", "<"),
      run("operator", "-"),
      run("number", "1"),
      run("operator", ";"),
      run("type", "A"),
      run("operator", ":"),
      run("operator", ":"),
      run("type", "B"),
      run("operator", ";"),
      run("default", "a"),
      run("operator", "<="),
      run("operator", ">"),
      run("default", "b"),
    ]);
    // The postfix `?`/`!` ride plain singles, and the member dot still arms.
    expect(significant(tokenizeSwift("a?.b!.c"))).toEqual([
      run("default", "a"),
      run("operator", "?."),
      run("default", "b"),
      run("operator", "!"),
      run("operator", "."),
      run("default", "c"),
    ]);
  });

  it("comments: // (doc comments included), blocks NEST (the spec override)", () => {
    expect(significant(tokenizeSwift("/// doc\n// line\nx"))).toEqual([
      run("comment", "/// doc"), // swift's doc comments are ordinary line comments
      run("comment", "// line"),
      run("default", "x"),
    ]);
    // Swift DOES nest block comments (the grammar does, kotlin's shape):
    // the outer closer ends the run, not the inner one.
    expect(significant(tokenizeSwift("/* outer /* inner */ still */ tail"))).toEqual([
      run("comment", "/* outer /* inner */ still */"),
      run("default", "tail"),
    ]);
    expect(significant(tokenizeSwift("/* unclosed"))).toEqual([run("comment", "/* unclosed")]);
  });
});

describe("tokenizeSwift registry contract", () => {
  it("guesses and fences resolve through the registry", () => {
    expect(guessLangForBase("Main.swift")).toBe("swift");
    expect(guessLangForBase("MAIN.SWIFT")).toBe("swift"); // the extension index is case-insensitive
    expect(guessLangForBase("module.swiftinterface")).toBeUndefined(); // nothing else claimed
    expect(resolveSyntaxLang("swift")).toBe("swift");
    expect(resolveSyntaxLang("swiftlang")).toBeUndefined(); // no aliases: the fence word is the name
    expect(getTokenizer("swift")).toBe(tokenizeSwift);
  });
});

describe("tokenizeSwift losslessness", () => {
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
    '"""',
    '""""',
    '"""""',
    '""""""',
    '"""\\',
    String.raw`"""a\"""`,
    "'",
    "''",
    "'''",
    "''''",
    "#",
    '#"',
    '##"',
    '#"""',
    '#"""x',
    '#""#',
    '#"a\nb"#', // the newline stop, tail re-opening a string: lossless
    '##"a"#', // the short closer: unclosed to end of input
    '#if x',
    "$",
    String.raw`"\(`,
    String.raw`"\(x)`,
    String.raw`"a\("in")b"`,
    "...",
    "..<",
    "??=",
    "?.",
    "??",
    "&+",
    "&-",
    "&*",
    "&/",
    "&<<",
    "&>>",
    "->",
    "::",
    "<=>",
    "?:",
    "!!",
    "=>",
    "<-",
    "@",
    "@Foo(",
    '@Foo("\'',
    "0x",
    "0o",
    "0b",
    "0b2",
    "0o8",
    "1_",
    "1_000",
    "0x1p",
    ".5",
    "1.2.3",
    "1..<5",
    "TRUE False nil NIL",
    '"unterminated',
    "'unterminated",
    '"splice\\',
    "func",
    "init",
    "init?(",
    "Self",
    "guard",
    "🚀 emoji ünïcøde 漢字",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeSwift(input);
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
      '"""',
      '"""\n',
      String.raw`"""\"""`,
      "#",
      '#"',
      '##"',
      '#"""',
      '#""#',
      String.raw`#"a\nb"#`,
      String.raw`"\(`,
      String.raw`"\(x)"`,
      "@",
      "@Foo",
      "@Foo(",
      "class",
      "struct",
      "protocol",
      "extension",
      "actor",
      "typealias",
      "func",
      "init",
      "init?(",
      "deinit",
      "guard",
      "defer",
      "let",
      "var",
      "nil",
      "self",
      "Self",
      "true",
      "TRUE",
      "Int",
      "Widget",
      "MAX_SIZE",
      "1",
      "0x",
      "0o",
      "0b",
      "0o17",
      "1_",
      "1_2",
      "0x1p3",
      ".5",
      "...",
      "..<",
      "?.",
      "??",
      "??=",
      "&+",
      "&-",
      "&/",
      "&<<",
      "->",
      "::",
      "<=>",
      "?:",
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
      const runs = tokenizeSwift(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("swift tokenizer wiring", () => {
  it("getTokenizer resolves swift to tokenizeSwift and classifies a sample", () => {
    const doc = [
      "// greeting service",
      "import Foundation",
      "",
      '@available(*, deprecated, message: "use Greeter")',
      "class Greeter: Base {",
      "  static let limit = 10",
      "",
      "  // pipeline",
      "  func greet(_ name: String) async throws -> String {",
      '    return "hi \\(name)!"',
      "  }",
      "}",
    ].join("\n");
    const runs = getTokenizer("swift")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual([
      "// greeting service",
      "// pipeline",
    ]);
    expect(runs.filter((r) => r.type === "decorator").map((r) => r.text)).toEqual([
      '@available(*, deprecated, message: "use Greeter")',
    ]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "import",
      "class",
      "static",
      "let",
      "func",
      "async",
      "throws",
      "return",
    ]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual(["greet"]);
    // `limit` is a lowercase property name and the annotation's arguments
    // ride the decorator run whole.
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual([
      "Foundation",
      "Greeter",
      "Base",
      "String",
      "String",
    ]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual(["10"]);
    // The annotation's argument string rides the decorator run (skipped,
    // not re-classified); the interpolation hole stays inside the return
    // literal (the rust ruling).
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual([
      '"hi \\(name)!"',
    ]);
  });
});
