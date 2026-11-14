// Unit tests for the Ruby tokenizer (src/utils/syntax/ruby.ts): typed runs
// with exact classes and spans over targeted fixtures (symbols riding
// "string" versus the ternary mark, heredocs with per-spelling closer
// tolerance, the position-armed =begin/=end block, `?x` char literals with
// the language's own boundary, identifiers absorbing a glued `?`/`!` tail,
// case-sensitive keywords, and the number dialect where legacy `0NNN` IS
// octal), a losslessness sweep over a nasty fixture corpus plus a
// deterministic fragment generator, and the registry wiring pins (.rb now
// resolves through the registry).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeRuby } from "@utils/syntax/ruby.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

// No "decorator": ruby has no attributes, and this tokenizer never emits
// that class ("variable" is php's class, claimed here for @/@@/$ names).
const TYPES = new Set([
  "comment",
  "string",
  "variable",
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

describe("tokenizeRuby structure", () => {
  it("class/module declarations, def names, and member bodies read cleanly", () => {
    expect(
      significant(
        tokenizeRuby("class Greeter < Base\n  def initialize(name)\n    @name = name\n  end\nend"),
      ),
    ).toEqual([
      run("keyword", "class"),
      run("type", "Greeter"), // the declaration arm claims the name before the call peek
      run("operator", "<"), // inheritance is a plain operator; there is no extends keyword
      run("type", "Base"),
      run("keyword", "def"),
      run("fn", "initialize"), // prevFn (php's `function` shape): the name after def
      run("operator", "("),
      run("default", "name"),
      run("operator", ")"),
      run("variable", "@name"),
      run("operator", "="),
      run("default", "name"),
      run("keyword", "end"),
      run("keyword", "end"),
    ]);
    // `def self.foo(` reaches fn through the dot (the call peek survives
    // it); module names ride the declaration arm too.
    expect(significant(tokenizeRuby("module App\n  def self.foo(x)\n  end\nend"))).toEqual([
      run("keyword", "module"),
      run("type", "App"),
      run("keyword", "def"),
      run("keyword", "self"), // self rides keyword (the ruling), not default
      run("operator", "."),
      run("fn", "foo"),
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
      run("keyword", "end"),
      run("keyword", "end"),
    ]);
    // Ruby's call parens are optional: a bare `puts x` gets NO fn reading,
    // honestly; `defined?` lands as a keyword via the trailing-mark scan.
    expect(significant(tokenizeRuby("def greet\n  puts 'hi'\nend\ndefined?(x)"))).toEqual([
      run("keyword", "def"),
      run("fn", "greet"), // no `(` follows: prevFn claims it
      run("default", "puts"), // optional parens: no call peek to take
      run("string", "'hi'"),
      run("keyword", "end"),
      run("keyword", "defined?"),
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
    ]);
  });

  it("symbols ride string; the ternary mark and scope resolution stay operators", () => {
    expect(
      significant(tokenizeRuby("h = { name: 'x', :age => 3 }\nitems.map(&:upcase)")),
    ).toEqual([
      run("default", "h"),
      run("operator", "="),
      run("operator", "{"),
      run("default", "name"),
      run("operator", ":"), // `name:` needs air to its right: the ternary-style mark rides operator
      run("string", "'x'"),
      run("operator", ","),
      run("string", ":age"), // a `:` glued to a name is a symbol
      run("operator", "=>"), // the hash rocket IS an operator run (unlike java/cs)
      run("number", "3"),
      run("operator", "}"),
      run("default", "items"),
      run("operator", "."),
      run("fn", "map"),
      run("operator", "("),
      run("operator", "&:"), // to-proc: one operator run
      run("default", "upcase"),
      run("operator", ")"),
    ]);
    // Quoted symbols and a symbol's own trailing ?/! ride the whole run.
    expect(significant(tokenizeRuby(':"a b" :sym? :bang! :'))).toEqual([
      run("string", ':"a b"'),
      run("string", ":sym?"),
      run("string", ":bang!"),
      run("operator", ":"), // a trailing lone colon is air on both sides: plain
    ]);
    // `case`/`when`/`then` keywords, symbols as branch values.
    expect(significant(tokenizeRuby("case x\nwhen 1 then :one\nelse :other\nend"))).toEqual([
      run("keyword", "case"),
      run("default", "x"),
      run("keyword", "when"),
      run("number", "1"),
      run("keyword", "then"),
      run("string", ":one"),
      run("keyword", "else"),
      run("string", ":other"),
      run("keyword", "end"),
    ]);
    // The glued ternary cost (documented): `a ? b :c` reads `:c` as a
    // symbol -- ruby itself warns on this spelling.
    expect(significant(tokenizeRuby("a ? b :c"))).toEqual([
      run("default", "a"),
      run("operator", "?"),
      run("default", "b"),
      run("string", ":c"),
    ]);
  });

  it("char literals take the boundary rule; predicates absorb ?/!, != never does", () => {
    expect(significant(tokenizeRuby("a ? b : c\nputs list.empty?, ?x"))).toEqual([
      run("default", "a"),
      run("operator", "?"), // spaced: the ternary mark
      run("default", "b"),
      run("operator", ":"),
      run("default", "c"),
      run("default", "puts"),
      run("default", "list"),
      run("operator", "."),
      run("default", "empty?"), // the glued `?` tail joins the word
      run("operator", ","),
      run("string", "?x"), // char literal: one char, then air
    ]);
    // The language's own boundary: `?foo` is NOT a literal (an identifier
    // char follows), so the `?` keeps its operator reading -- the glued
    // one-letter `cond ?y : bar` washes as a char literal, which ruby
    // itself calls ambiguous.
    expect(significant(tokenizeRuby("cond ?foo : bar"))).toEqual([
      run("default", "cond"),
      run("operator", "?"),
      run("default", "foo"),
      run("operator", ":"),
      run("default", "bar"),
    ]);
    expect(significant(tokenizeRuby("cond ?y : bar"))).toEqual([
      run("default", "cond"),
      run("string", "?y"),
      run("operator", ":"),
      run("default", "bar"),
    ]);
    // Escapes ride the java endOfCharLiteral shape; `!=` is never absorbed.
    expect(significant(tokenizeRuby(String.raw`?\n ?\\ ?\u0041 foo! foo!=bar`))).toEqual([
      run("string", String.raw`?\n`),
      run("string", String.raw`?\\`),
      run("string", String.raw`?\u0041`),
      run("default", "foo!"), // the glued `!` tail joins the word
      run("default", "foo"), // `!=` is the operator, not a bang method
      run("operator", "!="),
      run("default", "bar"),
    ]);
  });

  it("strings: interpolation inside the run, splice, unterminated stops at the newline", () => {
    expect(significant(tokenizeRuby('"hi #{name}!" \'#{}\''))).toEqual([
      run("string", '"hi #{name}!"'), // the hole stays inside (the rust format-string ruling)
      run("string", "'#{}'"), // single quotes do not interpolate; no special case needed
    ]);
    // A quote inside a hole closes the literal (the holes are not parsed):
    // documented cost, lossless either way.
    expect(significant(tokenizeRuby('x = "a#{"in"}b" c'))).toEqual([
      run("default", "x"),
      run("operator", "="),
      run("string", '"a#{"'),
      run("keyword", "in"),
      run("string", '"}b"'),
      run("default", "c"),
    ]);
    // An unterminated literal stops at the newline; a backslash before it
    // splices the line (the c.ts endOfString).
    expect(significant(tokenizeRuby('"un\ntail'))).toEqual([run("string", '"un'), run("default", "tail")]);
    expect(significant(tokenizeRuby('"abc\\\ndef"'))).toEqual([run("string", '"abc\\\ndef"')]);
    expect(significant(tokenizeRuby(String.raw`'it\'s'`))).toEqual([run("string", String.raw`'it\'s'`)]);
  });

  it("heredocs: marker-tolerant closers, bare column-0, quoted labels, shifts stay shifts", () => {
    expect(significant(tokenizeRuby("x = <<~TEXT\n  hi #{n}\n  TEXT\nputs x"))).toEqual([
      run("default", "x"),
      run("operator", "="),
      run("string", "<<~TEXT\n  hi #{n}\n  TEXT"), // the indented closer satisfies `<<~`
      run("default", "puts"),
      run("default", "x"),
    ]);
    // The bare spelling demands the closer at column 0 (as the language
    // does); an indented `EOS` never closes and the run swallows the rest.
    expect(significant(tokenizeRuby("y = <<EOS\nno indent\nEOS\ntail"))).toEqual([
      run("default", "y"),
      run("operator", "="),
      run("string", "<<EOS\nno indent\nEOS"),
      run("default", "tail"),
    ]);
    expect(significant(tokenizeRuby("z = <<EOS\n a\n  EOS\nb"))).toEqual([
      run("default", "z"),
      run("operator", "="),
      run("string", "<<EOS\n a\n  EOS\nb"),
    ]);
    // Quoted labels ride the same scan (the body is never re-classified).
    expect(significant(tokenizeRuby("s = <<'RAW'\n#{x}\nRAW\n"))).toEqual([
      run("default", "s"),
      run("operator", "="),
      run("string", "<<'RAW'\n#{x}\nRAW"),
    ]);
    // `<<` with air is the shift: no glued label, the operator arm eats it.
    expect(significant(tokenizeRuby("a << b"))).toEqual([
      run("default", "a"),
      run("operator", "<"),
      run("operator", "<"),
      run("default", "b"),
    ]);
    // No closer anywhere runs to end of input.
    expect(significant(tokenizeRuby("q = <<DONE\nmore"))).toEqual([
      run("default", "q"),
      run("operator", "="),
      run("string", "<<DONE\nmore"),
    ]);
  });

  it("=begin/=end: line-armed block, indented closer, mid-line is equals-keyword", () => {
    expect(significant(tokenizeRuby("=begin\nmulti\n=end\nx"))).toEqual([
      run("comment", "=begin\nmulti\n=end"),
      run("default", "x"),
    ]);
    // The closer scan tolerates indent (the language itself is stricter).
    expect(significant(tokenizeRuby("=begin\n a\n  =end\ny"))).toEqual([
      run("comment", "=begin\n a\n  =end"),
      run("default", "y"),
    ]);
    // Position-armed like c.ts's `#`: any significant token spends it, so
    // `x =begin` reads equals-then-`begin` keyword.
    expect(significant(tokenizeRuby("x =begin"))).toEqual([
      run("default", "x"),
      run("operator", "="),
      run("keyword", "begin"),
    ]);
    // The word-boundary check: `=beginner` is the ordinary word.
    expect(significant(tokenizeRuby("=beginner x"))).toEqual([
      run("operator", "="),
      run("default", "beginner"),
      run("default", "x"),
    ]);
    expect(significant(tokenizeRuby("=end"))).toEqual([run("operator", "="), run("keyword", "end")]);
    expect(significant(tokenizeRuby("=begin\nx"))).toEqual([run("comment", "=begin\nx")]);
  });

  it("comments: # only -- a slash never opens one (regexes ride plain operators)", () => {
    expect(significant(tokenizeRuby("# line\ntail"))).toEqual([
      run("comment", "# line"),
      run("default", "tail"),
    ]);
    // No `//` comment in ruby, so no regex-vs-division puzzle either:
    // `/` is always an operator and a regex body scans as code.
    expect(significant(tokenizeRuby("a =~ /re/ b !~ c"))).toEqual([
      run("default", "a"),
      run("operator", "=~"),
      run("operator", "/"),
      run("default", "re"),
      run("operator", "/"),
      run("default", "b"),
      run("operator", "!~"),
      run("default", "c"),
    ]);
    // %-literals get no arm either.
    expect(significant(tokenizeRuby("%w[a b]"))).toEqual([
      run("operator", "%"),
      run("default", "w"),
      run("operator", "["),
      run("default", "a"),
      run("default", "b"),
      run("operator", "]"),
    ]);
  });

  it("keywords are case-sensitive: TRUE/NULL are plain words; nil rides null", () => {
    expect(
      significant(
        tokenizeRuby("true false nil TRUE NULL False Nil nil? self Self __LINE__ BEGIN"),
      ),
    ).toEqual([
      run("boolean", "true"),
      run("boolean", "false"),
      run("null", "nil"),
      run("default", "TRUE"),
      run("default", "NULL"),
      run("type", "False"), // the Capitalized heuristic, not the boolean reading
      run("type", "Nil"), // same: only lowercase `nil` is null
      run("default", "nil?"), // the absorbed predicate is a method, not the keyword
      run("keyword", "self"), // self/super/yield ride keyword (the ruling)
      run("type", "Self"),
      run("keyword", "__LINE__"),
      run("keyword", "BEGIN"),
    ]);
  });

  it("numbers: legacy octal IS octal, 0o, separators, r/i suffixes; half-literals distrust; no .5", () => {
    expect(
      significant(
        tokenizeRuby("10 1_000 0xFF_FF 0777 0778 0o7 0b10_1 6.02e23 1.0e-3 1.5 3r 2i 0 0x 1_ 0o8 .5 1.2.3 1..2 1 if"),
      ),
    ).toEqual([
      run("number", "10"),
      run("number", "1_000"),
      run("number", "0xFF_FF"),
      // ruby octal is BOTH `0oNNN` and the legacy `0NNN` (unlike C#), so
      // `0778` is invalid octal and distrusts back to default, as in php.
      run("number", "0777"),
      run("default", "0778"),
      run("number", "0o7"),
      run("number", "0b10_1"),
      run("number", "6.02e23"),
      run("number", "1.0e-3"),
      run("number", "1.5"),
      run("number", "3r"), // rational suffix
      run("number", "2i"), // imaginary suffix
      run("number", "0"),
      run("default", "0x"),
      run("default", "1_"),
      run("default", "0o8"),
      run("operator", "."), // ruby requires a digit before the dot: `.5` is a dot and a number
      run("number", "5"),
      run("number", "1.2"),
      run("operator", "."),
      run("number", "3"),
      run("number", "1"),
      run("operator", ".."), // the range IS an operator run
      run("number", "2"),
      run("number", "1"), // the r/i suffix needs glue: `1 if` keeps its keyword
      run("keyword", "if"),
    ]);
  });

  it("operators: => <=> ** .. ... &: -> are runs; :: sets dot, -> does not", () => {
    expect(
      significant(tokenizeRuby("a => b\na <=> b\nf = ->(x) { x ** 2 }\nh[:k] = v if n > 3 && !done?")),
    ).toEqual([
      run("default", "a"),
      run("operator", "=>"),
      run("default", "b"),
      run("default", "a"),
      run("operator", "<=>"),
      run("default", "b"),
      run("default", "f"),
      run("operator", "="),
      run("operator", "->"),
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
      run("operator", "{"),
      run("default", "x"),
      run("operator", "**"),
      run("number", "2"),
      run("operator", "}"),
      run("default", "h"),
      run("operator", "["),
      run("string", ":k"),
      run("operator", "]"),
      run("operator", "="),
      run("default", "v"),
      run("keyword", "if"),
      run("default", "n"),
      run("operator", ">"),
      run("number", "3"),
      run("operator", "&&"),
      run("operator", "!"),
      run("default", "done?"),
    ]);
    // The stabby lambda is NOT member access (java's ruling): the boolean
    // after it keeps its reading.
    expect(significant(tokenizeRuby("-> true"))).toEqual([run("operator", "->"), run("boolean", "true")]);
    // `..` versus `...`; `::` IS a member position (the dot refuses every
    // reading but the call peek).
    expect(significant(tokenizeRuby("1..2\n1...3\nFoo::BAR.new(1); x.nil; Foo::BarError"))).toEqual([
      run("number", "1"),
      run("operator", ".."),
      run("number", "2"),
      run("number", "1"),
      run("operator", "..."),
      run("number", "3"),
      run("type", "Foo"),
      run("operator", "::"),
      run("default", "BAR"), // after `::` even a loud name is a member name
      run("operator", "."),
      run("fn", "new"), // `new` is not a ruby keyword; the call peek takes it
      run("operator", "("),
      run("number", "1"),
      run("operator", ")"),
      run("operator", ";"),
      run("default", "x"),
      run("operator", "."),
      run("default", "nil"), // member position: the null reading is refused
      run("operator", ";"),
      run("type", "Foo"),
      run("operator", "::"),
      run("default", "BarError"), // mixed-case AND member position: plain
    ]);
    // `ArgumentError` is mixed-case like `IEnumerable` (the c.ts ruling),
    // so a bare rescue clause's exception name rides default.
    expect(significant(tokenizeRuby("rescue ArgumentError => e"))).toEqual([
      run("keyword", "rescue"),
      run("default", "ArgumentError"),
      run("operator", "=>"),
      run("default", "e"),
    ]);
  });

  it("variables: @ivars, @@cvars, $globals; lone sigils ride default", () => {
    expect(significant(tokenizeRuby("@@count = $stdout || @x"))).toEqual([
      run("variable", "@@count"),
      run("operator", "="),
      run("variable", "$stdout"),
      run("operator", "||"),
      run("variable", "@x"),
    ]);
    expect(significant(tokenizeRuby("$ @ $$ $1"))).toEqual([
      run("default", "$"),
      run("default", "@"),
      run("default", "$"),
      run("default", "$"),
      run("default", "$"), // numeric globals ($1): no identifier glued
      run("number", "1"),
    ]);
  });
});

describe("tokenizeRuby registry contract", () => {
  it("guesses and fences resolve through the registry", () => {
    expect(guessLangForBase("app.rb")).toBe("ruby");
    expect(guessLangForBase("app.RB")).toBe("ruby");
    expect(guessLangForBase("mygem.gemspec")).toBe("ruby");
    expect(resolveSyntaxLang("ruby")).toBe("ruby");
    expect(resolveSyntaxLang("rb")).toBeUndefined(); // an extension is not an alias
    expect(getTokenizer("ruby")).toBe(tokenizeRuby);
  });
});

describe("tokenizeRuby losslessness", () => {
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
    "=begin",
    "=end",
    "=begin\nx\n",
    "*/",
    "//",
    "'''",
    "$",
    "@",
    "@@",
    "$1",
    ":symbol",
    ":",
    ':"',
    ":'",
    "::",
    "?",
    "?x",
    "?\\",
    "<<",
    "<<-",
    "<<~",
    "<<EOS",
    "<<EOS\nEOS",
    "0x",
    "1_",
    "0778",
    "0o7",
    "0b",
    "1.2.3",
    "1..2",
    ".5",
    "=>",
    "**",
    "&:",
    "->",
    "TRUE NULL False",
    '"unterminated',
    "'unterminated",
    '"splice\\',
    "<<DONE\nmore",
    "@Foo(",
    "empty?",
    "foo!",
    "foo!=",
    "🚀 emoji ünïcøde 漢字",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeRuby(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "#",
      "#x\n",
      "//",
      "*/",
      '"',
      "'",
      "\\",
      '"str"',
      "'s'",
      "<<",
      "<<-",
      "<<~",
      "<<EOS",
      "EOS\n",
      "=begin",
      "=end\n",
      "$",
      "@",
      "@@",
      ":sym",
      ":",
      "::",
      "?",
      "?x",
      "&:",
      "=>",
      "**",
      "...",
      "..",
      "def",
      "class",
      "module",
      "end",
      "nil",
      "true",
      "TRUE",
      "self",
      "empty?",
      "foo!",
      "Widget",
      "MAX_SIZE",
      "ArgumentError",
      "1",
      "0x",
      "1_",
      "1_2",
      "0777",
      "0778",
      "0o7",
      "3r",
      "2i",
      ".5",
      "1..2",
      "->",
      "==",
      "!=",
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
      const runs = tokenizeRuby(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("ruby tokenizer wiring", () => {
  it("getTokenizer resolves ruby to tokenizeRuby and classifies a sample", () => {
    const doc = [
      "# greeting service",
      "class Greeter < Base",
      "  LIMIT = 10",
      "",
      "  def initialize(name = nil)",
      "    @name = name",
      "  end",
      "",
      "  def greet_all",
      '    names.map(&:strip).join(" ") # pipeline',
      "  end",
      "end",
    ].join("\n");
    const runs = getTokenizer("ruby")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual([
      "# greeting service",
      "# pipeline",
    ]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "class",
      "def",
      "end",
      "def",
      "end",
      "end",
    ]);
    // The def names ride fn through prevFn; the dot-prefixed calls take
    // the peek. `strip` sits behind `&:` (an operator, not a call peek)
    // and `name`/`names` have no parens (ruby's optional call syntax), so
    // none of them reads as fn -- honest.
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual([
      "initialize",
      "greet_all",
      "map",
      "join",
    ]);
    // `LIMIT` is an all-caps constant (not Capitalized); `Base` reads via
    // the heuristic. `nil` rides null.
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual(["Greeter", "Base"]);
    expect(runs.filter((r) => r.type === "null").map((r) => r.text)).toEqual(["nil"]);
    expect(runs.filter((r) => r.type === "variable").map((r) => r.text)).toEqual(["@name"]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual(["10"]);
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual(['" "']);
  });
});
