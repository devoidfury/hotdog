// Unit tests for the C++ tokenizer (src/utils/syntax/cpp.ts): typed runs with
// exact classes and spans over targeted fixtures (the c.ts wholesale transfer
// -- preproc arm, char literals on the string scan, the `1.2.3` lookalike
// rule, the octal-legal numeric dialect -- plus the C++ deltas: the armed R
// raw strings with their ill-formed-delimiter degrade, the position-blind
// [[...]] attribute scan (the contrast with cs.ts's arming), the `->`/`::`/
// `.*`/`->*` member rulings, the `<=>` run against the groovy rejection,
// nullptr riding null and bool joining the primitives), a losslessness sweep
// over a nasty fixture corpus plus a deterministic fragment generator, and
// the registry wiring pins (the c/c++ extension re-split, with the `.h`
// stay-guard next to the flipped cpp guesses).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeCpp } from "@utils/syntax/cpp.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

/** The tokenizer's declared class vocabulary (every run must live here). */
const TYPES = new Set([
  "preproc",
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

/** Drop the whitespace/newline passthrough to assert the interesting runs. */
const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeCpp structure", () => {
  it("classifies a whole class body line by line", () => {
    const code = [
      "#include <cstdio>",
      "namespace app {",
      "class Widget : public Base {",
      " public:",
      "  int size() const override { return items_.size(); }",
      "};",
      "}  // namespace",
    ].join("\n");
    expect(significant(tokenizeCpp(code))).toEqual([
      run("preproc", "#include <cstdio>"), // the whole directive line, header included
      run("keyword", "namespace"),
      run("type", "app"), // the DECL_KW arm claims the name (new vs c.ts)
      run("operator", "{"),
      run("keyword", "class"), // DECL_KW gains class (new vs c.ts)
      run("type", "Widget"),
      run("operator", ":"),
      run("keyword", "public"),
      run("type", "Base"), // the Capitalized heuristic
      run("operator", "{"),
      run("keyword", "public"),
      run("operator", ":"),
      run("type", "int"),
      run("fn", "size"), // the call peek is the only fn arm
      run("operator", "("),
      run("operator", ")"),
      run("keyword", "const"),
      run("keyword", "override"), // contextual in the grammar, listed anyway (java's precedent)
      run("operator", "{"),
      run("keyword", "return"),
      run("default", "items_"),
      run("operator", "."),
      run("fn", "size"), // the call peek survives the dot
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("operator", "}"), // the method body closes
      run("operator", "}"), // the class closes...
      run("operator", ";"), // ...with its mandatory semicolon
      run("operator", "}"), // the namespace closes
      run("comment", "// namespace"),
    ]);
  });

  it("scope resolution is a run and a member position; the dot refuses readings", () => {
    expect(significant(tokenizeCpp("ns::Thing x = ns::make(); w.in; s.type; p->fn(x); x.int; p->True"))).toEqual([
      run("default", "ns"),
      run("operator", "::"), // one run, the scope arrow (java's ruling)
      run("default", "Thing"), // member position: even the Capitalized reading is refused
      run("default", "x"),
      run("operator", "="),
      run("default", "ns"),
      run("operator", "::"),
      run("fn", "make"), // the call peek survives the scope arrow too
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("default", "w"),
      run("operator", "."),
      run("default", "in"),
      run("operator", ";"),
      run("default", "s"),
      run("operator", "."),
      run("default", "type"),
      run("operator", ";"),
      run("default", "p"),
      run("operator", "->"), // one run, the member arrow (c.ts's ruling, not java's)
      run("fn", "fn"), // before `(`: the call reading is a member too
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
      run("operator", ";"),
      run("default", "x"),
      run("operator", "."),
      run("default", "int"),
      run("operator", ";"),
      run("default", "p"),
      run("operator", "->"),
      run("default", "True"), // dot: not even the Capitalized heuristic survives
    ]);
  });

  it("templates, concepts, coroutines, and the widened primitive set", () => {
    expect(
      significant(tokenizeCpp("template <typename T> concept C = requires(T x) { x.size(); };")),
    ).toEqual([
      run("keyword", "template"),
      run("operator", "<"), // generics ride plain operators
      run("keyword", "typename"),
      run("type", "T"),
      run("operator", ">"),
      run("keyword", "concept"),
      run("type", "C"), // single letter IS Capitalized by the heuristic
      run("operator", "="),
      run("keyword", "requires"),
      run("operator", "("),
      run("type", "T"),
      run("default", "x"),
      run("operator", ")"),
      run("operator", "{"),
      run("default", "x"),
      run("operator", "."),
      run("fn", "size"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("operator", "}"),
      run("operator", ";"),
    ]);
    expect(significant(tokenizeCpp("co_await task; co_return 0; co_yield v;"))).toEqual([
      run("keyword", "co_await"), // the coroutine trio are reserved words
      run("default", "task"),
      run("operator", ";"),
      run("keyword", "co_return"),
      run("number", "0"),
      run("operator", ";"),
      run("keyword", "co_yield"),
      run("default", "v"),
      run("operator", ";"),
    ]);
    expect(
      significant(tokenizeCpp("bool ok = true; wchar_t w = L'x'; char8_t c8 = u8'a'; size_t sz;")),
    ).toEqual([
      run("type", "bool"), // a keyword here, where c.ts had to leave it a stdbool typedef
      run("default", "ok"),
      run("operator", "="),
      run("boolean", "true"),
      run("operator", ";"),
      run("type", "wchar_t"), // the fundamental wide types ride type (the ruling)
      run("default", "w"),
      run("operator", "="),
      run("string", "L'x'"), // the wide prefix joins the char-literal scan
      run("operator", ";"),
      run("type", "char8_t"),
      run("default", "c8"),
      run("operator", "="),
      run("string", "u8'a'"),
      run("operator", ";"),
      run("default", "size_t"), // still a typedef, a plain word (the c.ts ruling)
      run("default", "sz"),
      run("operator", ";"),
    ]);
  });

  it("raw strings: armed R with delimiter, the prefixed spellings, the degrade", () => {
    expect(significant(tokenizeCpp('s = R"(a(b)c)d)"'))).toEqual([
      run("default", "s"),
      run("operator", "="),
      run("string", 'R"(a(b)c)d)"'), // the inner `)` cannot cut the run short
    ]);
    expect(significant(tokenizeCpp('t = R"d(x)y)d"'))).toEqual([
      run("default", "t"),
      run("operator", "="),
      run("string", 'R"d(x)y)d"'), // closer = `)` + delimiter + quote, first occurrence wins
    ]);
    // The prefixed spellings reach the raw arm through the word scan:
    // `u8R` and `LR` are one identifier token to it.
    expect(significant(tokenizeCpp(String.raw`u8R"(\)"`))).toEqual([
      run("string", String.raw`u8R"(\)"`), // no escape processing: the backslash is raw
    ]);
    expect(significant(tokenizeCpp('LR"(wide)"'))).toEqual([run("string", 'LR"(wide)"')]);
    // An ill-formed delimiter (whitespace before the `(`) is not a raw
    // string: the word rides as itself and the quote opens the ordinary
    // scan. (`R` alone is Capitalized-shaped, the family's heuristic.)
    expect(significant(tokenizeCpp('R"x y"'))).toEqual([run("type", "R"), run("string", '"x y"')]);
    // No `(` anywhere: the same degrade, with the ordinary scan running
    // to end of input.
    expect(significant(tokenizeCpp('R"abc'))).toEqual([run("type", "R"), run("string", '"abc')]);
    // An unterminated raw string runs to end of input.
    expect(significant(tokenizeCpp('R"(abc'))).toEqual([run("string", 'R"(abc')]);
    // A word that only looks like a raw head keeps its identifier class.
    expect(significant(tokenizeCpp('FOR"tail"'))).toEqual([
      run("default", "FOR"),
      run("string", '"tail"'),
    ]);
  });

  it("attributes: one decorator run, no position arming, balanced closer", () => {
    expect(
      significant(
        tokenizeCpp('[[nodiscard]] int f() noexcept;\n[[deprecated("a]b")]] void g();\narr[i][j];\nx[[maybe_unused]] = 1;\n[[unterm'),
      ),
    ).toEqual([
      run("decorator", "[[nodiscard]]"),
      run("type", "int"),
      run("fn", "f"),
      run("operator", "("),
      run("operator", ")"),
      run("keyword", "noexcept"),
      run("operator", ";"),
      run("decorator", '[[deprecated("a]b")]]'), // the string is skipped: its `]` cannot cut the run short
      run("type", "void"),
      run("fn", "g"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("default", "arr"),
      run("operator", "["), // a SINGLE bracket stays the index operator it is
      run("default", "i"),
      run("operator", "]"),
      run("operator", "["),
      run("default", "j"),
      run("operator", "]"),
      run("operator", ";"),
      run("default", "x"),
      run("decorator", "[[maybe_unused]]"), // glued to a name too -- an index cannot nest brackets, so the doubled pair IS the language's attribute
      run("operator", "="),
      run("number", "1"),
      run("operator", ";"),
      run("decorator", "[[unterm"), // no closer: end of input
    ]);
  });

  it("the lambda trailing return pays the dot cost (documented)", () => {
    expect(significant(tokenizeCpp("auto f = [](int x) -> bool { return x > 0; };"))).toEqual([
      run("keyword", "auto"),
      run("default", "f"),
      run("operator", "="),
      run("operator", "["), // `[]` is not the doubled pair
      run("operator", "]"),
      run("operator", "("),
      run("type", "int"),
      run("default", "x"),
      run("operator", ")"),
      run("operator", "->"), // member position (c.ts's ruling): the arrow sets dot
      run("default", "bool"), // the documented cost: the trailing return type reads plain
      run("operator", "{"),
      run("keyword", "return"),
      run("default", "x"),
      run("operator", ">"),
      run("number", "0"),
      run("operator", ";"),
      run("operator", "}"),
      run("operator", ";"),
    ]);
  });

  it("operators: the run set with the spaceship; the elvis and ?? degrade", () => {
    expect(
      significant(tokenizeCpp("std::cout << (a <=> b) <<= 2; i++; j--; v <<= 1; a ||= true; b &&= flag; p->*q = r.*s; vec.push_back(1);")),
    ).toEqual([
      run("default", "std"),
      run("operator", "::"),
      run("default", "cout"),
      run("operator", "<<"), // the stream arrow IS a run
      run("operator", "("),
      run("default", "a"),
      run("operator", "<=>"), // the spaceship IS a three-char run (the groovy contrast: the operator exists here)
      run("default", "b"),
      run("operator", ")"),
      run("operator", "<<="),
      run("number", "2"),
      run("operator", ";"),
      run("default", "i"),
      run("operator", "++"),
      run("operator", ";"),
      run("default", "j"),
      run("operator", "--"),
      run("operator", ";"),
      run("default", "v"),
      run("operator", "<<="),
      run("number", "1"),
      run("operator", ";"),
      run("default", "a"),
      run("operator", "||="), // the C++20 logical assignments ARE runs
      run("boolean", "true"),
      run("operator", ";"),
      run("default", "b"),
      run("operator", "&&="),
      run("default", "flag"),
      run("operator", ";"),
      run("default", "p"),
      run("operator", "->*"), // pointer-to-member: one three-char run, a member position
      run("default", "q"),
      run("operator", "="),
      run("default", "r"),
      run("operator", ".*"),
      run("default", "s"),
      run("operator", ";"),
      run("default", "vec"),
      run("operator", "."),
      run("fn", "push_back"),
      run("operator", "("),
      run("number", "1"),
      run("operator", ")"),
      run("operator", ";"),
    ]);
    // The elvis `?:` does NOT exist in C++ (two singles), and neither do
    // `??`, `=>` or `?.`.
    expect(significant(tokenizeCpp("a ?: b; c ?? d; e ?. f"))).toEqual([
      run("default", "a"),
      run("operator", "?"),
      run("operator", ":"),
      run("default", "b"),
      run("operator", ";"),
      run("default", "c"),
      run("operator", "?"),
      run("operator", "?"),
      run("default", "d"),
      run("operator", ";"),
      run("default", "e"),
      run("operator", "?"),
      run("operator", "."), // the plain dot still arms the member position
      run("default", "f"),
    ]);
    // The ellipsis is one run (varargs).
    expect(significant(tokenizeCpp("void logf(const char* fmt, ...);"))).toEqual([
      run("type", "void"),
      run("fn", "logf"),
      run("operator", "("),
      run("keyword", "const"),
      run("type", "char"),
      run("operator", "*"),
      run("default", "fmt"),
      run("operator", ","),
      run("operator", "..."),
      run("operator", ")"),
      run("operator", ";"),
    ]);
  });

  it("booleans ride lowercase, nullptr rides null, NULL is a macro-shaped word", () => {
    expect(significant(tokenizeCpp("true false TRUE False nullptr NULL NULLPTR and or not"))).toEqual([
      run("boolean", "true"),
      run("boolean", "false"),
      run("default", "TRUE"),
      run("type", "False"), // the Capitalized heuristic, not the boolean reading
      run("null", "nullptr"), // nullptr rides null (the pin)
      run("default", "NULL"), // the macro spelling is a plain word
      run("default", "NULLPTR"),
      run("keyword", "and"), // the alternative tokens ARE keywords (the decision)
      run("keyword", "or"),
      run("keyword", "not"),
    ]);
  });

  it("the c.ts numeric dialect transfers whole, distrusting lookalikes", () => {
    const runs = significant(tokenizeCpp("[0, 07, 0xff, 0b1010, 1.5, .5, 1e3, 10u, 42ull, 1.5f, 1.2.3, 0x, 1e, _Bool]"));
    // C octal (07) is legal here -- same ruling as c.ts, the json distrust
    // belongs to json.
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual([
      "0",
      "07",
      "0xff",
      "0b1010",
      "1.5",
      ".5", // leading-dot floats are real here, so the lookalike rule transfers
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

  it("the C++14 digit separators keep the documented degrade", () => {
    expect(significant(tokenizeCpp("1'000"))).toEqual([
      run("number", "1"), // the separator is not consumed...
      run("string", "'000"), // ...and the quote opens the char-literal scan to end of input
    ]);
  });
});

describe("tokenizeCpp directives and comments", () => {
  it("a line-leading # runs whole to EOL, trailing junk included", () => {
    expect(significant(tokenizeCpp("#define A(x) ((x)*2) // trailing"))).toEqual([
      run("preproc", "#define A(x) ((x)*2) // trailing"), // the // never splits the directive
    ]);
  });

  it("indentation still arms a directive; a mid-line # is not one", () => {
    expect(tokenizeCpp("  #ifdef X")).toEqual([run("default", "  "), run("preproc", "#ifdef X")]);
    expect(significant(tokenizeCpp("y = 3 # not a directive"))).toEqual([
      run("default", "y"),
      run("operator", "="),
      run("number", "3"),
      run("default", "#"), // mid-line: bytes, not a directive
      run("keyword", "not"), // the alternative token IS a keyword (bare mid-line, it still reads as one -- language reality over the fixture draft)
      run("default", "a"),
      run("default", "directive"),
    ]);
  });

  it("// runs to EOL; the block form never nests and runs to its closer or end", () => {
    expect(tokenizeCpp("a // c\nb /* block */ c")).toEqual([
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
    expect(significant(tokenizeCpp("/* outer /* inner */ still */ tail"))).toEqual([
      run("comment", "/* outer /* inner */"), // NOT nested (the grammar is not, unlike kotlin)
      run("default", "still"),
      run("operator", "*"),
      run("operator", "/"),
      run("default", "tail"),
    ]);
    expect(tokenizeCpp("/* unterm forever")).toEqual([run("comment", "/* unterm forever")]);
  });

  it("comment openers inside strings stay strings", () => {
    expect(significant(tokenizeCpp('s = "a//b/*c*/" // real'))).toEqual([
      run("default", "s"),
      run("operator", "="),
      run("string", '"a//b/*c*/"'),
      run("comment", "// real"),
    ]);
  });
});

describe("tokenizeCpp line-wise degradation (the file view tokenizes per line)", () => {
  it("an unterminated string stops at the newline; the next line re-reads", () => {
    expect(tokenizeCpp('a = "oops\nb = 1')).toEqual([
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
    expect(tokenizeCpp("#define F(x) \\\n  ((x)+1)\n#endif")).toEqual([
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
    expect(tokenizeCpp("/* a\n#define X\n*/")).toEqual([
      run("comment", "/* a\n#define X\n*/"), // whole-input pass: all comment
    ]);
    // The file view's per-line call sees the middle line fresh: a directive
    // (the documented misread) and a closing arrow pair -- lossless either way.
    expect(tokenizeCpp("#define X")).toEqual([run("preproc", "#define X")]);
    expect(tokenizeCpp("*/")).toEqual([run("operator", "*"), run("operator", "/")]);
  });
});

describe("tokenizeCpp registry contract", () => {
  it("guesses and fences resolve through the registry; the re-split moved the cpp spellings", () => {
    expect(guessLangForBase("main.cpp")).toBe("cpp");
    expect(guessLangForBase("widget.hpp")).toBe("cpp");
    expect(guessLangForBase("MAIN.CC")).toBe("cpp"); // the extension index is case-insensitive
    expect(guessLangForBase("util.hxx")).toBe("cpp");
    expect(guessLangForBase("meta.ipp")).toBe("cpp");
    expect(guessLangForBase("header.h")).toBe("c"); // the re-split's guard: a header's dialect is undecidable, .h stays c
    expect(guessLangForBase("main.c")).toBe("c");
    expect(guessLangForBase("kernel.cu")).toBe("c");
    expect(guessLangForBase("blur.glsl")).toBe("c");
    expect(guessLangForBase("f.tpp")).toBeUndefined(); // not claimed (the minimal list ends at ipp)
    expect(resolveSyntaxLang("cpp")).toBe("cpp");
    expect(resolveSyntaxLang("hpp")).toBeUndefined(); // extensions are not aliases
    expect(resolveSyntaxLang("c++")).toBeUndefined(); // no aliases: the fence word is the name
    expect(getTokenizer("cpp")).toBe(tokenizeCpp);
  });
});

describe("tokenizeCpp losslessness", () => {
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
    '""',
    "''",
    '"trail\\',
    "'trail\\",
    "R",
    'R"',
    'R"(',
    'R"(x',
    'R"x',
    'u8R"(',
    'LR"d(',
    'R"(a)"b)"', // the first delimiter wins, the tail re-opens a string: lossless either way
    "1..",
    ".5.",
    "0x",
    "0b2 0o8 1__0",
    "1e 1e+ 0xfflU",
    "1'000", // C++14 separator: number plus an open char scan, lossless
    "[[",
    "]]",
    "[[a",
    "<=>",
    "->*",
    ".*",
    "...",
    "&&=",
    "||=",
    "<<=",
    ">>=",
    "++",
    "--",
    "?:",
    "??",
    "..",
    "?:",
    "struct\nclass namespace",
    "bool wchar_t char8_t size_t",
    "nullptr NULL",
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
    "template<typename T>",
    "co_await x",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeCpp(input);
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
      "[[",
      "]]",
      "{",
      "}",
      ",",
      ":",
      ";",
      ".",
      "..",
      "...",
      "->",
      "->*",
      "::",
      ".*",
      "<=>",
      "&&=",
      "||=",
      "<<",
      ">>",
      "++",
      "?:",
      "??",
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
      "R",
      'R"',
      'R"(',
      'R"(x)"',
      'u8R"(',
      "\\",
      "1",
      "0x1f",
      "07",
      ".5",
      "1e5",
      "10ul",
      "int",
      "bool",
      "void",
      "struct",
      "class",
      "namespace",
      "template",
      "return",
      "nullptr",
      "true",
      "co_await",
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
      const runs = tokenizeCpp(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("cpp tokenizer wiring", () => {
  it("getTokenizer resolves cpp to tokenizeCpp and colors a program sample", () => {
    const code = [
      "#include <vector>",
      "namespace app {",
      "[[nodiscard]] int count(const std::vector<int>& v) noexcept {",
      "  return v.size() + 1;  // member call",
      "}",
      'const char* msg = "hi\\n";',
      "}  // namespace",
    ].join("\n");
    const runs = getTokenizer("cpp")!(code);
    expect(runs.map((r) => r.text).join("")).toBe(code); // the registry contract, held
    expect(runs.filter((r) => r.type === "preproc").map((r) => r.text)).toEqual(["#include <vector>"]);
    expect(runs.filter((r) => r.type === "decorator").map((r) => r.text)).toEqual(["[[nodiscard]]"]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "namespace",
      "const",
      "noexcept",
      "return",
      "const",
    ]);
    // `std::vector` reads plain after the scope arrow (the member refusal);
    // `msg` is lowercase; `app` is the namespace name.
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual(["app", "int", "int", "char"]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual(["count", "size"]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual(["1"]);
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual(['"hi\\n"']);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual(["// member call", "// namespace"]);
  });
});
