// Unit tests for the Crystal tokenizer (src/utils/syntax/crystal.ts): the
// ruby clone with its verified delta list -- no `=begin` block comment and
// no `?c` char arm and no `$` globals (each pinned as a degrade), `'a'` as
// a Char riding the java-style quote-char-quote scan while `'ab'` is not a
// literal and degrades, the `@[` annotation arm (balanced group, strings
// and comments skipped, armed by the sequence anywhere), the width-suffix
// number zoo with the OPTIONAL underscore (`1_f32`, `1i64`, `0xF_u8`) and
// the no-legacy-octal contrast with ruby (`0778` is a plain decimal
// number), the compiler's operator whitelist (`&**`, `&+`, `//=`, `&+=`
// as runs, the removed `&.` pinned as a degrade to `&` plus the member
// dot), the lexer-spelled question keywords (`is_a?`, `nil?`,
// `responds_to?` -- not the old reference's `isa?`/`respond_to??`),
// prevFn after def AND fun, symbols riding string, heredocs taking the
// ruby scan verbatim -- plus a losslessness sweep and the registry pins
// (.cr claimed, .ecr honestly not, no aliases).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeCrystal } from "@utils/syntax/crystal.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

// The ruby family's classes plus "decorator" (the annotation arm); no
// "variable" sigil beyond @ivars (no `$` here), no "preproc".
const TYPES = new Set([
  "comment",
  "string",
  "variable",
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

describe("tokenizeCrystal structure", () => {
  it("a class with annotation, ivars, def/fun names, interpolated string", () => {
    const code = [
      '@[Link("libc")]',
      "class Greeter",
      "  def initialize(@name : String)",
      '    @greeting = "Hello, \\{@name}!"',
      "  end",
      "  fun puts(s : Char*) : Nil",
      "end",
    ].join("\n");
    expect(significant(tokenizeCrystal(code))).toEqual([
      run("decorator", '@[Link("libc")]'), // the string inside cannot cut the group
      run("keyword", "class"),
      run("type", "Greeter"), // the name after class
      run("keyword", "def"),
      run("fn", "initialize"), // prevFn: the name, paren or not
      run("operator", "("),
      run("variable", "@name"),
      run("operator", ":"),
      run("type", "String"), // Capitalized
      run("operator", ")"),
      run("variable", "@greeting"),
      run("operator", "="),
      run("string", '"Hello, \\{@name}!"'), // the hole rides inside (rust ruling); the escaped @ cannot arm an ivar
      run("keyword", "end"),
      run("keyword", "fun"),
      run("fn", "puts"), // prevFn after fun too (the pinned decision)
      run("operator", "("),
      run("default", "s"),
      run("operator", ":"),
      run("type", "Char"),
      run("operator", "*"),
      run("operator", ")"),
      run("operator", ":"),
      run("type", "Nil"),
      run("keyword", "end"),
    ]);
  });

  it("annotations: glued args, nested brackets, strings inside, unclosed runs on", () => {
    expect(significant(tokenizeCrystal("@[Serializable]\n@[Logger]"))).toEqual([
      run("decorator", "@[Serializable]"),
      run("decorator", "@[Logger]"),
    ]);
    expect(significant(tokenizeCrystal('@[Foo("]")] x'))).toEqual([
      run("decorator", '@[Foo("]")]'), // the bracket inside the string is content
      run("default", "x"),
    ]);
    expect(significant(tokenizeCrystal("#[Attr]"))).toEqual([
      run("comment", "#[Attr]"), // the `#` arm sees it first: this is NOT the rust spelling
    ]);
    // The `@[` sequence arms anywhere (no line position involved), the
    // honest wash of the glue rule:
    expect(significant(tokenizeCrystal("foo @[1]"))).toEqual([
      run("default", "foo"),
      run("decorator", "@[1]"),
    ]);
    expect(tokenizeCrystal("@[Foo(")).toEqual([run("decorator", "@[Foo(")]); // unclosed: end of input
    expect(significant(tokenizeCrystal("@ @x @@y"))).toEqual([
      run("default", "@"), // a lone `@` is one plain byte
      run("variable", "@x"),
      run("variable", "@@y"), // class variables ride the same arm
    ]);
  });

  it("chars: quote-char-quote, escapes included; multi-char is not a literal", () => {
    expect(significant(tokenizeCrystal(`'a' '\\n' '\\u0041' '\\u{1F52E}'`))).toEqual([
      run("string", "'a'"),
      run("string", "'\\n'"),
      run("string", "'\\u0041'"),
      run("string", "'\\u{1F52E}'"), // the reference's brace spelling, included
    ]);
    // `'ab'` is not a literal: the quote rides degraded default bytes
    // (the pinned contrast with ruby's string quotes).
    expect(significant(tokenizeCrystal("'ab'"))).toEqual([
      run("default", "'"),
      run("default", "ab"),
      run("default", "'"),
    ]);
    // An apostrophe in an identifier-shaped word degrades the same way:
    expect(significant(tokenizeCrystal("don't"))).toEqual([
      run("default", "don"),
      run("default", "'"),
      run("default", "t"),
    ]);
  });

  it("the dropped arms: no =begin, no ?char, no $global (each pinned)", () => {
    expect(significant(tokenizeCrystal("=begin still code =end"))).toEqual([
      run("operator", "="),
      run("keyword", "begin"), // Crystal has only `#` comments; no block form exists
      run("default", "still"),
      run("default", "code"),
      run("operator", "="),
      run("keyword", "end"),
    ]);
    expect(significant(tokenizeCrystal("?a $x"))).toEqual([
      run("operator", "?"), // no ?c char literal: the ternary mark plus a word
      run("default", "a"),
      run("default", "$"), // no globals: the dollar is a plain byte
      run("default", "x"),
    ]);
  });

  it("symbols ride string; the ternary colon needs air", () => {
    expect(significant(tokenizeCrystal(':sym :"quoted sym" :nil_or_not? Foo::Bar'))).toEqual([
      run("string", ":sym"),
      run("string", ':"quoted sym"'),
      run("string", ":nil_or_not?"), // the ruby mark absorption rides along
      run("type", "Foo"), // Capitalized before `::`
      run("operator", "::"),
      run("default", "Bar"), // the member position refuses the type reading
    ]);
    expect(significant(tokenizeCrystal("ok ? 1 : 2"))).toEqual([
      run("default", "ok"),
      run("operator", "?"),
      run("number", "1"),
      run("operator", ":"),
      run("number", "2"),
    ]);
    // The glued ternary mark washes as a symbol (ruby's documented cost):
    expect(significant(tokenizeCrystal("a ? b :c"))).toEqual([
      run("default", "a"),
      run("operator", "?"),
      run("default", "b"),
      run("string", ":c"),
    ]);
  });

  it("numbers: radix 0x/0b/0o only, optional-underscore suffixes, no legacy octal", () => {
    expect(
      significant(tokenizeCrystal("0 0777 0778 0x1F 0b1010 0o123 1_000_000 1.5 1.5e-7 1e10 1_f32 1i64 0xF_u8 9223372036854775808_u64")),
    ).toEqual([
      run("number", "0"),
      run("number", "0777"), // decimal here, NOT the legacy octal ruby reads
      run("number", "0778"), // ruby distrusts this one; Crystal's decimal accepts it (the pinned contrast)
      run("number", "0x1F"),
      run("number", "0b1010"),
      run("number", "0o123"),
      run("number", "1_000_000"),
      run("number", "1.5"),
      run("number", "1.5e-7"),
      run("number", "1e10"), // the exponent needs no dot
      run("number", "1_f32"), // a Float32 written on the integer part
      run("number", "1i64"), // the underscore before the suffix is optional
      run("number", "0xF_u8"),
      run("number", "9223372036854775808_u64"),
    ]);
    expect(significant(tokenizeCrystal("0x 1_ 0o8 .5 1.2.3 42abc"))).toEqual([
      run("default", "0x"), // half literals ride default
      run("default", "1_"),
      run("default", "0o8"),
      run("operator", "."), // no leading-dot float (the compiler itself rejects `.5`)
      run("number", "5"),
      run("number", "1.2"),
      run("operator", "."),
      run("number", "3"),
      run("number", "42"),
      run("default", "abc"),
    ]);
  });

  it("the operator whitelist: &**, the overflow pair, the combined assignments", () => {
    expect(significant(tokenizeCrystal("1 &** 2 & 1 &+ 2 & 1 &* 2"))).toEqual([
      run("number", "1"),
      run("operator", "&**"), // THREE-char checked first (the dart lesson)
      run("number", "2"),
      run("operator", "&"),
      run("number", "1"),
      run("operator", "&+"),
      run("number", "2"),
      run("operator", "&"),
      run("number", "1"),
      run("operator", "&*"),
      run("number", "2"),
    ]);
    expect(significant(tokenizeCrystal("a += 1 &&& x //= 2 <<= 3 **= 4"))).toEqual([
      run("default", "a"),
      run("operator", "+="),
      run("number", "1"),
      // `&&&` is no Crystal token: `&&` plus a single (the elixir trio
      // does not transfer).
      run("operator", "&&"),
      run("operator", "&"),
      run("default", "x"),
      run("operator", "//="), // floor division assignment, one run
      run("number", "2"),
      run("operator", "<<="),
      run("number", "3"),
      run("operator", "**="),
      run("number", "4"),
    ]);
    expect(significant(tokenizeCrystal("a <=> b === c =~ d !~ e .. f ... g"))).toEqual([
      run("default", "a"),
      run("operator", "<=>"),
      run("default", "b"),
      run("operator", "==="),
      run("default", "c"),
      run("operator", "=~"),
      run("default", "d"),
      run("operator", "!~"),
      run("default", "e"),
      run("operator", ".."),
      run("default", "f"),
      run("operator", "..."),
      run("default", "g"),
    ]);
    expect(significant(tokenizeCrystal("{a => 1} f = ->(x : Int32) { x }"))).toEqual([
      run("operator", "{"),
      run("default", "a"),
      run("operator", "=>"), // the hash rocket
      run("number", "1"),
      run("operator", "}"),
      run("default", "f"),
      run("operator", "="),
      run("operator", "->"), // the proc arrow is NOT member access
      run("operator", "("),
      run("default", "x"),
      run("operator", ":"),
      run("type", "Int32"),
      run("operator", ")"),
      run("operator", "{"),
      run("default", "x"),
      run("operator", "}"),
    ]);
  });

  it("`&.` is NOT a token (removed with try): it degrades to & plus the dot", () => {
    expect(significant(tokenizeCrystal("x&.foo"))).toEqual([
      run("default", "x"),
      run("operator", "&"),
      run("operator", "."), // the dot still arms the member position
      run("default", "foo"),
    ]);
    // The try-method spelling is the idiomatic shape and reads as calls:
    expect(significant(tokenizeCrystal("x.try(&.upcase)"))).toEqual([
      run("default", "x"),
      run("operator", "."),
      run("fn", "try"),
      run("operator", "("),
      run("operator", "&"),
      run("operator", "."),
      run("default", "upcase"),
      run("operator", ")"),
    ]);
  });

  it("percent literals are real Crystal and get NO arm (the ruby doctrine, pinned)", () => {
    expect(significant(tokenizeCrystal("%w[a b] %i(x) 10 % 3"))).toEqual([
      run("operator", "%"), // no %w arm: the array reads as junk bytes...
      run("default", "w"),
      run("operator", "["),
      run("default", "a"),
      run("default", "b"),
      run("operator", "]"),
      run("operator", "%"),
      run("fn", "i"), // `%i(`: the call peek claims the lone letter, the degrade's own joke
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
      run("number", "10"),
      run("operator", "%"), // ...while the modulo is exactly the single it should be
      run("number", "3"),
    ]);
  });

  it("keywords the lexer spells with a question mark: is_a?, nil?, responds_to?", () => {
    expect(significant(tokenizeCrystal("is_a? nil? responds_to? type of uninitialized"))).toEqual([
      run("keyword", "is_a?"), // one absorbed mark reaches the lexer's word
      run("keyword", "nil?"),
      run("keyword", "responds_to?"), // NOT the old reference's respond_to??
      run("keyword", "type"),
      run("keyword", "of"),
      run("keyword", "uninitialized"),
    ]);
    // The OLD spellings are just words here:
    expect(significant(tokenizeCrystal("isa? respond_to??"))).toEqual([
      run("default", "isa?"),
      run("default", "respond_to?"), // one absorbed mark, the extra ? is an operator
      run("operator", "?"),
    ]);
    // After a dot every reading but the call peek is refused (house rule):
    expect(significant(tokenizeCrystal("x.nil? x.is_a?(Int32)"))).toEqual([
      run("default", "x"),
      run("operator", "."),
      run("default", "nil?"), // a predicate call, not the keyword
      run("default", "x"),
      run("operator", "."),
      run("fn", "is_a?"), // ...and before `(` it is a call
      run("operator", "("),
      run("type", "Int32"),
      run("operator", ")"),
    ]);
  });

  it("booleans/null case-sensitively; self/super ride keyword; def-name absorption", () => {
    expect(significant(tokenizeCrystal("true false nil True TRUE Nil self super"))).toEqual([
      run("boolean", "true"),
      run("boolean", "false"),
      run("null", "nil"),
      run("type", "True"), // Capitalized takes the type reading
      run("default", "TRUE"),
      run("type", "Nil"),
      run("keyword", "self"),
      run("keyword", "super"),
    ]);
    expect(significant(tokenizeCrystal("def shout?\n  save!\nend"))).toEqual([
      run("keyword", "def"),
      run("fn", "shout?"), // the absorbed mark joins the def-name reading
      run("default", "save!"), // `save!` is one word (never `!=`)
      run("keyword", "end"),
    ]);
    expect(significant(tokenizeCrystal("foo!=bar"))).toEqual([
      run("default", "foo"),
      run("operator", "!="),
      run("default", "bar"),
    ]);
  });

  it("heredocs take the ruby scan: markers, quoted labels, the closer line", () => {
    const code = ['msg = <<-TEXT', "    hi \\{name}", "    TEXT", "tail"].join("\n");
    expect(significant(tokenizeCrystal(code))).toEqual([
      run("default", "msg"),
      run("operator", "="),
      run("string", "<<-TEXT\n    hi \\{name}\n    TEXT"), // indented closer tolerated
      run("default", "tail"), // the closer line's tail rides the next run
    ]);
    expect(significant(tokenizeCrystal("<<-'RAW'\nno \\{interp}\nRAW"))).toEqual([
      run("string", "<<-'RAW'\nno \\{interp}\nRAW"),
    ]);
    // `<<` with air is the shift (two-char run), no heredoc arms:
    expect(significant(tokenizeCrystal("a << b >> c"))).toEqual([
      run("default", "a"),
      run("operator", "<<"),
      run("default", "b"),
      run("operator", ">>"),
      run("default", "c"),
    ]);
  });

  it("comments, shebang, and the do/end block", () => {
    expect(significant(tokenizeCrystal("#!/usr/bin/env crystal\n[1, 2].map do |x|\n  x * 2\nend"))).toEqual([
      run("comment", "#!/usr/bin/env crystal"),
      run("operator", "["),
      run("number", "1"),
      run("operator", ","),
      run("number", "2"),
      run("operator", "]"),
      run("operator", "."),
      run("default", "map"), // no paren: the peek passes on it, honestly
      run("keyword", "do"),
      run("operator", "|"),
      run("default", "x"),
      run("operator", "|"),
      run("default", "x"),
      run("operator", "*"),
      run("number", "2"),
      run("keyword", "end"),
    ]);
  });
});

describe("tokenizeCrystal line-wise degradation (the file view tokenizes per line)", () => {
  it("an unterminated string stops at the newline; the next line re-reads", () => {
    expect(tokenizeCrystal('x = "abc\ny = 1')).toEqual([
      run("default", "x"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("string", '"abc'),
      run("default", "\n"),
      run("default", "y"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("number", "1"),
    ]);
  });

  it("an unclosed heredoc swallows its line alone; the whole pass sees the literal", () => {
    const code = "<<-EOT\ntext\n  EOT";
    expect(tokenizeCrystal(code)).toEqual([
      run("string", "<<-EOT\ntext\n  EOT"), // whole pass: one heredoc
    ]);
    expect(tokenizeCrystal("<<-EOT")).toEqual([run("string", "<<-EOT")]); // per line: unclosed opener
    expect(tokenizeCrystal("text")).toEqual([run("default", "text")]);
    expect(tokenizeCrystal("  EOT")).toEqual([
      run("default", "  "),
      run("default", "EOT"), // all-caps is not the Capitalized shape; the orphan closer is plain junk (the honest per-line story)
    ]);
  });

  it("an unclosed annotation runs to end of the line; quotes inside are skipped", () => {
    expect(tokenizeCrystal('@[Foo("unterm')).toEqual([run("decorator", '@[Foo("unterm')]);
  });
});

describe("tokenizeCrystal registry contract", () => {
  it("guesses and fences resolve through the registry; .ecr stays unclaimed", () => {
    expect(guessLangForBase("main.cr")).toBe("crystal");
    expect(guessLangForBase("app.cr")).toBe("crystal");
    expect(guessLangForBase("MAIN.CR")).toBe("crystal"); // extensions are case-insensitive
    expect(guessLangForBase("index.ecr")).toBeUndefined(); // the template dialect is html-with-tags
    expect(guessLangForBase("file.crystal")).toBeUndefined(); // no such extension
    expect(guessLangForBase("cr")).toBeUndefined(); // dotless stem
    expect(resolveSyntaxLang("crystal")).toBe("crystal");
    expect(resolveSyntaxLang("cr")).toBeUndefined(); // extensions are never aliases
    expect(resolveSyntaxLang("CRYSTAL")).toBeUndefined(); // the canonical name resolves exactly
    expect(resolveSyntaxLang("crystal-lang")).toBeUndefined();
    expect(getTokenizer("crystal")).toBe(tokenizeCrystal);
  });
});

describe("tokenizeCrystal losslessness", () => {
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
    "#\n",
    "@",
    "@@",
    "$",
    "@[",
    "@[Foo",
    "@[Foo(",
    ":",
    ":sym",
    ':"unterm',
    "?",
    "!a",
    "<<",
    "<<-",
    "<<~",
    "<<EOT",
    "<<-'",
    "<<-EOT unterm",
    "'a'",
    "'ab'",
    "'\\",
    "'\\u{",
    "'\\u",
    "0x",
    "0o",
    "0b",
    "1_",
    "0777",
    "1_f32",
    "i64",
    "%",
    "%w[",
    "&",
    "&.",
    "&**",
    "//",
    "...",
    "<=>",
    "=>",
    "is_a?",
    "responds_to??",
    "nil?",
    "=begin",
    "end",
    "🚀 emoji ünïcøde 漢字",
    '"unterminated',
    '"splice\\',
    "x\r\ny",
    "@#[]",
    "()[]{}",
    "0xFF_i64",
    "1i64",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeCrystal(input);
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
      "@",
      "@[",
      "@x",
      "@@x",
      ":",
      ":sym",
      "?",
      "!",
      "'",
      '"',
      "\\",
      "#",
      "<<",
      "<<-",
      "<<~",
      "EOT",
      "\n",
      "\r\n",
      " ",
      "\t",
      "0x",
      "0o",
      "1_5",
      "0777",
      "_f32",
      "i64",
      "def",
      "fun",
      "end",
      "class",
      "is_a?",
      "responds_to?",
      "&",
      "&+",
      "&**",
      "+=",
      "//",
      "...",
      "<=>",
      "=>",
      "%w[",
      "%",
      "🚀",
      "x",
      "Foo",
      "$",
      "true",
      "nil",
      "self",
      '"unterminated',
      "'unterminated",
      "<<EOT",
      "@[Foo(",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeCrystal(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("crystal tokenizer wiring", () => {
  it("getTokenizer resolves crystal to tokenizeCrystal and classes a real class", () => {
    const code = [
      'require "json"',
      "",
      "# A small greeter.",
      "@[Serializable]",
      "class Greeter",
      "  def initialize(@name)",
      "  end",
      "",
      '  def greet(prefix = "hi"): String',
      "    msg = <<-TEXT",
      "    \\{prefix}, \\{@name}!",
      "    TEXT",
      "    msg.upcase",
      "  end",
      "",
      "  def ok?",
      "    !@name.empty?",
      "  end",
      "end",
      "",
      'Greeter.new("ada").greet',
    ].join("\n");
    const runs = getTokenizer("crystal")!(code);
    expect(runs.map((r) => r.text).join("")).toBe(code); // the registry contract, held
    expect(runs.filter((r) => r.type === "decorator").map((r) => r.text)).toEqual(["@[Serializable]"]);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual(["# A small greeter."]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual(["initialize", "greet", "ok?", "new"]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "require",
      "class",
      "def",
      "end",
      "def",
      "end",
      "def",
      "end",
      "end",
    ]);
    expect(runs.filter((r) => r.type === "variable").map((r) => r.text)).toEqual(["@name", "@name"]); // the one inside the heredoc rode the string
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual([
      '"json"',
      '"hi"',
      "<<-TEXT\n    \\{prefix}, \\{@name}!\n    TEXT",
      '"ada"',
    ]);
    // `String` and `Greeter` read as types; the heredoc interpolation rode
    // the string run, so it never surfaced as holes.
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual(["Greeter", "String", "Greeter"]);
  });
});
