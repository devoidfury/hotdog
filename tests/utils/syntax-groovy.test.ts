// Unit tests for the Groovy tokenizer (src/utils/syntax/groovy.ts): typed
// runs with exact classes and spans over targeted fixtures (the `//` line
// comment that DOES transfer from java -- the slashy-string ride is about
// lone slashes, not the double one -- triple-quoted strings of both quote
// spellings scanning to the first closer, single-quoted Strings with no
// char-literal rule in sight, the def-keyword name that needs no prevFn
// because the call peek already claims it, the big-number suffix zoo, and
// the ruby-family operator list with the `<=>` rejection pinned), a
// losslessness sweep over a nasty fixture corpus plus a deterministic
// fragment generator, and the registry wiring pins (.groovy/.gradle and
// the Jenkinsfile basename now resolve through the registry).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeGroovy } from "@utils/syntax/groovy.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

// No "variable": groovy code has no sigils (interpolation lives inside
// strings; a bare `$` rides default).
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

describe("tokenizeGroovy structure", () => {
  it("class/def declarations read cleanly; the method name comes from the call peek", () => {
    expect(
      significant(tokenizeGroovy('class Greeter extends Base {\n  def greet(name) {\n    return "hi $name!"\n  }\n}')),
    ).toEqual([
      run("keyword", "class"),
      run("type", "Greeter"), // the declaration arm claims the name before the call peek
      run("keyword", "extends"),
      run("type", "Base"),
      run("operator", "{"),
      run("keyword", "def"),
      run("fn", "greet"), // `def name(` needs no prevFn: groovy insists on the parens, the peek sees them
      run("operator", "("),
      run("default", "name"),
      run("operator", ")"),
      run("operator", "{"),
      run("keyword", "return"),
      run("string", '"hi $name!"'), // interpolation stays inside the run
      run("operator", "}"),
      run("operator", "}"),
    ]);
    // A `def x` PROPERTY name gets no fn reading (there is no paren to
    // peek), honestly: ruby's prevFn arm would only misfire here.
    expect(significant(tokenizeGroovy("def x = 1"))).toEqual([
      run("keyword", "def"),
      run("default", "x"),
      run("operator", "="),
      run("number", "1"),
    ]);
    // trait rides the declaration arm; the Jenkinsfile DSL shape is all
    // trailing closures, which take no fn reading (ruby's optional-parens
    // ceiling, same honest miss).
    expect(
      significant(
        tokenizeGroovy("trait Flyable\ntask {\n  stage('Build') {\n    sh 'make' // compile\n  }\n}"),
      ),
    ).toEqual([
      run("keyword", "trait"),
      run("type", "Flyable"),
      run("default", "task"), // no parens: honest miss
      run("operator", "{"),
      run("fn", "stage"),
      run("operator", "("),
      run("string", "'Build'"), // single quotes are full Strings
      run("operator", ")"),
      run("operator", "{"),
      run("default", "sh"),
      run("string", "'make'"),
      run("comment", "// compile"),
      run("operator", "}"),
      run("operator", "}"),
    ]);
  });

  it("comments: // exists (java grammar), blocks never nest, slashy rides plain", () => {
    expect(significant(tokenizeGroovy("// line\n/* block */ x"))).toEqual([
      run("comment", "// line"), // groovy HAS // line comments; the plan draft's ruby transfer was rejected
      run("comment", "/* block */"),
      run("default", "x"),
    ]);
    // Groovy block comments do NOT nest (unlike kotlin): the inner closer
    // ends the run.
    expect(significant(tokenizeGroovy("/* outer /* inner */ still */ tail"))).toEqual([
      run("comment", "/* outer /* inner */"),
      run("default", "still"),
      run("operator", "*"),
      run("operator", "/"),
      run("default", "tail"),
    ]);
    // `///` reads as a comment (the documented cost: the real lexer sees a
    // triple-slashy string there, but display says comment, as the code
    // mostly means anyway).
    expect(significant(tokenizeGroovy("///x///\ntail"))).toEqual([
      run("comment", "///x///"),
      run("default", "tail"),
    ]);
    // Slashy strings and regexes ride plain: `/` is never a comment and
    // its body scans as ordinary code (the ruby ruling).
    expect(significant(tokenizeGroovy("x =~ /re/ y; a = b / c / d"))).toEqual([
      run("default", "x"),
      run("operator", "=~"), // the matcher IS an operator run
      run("operator", "/"),
      run("default", "re"),
      run("operator", "/"),
      run("default", "y"),
      run("operator", ";"),
      run("default", "a"),
      run("operator", "="),
      run("default", "b"),
      run("operator", "/"), // division: plain
      run("default", "c"),
      run("operator", "/"),
      run("default", "d"),
    ]);
  });

  it("strings: interpolation inside the run, both triple spellings, no char literals", () => {
    expect(significant(tokenizeGroovy('"a$b" "${x}" \'#{}\''))).toEqual([
      run("string", '"a$b"'), // the hole stays inside (the php ruling)
      run("string", '"${x}"'),
      run("string", "'#{}'"), // single quotes do not interpolate; no special case needed
    ]);
    // Triple-quoted multiline forms (both quotes) scan to the closer.
    expect(significant(tokenizeGroovy('"""two\nlines $x"""'))).toEqual([run("string", '"""two\nlines $x"""')]);
    expect(significant(tokenizeGroovy("'''two\nlines'''"))).toEqual([run("string", "'''two\nlines'''")]);
    // `''` is the empty String; `'''` opens a triple that never closes and
    // runs to end of input (the documented first-closer cost).
    expect(significant(tokenizeGroovy("'' "))).toEqual([run("string", "''")]);
    expect(significant(tokenizeGroovy("'''"))).toEqual([run("string", "'''")]);
    // NO char literals in the java sense: `'ab'` is one string run, and
    // escapes work in BOTH quote forms, so `'it's'` splices... honestly,
    // the escape keeps it one run.
    expect(significant(tokenizeGroovy(String.raw`'ab' 'it\'s'`))).toEqual([
      run("string", "'ab'"),
      run("string", String.raw`'it\'s'`),
    ]);
    // A quote inside an interpolation hole closes the literal, and the
    // hole's closing quote opens a fresh string over the tail (kotlin's
    // documented cost, identical here).
    expect(significant(tokenizeGroovy('x = "${"in"}b" c'))).toEqual([
      run("default", "x"),
      run("operator", "="),
      run("string", '"${"'),
      run("keyword", "in"),
      run("string", '"}b"'),
      run("default", "c"),
    ]);
    // The house splice/stop rules on ordinary literals.
    expect(significant(tokenizeGroovy('"un\ntail'))).toEqual([run("string", '"un'), run("default", "tail")]);
    expect(significant(tokenizeGroovy('"abc\\\ndef"'))).toEqual([run("string", '"abc\\\ndef"')]);
  });

  it("annotations are one decorator run; single-quoted args skip as strings, not chars", () => {
    expect(
      significant(
        tokenizeGroovy('@Override\n@Target({ElementType.FIELD})\n@Named("a)b")\n@Tag(\'x)y\')\n@Test (timeout = 100)\n@Entity x\n@\n@[x]'),
      ),
    ).toEqual([
      run("decorator", "@Override"),
      run("decorator", "@Target({ElementType.FIELD})"),
      run("decorator", '@Named("a)b")'), // the string is skipped: its `)` cannot cut the run short
      run("decorator", "@Tag('x)y')"), // groovy has no char literals: the single-quoted arg skips as a string
      run("decorator", "@Test (timeout = 100)"), // the grammar allows whitespace before `(`
      run("decorator", "@Entity"), // no group: just the glued name
      run("default", "x"),
      run("default", "@"), // unglued: plain
      run("default", "@"),
      run("operator", "["),
      run("default", "x"),
      run("operator", "]"),
    ]);
    // Dotted annotations ride one run (the java arm, verbatim).
    expect(significant(tokenizeGroovy("@groovy.transform.CompileStatic\nclass C"))).toEqual([
      run("decorator", "@groovy.transform.CompileStatic"),
      run("keyword", "class"),
      run("type", "C"), // single letter IS Capitalized by the heuristic
    ]);
    // Unclosed argument group: runs to end of input.
    expect(significant(tokenizeGroovy('@Foo("a") @Bar("x'))).toEqual([
      run("decorator", '@Foo("a")'),
      run("decorator", '@Bar("x'),
    ]);
  });

  it("keywords are case-sensitive: TRUE/NULL are plain words; var is not a keyword at all", () => {
    expect(
      significant(tokenizeGroovy("true false null TRUE NULL False def trait in as instanceof var int void")),
    ).toEqual([
      run("boolean", "true"),
      run("boolean", "false"),
      run("null", "null"),
      run("default", "TRUE"),
      run("default", "NULL"),
      run("type", "False"), // the Capitalized heuristic, not the boolean reading
      run("keyword", "def"),
      run("keyword", "trait"),
      run("keyword", "in"),
      run("keyword", "as"),
      run("keyword", "instanceof"),
      run("default", "var"), // groovy has NO var keyword: plain word, honest
      run("type", "int"), // the java primitive spellings transfer
      run("type", "void"),
    ]);
  });

  it("numbers: NO octal, the big-number suffix zoo; half-literals distrust; no 0o, no .5", () => {
    expect(
      significant(
        tokenizeGroovy("10 1_000 0xFF_FF 0777 0778 0b10_1 6.02e23 1.5 42L 1.5f 3.14d 123G 7i 1.2BD 1.2bd 0 0x 1_ 0b2 0o7 .5 1.2.3 1..2 1..<3 1bd2"),
      ),
    ).toEqual([
      run("number", "10"),
      run("number", "1_000"),
      run("number", "0xFF_FF"),
      // groovy's legacy leading-zero octal was deprecated and removed, and
      // the class is number either way: `0777` reads as a plain decimal
      // (the cs ruling), and so does `0778`, which the old lexer rejected.
      run("number", "0777"),
      run("number", "0778"),
      run("number", "0b10_1"),
      run("number", "6.02e23"),
      run("number", "1.5"),
      run("number", "42L"),
      run("number", "1.5f"),
      run("number", "3.14d"),
      run("number", "123G"), // BigInteger
      run("number", "7i"), // BigInteger (Groovy 3+)
      run("number", "1.2BD"), // BigDecimal
      run("number", "1.2bd"),
      run("number", "0"),
      run("default", "0x"),
      run("default", "1_"),
      run("default", "0b2"), // the radix scan eats the `2`, the shape check distrusts the whole run
      // no `0o` radix: the number 0 followed by the word o7 (java's pin).
      run("number", "0"),
      run("default", "o7"),
      run("operator", "."), // no leading-dot float: `.5` is a dot and a number
      run("number", "5"),
      run("number", "1.2"),
      run("operator", "."),
      run("number", "3"),
      run("number", "1"),
      run("operator", ".."), // the inclusive range IS an operator run
      run("number", "2"),
      run("number", "1"),
      run("operator", "..<"), // the exclusive range (4.0) IS a three-char run
      run("number", "3"),
      // The ill-formed suffix tail is declined: `1` keeps its number and
      // `bd2` rides as the ordinary word.
      run("number", "1"),
      run("default", "bd2"),
    ]);
  });

  it("operators: elvis/ranges/matchers/** are runs; :: and ?. set dot; <=>, =>, ?? degrade", () => {
    expect(
      significant(tokenizeGroovy("x ?: y; s ==~ /re/; t !~ u; 2 ** 3; o?.trim(); Foo::bar; f = { -> true }")),
    ).toEqual([
      run("default", "x"),
      run("operator", "?:"), // the elvis IS one run (groovy's signature)
      run("default", "y"),
      run("operator", ";"),
      run("default", "s"),
      run("operator", "==~"), // find-all: one three-char run
      run("operator", "/"),
      run("default", "re"),
      run("operator", "/"),
      run("operator", ";"),
      run("default", "t"),
      run("operator", "!~"),
      run("default", "u"),
      run("operator", ";"),
      run("number", "2"),
      run("operator", "**"), // power: one run
      run("number", "3"),
      run("operator", ";"),
      run("default", "o"),
      run("operator", "?."), // safe navigation IS a member position (the cs ruling)
      run("fn", "trim"), // the call peek survives the safe call
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("type", "Foo"),
      run("operator", "::"), // method refs (Groovy 3+) ARE a member position
      run("default", "bar"),
      run("operator", ";"),
      run("default", "f"),
      run("operator", "="),
      run("operator", "{"),
      run("operator", "->"),
      run("boolean", "true"), // the closure arrow is NOT member access (java's ruling)
      run("operator", "}"),
    ]);
    // The compound accessors get no runs of their own and decompose (the
    // member dot still sets the flag, so `name` reads as a member):
    // `*.` spread and the null-aware `?..`/`?*.` spellings.
    expect(significant(tokenizeGroovy("p*.name; q?..r; s?*.t"))).toEqual([
      run("default", "p"),
      run("operator", "*"),
      run("operator", "."),
      run("default", "name"),
      run("operator", ";"),
      run("default", "q"),
      run("operator", "?."), // the safe call wins the maximal munch over the range
      run("operator", "."),
      run("default", "r"),
      run("operator", ";"),
      run("default", "s"),
      run("operator", "?"),
      run("operator", "*"),
      run("operator", "."),
      run("default", "t"),
    ]);
    // `<=>` is NOT a groovy operator (compareTo is a METHOD, not a
    // spelling: ruby/php have the run, groovy degrades to `<=` plus `>`);
    // `=>` and `??` do not exist either.
    expect(significant(tokenizeGroovy("a <=> b; x => y; z ?? w"))).toEqual([
      run("default", "a"),
      run("operator", "<="),
      run("operator", ">"),
      run("default", "b"),
      run("operator", ";"),
      run("default", "x"),
      run("operator", "="),
      run("operator", ">"),
      run("default", "y"),
      run("operator", ";"),
      run("default", "z"),
      run("operator", "?"),
      run("operator", "?"),
      run("default", "w"),
    ]);
    // After a member gesture every reading but the call peek is refused.
    expect(significant(tokenizeGroovy("a.int; x?.true; Foo.CONST"))).toEqual([
      run("default", "a"),
      run("operator", "."),
      run("default", "int"), // member position: the primitive reading is refused
      run("operator", ";"),
      run("default", "x"),
      run("operator", "?."),
      run("default", "true"), // member position: the boolean reading is refused
      run("operator", ";"),
      run("type", "Foo"),
      run("operator", "."),
      run("default", "CONST"),
    ]);
  });

  it("dollar signs outside strings ride plain", () => {
    expect(significant(tokenizeGroovy("$ $\n$$ $/x/$"))).toEqual([
      run("default", "$"),
      run("default", "$"),
      run("default", "$"),
      run("default", "$"),
      run("default", "$"),
      run("operator", "/"), // dollar-slashy gets no arm: the body scans as code
      run("default", "x"),
      run("operator", "/"),
      run("default", "$"),
    ]);
  });
});

describe("tokenizeGroovy registry contract", () => {
  it("guesses and fences resolve through the registry", () => {
    expect(guessLangForBase("build.gradle")).toBe("groovy");
    expect(guessLangForBase("Settings.GROOVY")).toBe("groovy");
    // The Jenkinsfile basename: bare, case-insensitive, and variant-spelled.
    expect(guessLangForBase("Jenkinsfile")).toBe("groovy");
    expect(guessLangForBase("Jenkinsfile.lib")).toBe("groovy");
    expect(guessLangForBase("jenkinsfile.dev")).toBe("groovy");
    expect(resolveSyntaxLang("groovy")).toBe("groovy");
    expect(resolveSyntaxLang("gradle")).toBeUndefined(); // an extension is not an alias
    expect(getTokenizer("groovy")).toBe(tokenizeGroovy);
  });
});

describe("tokenizeGroovy losslessness", () => {
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
    "///",
    "'''",
    "''",
    "'''''",
    "''''''",
    '"""',
    '""""',
    '"""""',
    "'\\'",
    '"splice\\',
    "@",
    "@[",
    "@Foo(",
    '@Foo("\'",',
    "$",
    "${",
    "$/",
    "?:",
    "?..",
    "?*.",
    "*.",
    "==~",
    "=~",
    "!~",
    "..<",
    "...",
    "<=>",
    "**",
    "0777",
    "0778",
    "0o7",
    "1bd",
    "1bd2",
    "1.2BD",
    "0x",
    "1_",
    "0b",
    "0b2",
    ".5",
    "1..2",
    "1.2.3",
    "TRUE False",
    '"unterminated',
    "'unterminated",
    "def",
    "trait",
    "as",
    "var",
    "🚀 emoji ünïcøde 漢字",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeGroovy(input);
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
      "'''\n",
      '"""',
      '"""\n',
      "@",
      "@Foo",
      "@Foo(",
      "def",
      "class",
      "trait",
      "extends",
      "true",
      "null",
      "TRUE",
      "int",
      "var",
      "Widget",
      "MAX_SIZE",
      "1",
      "0x",
      "1_",
      "1_2",
      "0777",
      "0o7",
      "42L",
      "1.2BD",
      "1bd2",
      ".5",
      "..",
      "..<",
      "->",
      "::",
      "?.",
      "?:",
      "=~",
      "==~",
      "<=>",
      "**",
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
      "$",
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
      const runs = tokenizeGroovy(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("groovy tokenizer wiring", () => {
  it("getTokenizer resolves groovy to tokenizeGroovy and classifies a sample", () => {
    const doc = [
      "// greeting service",
      "@groovy.transform.CompileStatic",
      "class Greeter extends Base implements Wire {",
      "    static final LIMIT = 10",
      "",
      "    def greet(name) {",
      '        return "hi $name!" // pipeline',
      "    }",
      "}",
    ].join("\n");
    const runs = getTokenizer("groovy")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual([
      "// greeting service",
      "// pipeline",
    ]);
    expect(runs.filter((r) => r.type === "decorator").map((r) => r.text)).toEqual([
      "@groovy.transform.CompileStatic",
    ]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "class",
      "extends",
      "implements",
      "static",
      "final",
      "def",
      "return",
    ]);
    // The method name rides fn through the call peek (`def greet(`); the
    // parameter and the all-caps constant ride default.
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual(["greet"]);
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual(["Greeter", "Base", "Wire"]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual(["10"]);
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual(['"hi $name!"']);
  });
});
