// Unit tests for the Zig tokenizer (src/utils/syntax/zig.ts): typed runs with
// exact classes and spans over targeted fixtures (the c.ts family with the
// zig deltas: NO block comments at all -- the C-shaped opener sequence
// degrades to two operator singles, a spec pin; the `\\` multiline string
// line raw through EOL with the `@`-builtin arm reading "fn" paren or not;
// the reference's 46-word keyword table with `true`/`false` on boolean and
// `null`/`undefined` on null; the lowercase builtin types riding "type" --
// the language where lowercase words ARE types; the wrapping/saturating and
// concatenation operator runs with `&&`/`**`/`->` rejected), a losslessness
// sweep over a nasty fixture corpus plus a deterministic fragment generator,
// and the registry wiring pins.

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeZig } from "@utils/syntax/zig.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

// No "preproc" (`#` is not a Zig token), no "decorator" (`@`-builtins are
// fn), no "variable", no "key".
const TYPES = new Set([
  "comment",
  "string",
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

describe("tokenizeZig structure", () => {
  it("a declaration line: keyword, fn builtin, string, comment to EOL", () => {
    expect(significant(tokenizeZig('const std = @import("std"); // the standard library'))).toEqual([
      run("keyword", "const"),
      run("default", "std"), // a plain word: no paren ahead
      run("operator", "="),
      run("fn", "@import"), // the @-builtin arm is one fn run
      run("operator", "("),
      run("string", '"std"'),
      run("operator", ")"),
      run("operator", ";"),
      run("comment", "// the standard library"),
    ]);
  });

  it("fn declarations take the prevFn reading; primitives and type words ride type", () => {
    const code = [
      "pub fn main() !void {",
      "  var x: u8 = 3;",
      "}",
      "fn add(a: u32, b: u32) u32 { return a + b; }",
    ].join("\n");
    expect(significant(tokenizeZig(code))).toEqual([
      run("keyword", "pub"),
      run("keyword", "fn"),
      run("fn", "main"), // prevFn: the name after fn is the declaration
      run("operator", "("),
      run("operator", ")"),
      run("operator", "!"), // error union: a plain single
      run("type", "void"),
      run("operator", "{"),
      run("keyword", "var"),
      run("default", "x"),
      run("operator", ":"),
      run("type", "u8"),
      run("operator", "="),
      run("number", "3"),
      run("operator", ";"),
      run("operator", "}"),
      run("keyword", "fn"),
      run("fn", "add"),
      run("operator", "("),
      run("default", "a"),
      run("operator", ":"),
      run("type", "u32"),
      run("operator", ","),
      run("default", "b"),
      run("operator", ":"),
      run("type", "u32"),
      run("operator", ")"),
      run("type", "u32"),
      run("operator", "{"),
      run("keyword", "return"),
      run("default", "a"),
      run("operator", "+"),
      run("default", "b"),
      run("operator", ";"),
      run("operator", "}"),
    ]);
  });

  it("Capitalized names read as types; the dot refuses every reading but the call peek", () => {
    expect(significant(tokenizeZig("const p = Point{ .x = 1 };\nconst c = Color.red;\nconst m = obj.method(2);"))).toEqual([
      run("keyword", "const"),
      run("default", "p"),
      run("operator", "="),
      run("type", "Point"), // Capitalized heuristic
      run("operator", "{"),
      run("operator", "."), // struct literal field: the dot sets the member flag
      run("default", "x"), // and the field rides plain (no key reading)
      run("operator", "="),
      run("number", "1"),
      run("operator", "}"),
      run("operator", ";"),
      run("keyword", "const"),
      run("default", "c"),
      run("operator", "="),
      run("type", "Color"),
      run("operator", "."),
      run("default", "red"), // after a dot, even the type reading is refused
      run("operator", ";"),
      run("keyword", "const"),
      run("default", "m"),
      run("operator", "="),
      run("default", "obj"),
      run("operator", "."),
      run("fn", "method"), // the call peek survives the dot
      run("operator", "("),
      run("number", "2"),
      run("operator", ")"),
      run("operator", ";"),
    ]);
  });

  it("booleans, null, undefined and unreachable: the value words sort out", () => {
    expect(significant(tokenizeZig("if (true) unreachable;\nvar v: ?u8 = undefined;\nconst z = null;"))).toEqual([
      run("keyword", "if"),
      run("operator", "("),
      run("boolean", "true"),
      run("operator", ")"),
      run("keyword", "unreachable"), // a keyword per the reference table
      run("operator", ";"),
      run("keyword", "var"),
      run("default", "v"),
      run("operator", ":"),
      run("operator", "?"), // optional type: a plain single
      run("type", "u8"),
      run("operator", "="),
      run("null", "undefined"), // the third primitive value rides null (ruling)
      run("operator", ";"),
      run("keyword", "const"),
      run("default", "z"),
      run("operator", "="),
      run("null", "null"),
      run("operator", ";"),
    ]);
    // Case-sensitivity: True/False take the Capitalized reading, the rest
    // are plain words (the kotlin False/Nil precedent).
    expect(significant(tokenizeZig("True FALSE Null Undefined"))).toEqual([
      run("type", "True"),
      run("default", "FALSE"),
      run("type", "Null"),
      run("type", "Undefined"),
    ]);
  });

  it("the keyword table is the reference's own: `error` in, `use` gone, keywords keep source case", () => {
    const code = [
      "errdefer x.deinit();",
      "const e: anyerror!Err = error.OutOfMemory;",
      "comptime { switch (1) { else => {} } }",
      "const u = use;",
    ].join("\n");
    expect(significant(tokenizeZig(code))).toEqual([
      run("keyword", "errdefer"),
      run("default", "x"),
      run("operator", "."),
      run("fn", "deinit"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("keyword", "const"),
      run("default", "e"),
      run("operator", ":"),
      run("type", "anyerror"), // a primitive type
      run("operator", "!"),
      run("type", "Err"), // Capitalized
      run("operator", "="),
      run("keyword", "error"), // a keyword per the table
      run("operator", "."),
      run("default", "OutOfMemory"), // after the dot: plain
      run("operator", ";"),
      run("keyword", "comptime"),
      run("operator", "{"),
      run("keyword", "switch"),
      run("operator", "("),
      run("number", "1"),
      run("operator", ")"),
      run("operator", "{"),
      run("keyword", "else"),
      run("operator", "=>"), // the switch prong is one run
      run("operator", "{"),
      run("operator", "}"),
      run("operator", "}"),
      run("operator", "}"),
      run("keyword", "const"),
      run("default", "u"),
      run("operator", "="),
      run("default", "use"), // `use` is OFF the master keyword table (spec pin)
      run("operator", ";"),
    ]);
  });

  it("@-builtins read fn even with no paren; a bare @ rides default", () => {
    expect(significant(tokenizeZig("const T = @This();\nconst f = @embedFile;\nx @ y;"))).toEqual([
      run("keyword", "const"),
      run("type", "T"), // a one-letter Capitalized name is type-shaped like any other
      run("operator", "="),
      run("fn", "@This"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("keyword", "const"),
      run("default", "f"),
      run("operator", "="),
      run("fn", "@embedFile"), // the documented wash: no paren, still fn
      run("operator", ";"),
      run("default", "x"),
      run("default", "@"), // @ not glued to a name is not an operator either
      run("default", "y"),
      run("operator", ";"),
    ]);
  });

  it("multiline string lines: the `\\\\` marker rides a raw run through EOL", () => {
    const code = ["const c =", " \\\\#include <stdio.h>", ' \\\\ printf("hello\\n");', ";"].join("\n");
    expect(significant(tokenizeZig(code))).toEqual([
      run("keyword", "const"),
      run("default", "c"),
      run("operator", "="),
      run("string", "\\\\#include <stdio.h>"), // raw: `"` is a byte, `%` etc. plain
      run("string", '\\\\ printf("hello\\n");'), // the leading indent is a whitespace run; the string starts at `\\`
      run("operator", ";"),
    ]);
    // The escape is NOT processed: `\n` inside is two bytes of the run.
    expect(tokenizeZig('\\\\ a\\nb "q"')).toEqual([run("string", '\\\\ a\\nb "q"')]);
  });

  it("NO block comments: the C-shaped opener pair degrades to two operator singles", () => {
    expect(significant(tokenizeZig("a /* b */ c"))).toEqual([
      run("default", "a"),
      run("operator", "/"),
      run("operator", "*"),
      run("default", "b"),
      run("operator", "*"),
      run("operator", "/"),
      run("default", "c"),
    ]);
    // `//` is the only comment form; doc comments ride it too.
    expect(significant(tokenizeZig("/// doc\n//! top-level\n// plain"))).toEqual([
      run("comment", "/// doc"),
      run("comment", "//! top-level"),
      run("comment", "// plain"),
    ]);
  });

  it("numbers: all three radices, separators, floats, hex floats with p-exponent", () => {
    expect(
      significant(tokenizeZig("0 42 0x1f 0XFF 0o755 0b1_1111 1_000_000 1.5 1e10 123.0e+77 299_792_458.000_000")),
    ).toEqual([
      run("number", "0"),
      run("number", "42"),
      run("number", "0x1f"),
      run("number", "0XFF"), // both prefix cases
      run("number", "0o755"), // zig HAS 0o (the dart contrast)
      run("number", "0b1_1111"),
      run("number", "1_000_000"), // separators are real everywhere
      run("number", "1.5"),
      run("number", "1e10"),
      run("number", "123.0e+77"),
      run("number", "299_792_458.000_000"),
    ]);
    // Hex floats are REAL with fractional mantissa and optional p (the
    // reference spells both `0x103.70p-5` and the p-less `0x103.70`).
    expect(significant(tokenizeZig("0x103.70p-5 0x103.70 0x1p3"))).toEqual([
      run("number", "0x103.70p-5"),
      run("number", "0x103.70"),
      run("number", "0x1p3"),
    ]);
    // Shape validation and the NO-suffix ruling: ill-formed tails ride
    // default whole or split at the scan's honest stop.
    expect(
      significant(tokenizeZig("0x 1_ 0xFF_ 0o8 0b2 0x.5 1.2.3 1u8")),
    ).toEqual([
      run("default", "0x"), // no digits after the prefix
      run("default", "1_"), // a trailing separator is not a number
      run("default", "0xFF_"),
      run("default", "0o"), // the octal scan declines the 8; it re-reads as a number
      run("number", "8"),
      run("default", "0b"),
      run("number", "2"),
      run("default", "0x.5"), // hex digits must start before the dot
      run("number", "1.2"), // no leading-dot float: the tail dot is an operator
      run("operator", "."),
      run("number", "3"),
      run("number", "1"), // no suffix zoo (dart ruling): `u8` is the type word
      run("type", "u8"),
    ]);
  });

  it("operators: compound assignment, wrapping, saturating, concatenation", () => {
    const code =
      "a += b -= c *= d /= e %= f &= g |= h ^= i <<= j >>= k";
    expect(significant(tokenizeZig(code))).toEqual([
      run("default", "a"),
      run("operator", "+="),
      run("default", "b"),
      run("operator", "-="),
      run("default", "c"),
      run("operator", "*="),
      run("default", "d"),
      run("operator", "/="),
      run("default", "e"),
      run("operator", "%="),
      run("default", "f"),
      run("operator", "&="),
      run("default", "g"),
      run("operator", "|="),
      run("default", "h"),
      run("operator", "^="),
      run("default", "i"),
      run("operator", "<<="),
      run("default", "j"),
      run("operator", ">>="),
      run("default", "k"),
    ]);
    expect(
      significant(tokenizeZig("m +% n -% o *% p +| q -| r *| s <<| t <<|= u")),
    ).toEqual([
      run("default", "m"),
      run("operator", "+%"),
      run("default", "n"),
      run("operator", "-%"),
      run("default", "o"),
      run("operator", "*%"),
      run("default", "p"),
      run("operator", "+|"),
      run("default", "q"),
      run("operator", "-|"),
      run("default", "r"),
      run("operator", "*|"),
      run("default", "s"),
      run("operator", "<<|"),
      run("default", "t"),
      run("operator", "<<|="), // the house's only four-char run
      run("default", "u"),
    ]);
    expect(significant(tokenizeZig("p.* q.? r ++ s || t .. u"))).toEqual([
      run("default", "p"),
      run("operator", ".*"), // deref-all: a run AND a member gesture
      run("default", "q"),
      run("operator", ".?"), // optional unwrap
      run("default", "r"),
      run("operator", "++"), // array concatenation
      run("default", "s"),
      run("operator", "||"), // vector concatenation (NOT logical or)
      run("default", "t"),
      run("operator", ".."), // range
      run("default", "u"),
    ]);
  });

  it("rejected sequences degrade: `&&`, `**`, `->`, `<=>` are not Zig tokens", () => {
    expect(significant(tokenizeZig("a && b ** c -> d <=> e ... f"))).toEqual([
      run("default", "a"),
      run("operator", "&"), // logical and is the KEYWORD `and`
      run("operator", "&"),
      run("default", "b"),
      run("operator", "*"), // the power operator was removed
      run("operator", "*"),
      run("default", "c"),
      run("operator", "-"), // no arrow in this language
      run("operator", ">"),
      run("default", "d"),
      run("operator", "<="), // the two-chunker eats `<=`, then the arrow tail
      run("operator", ">"),
      run("default", "e"),
      run("operator", ".."), // the range beats the lone dots
      run("operator", "."),
      run("default", "f"),
    ]);
    // `and`/`or`/`!` are the real logical vocabulary.
    expect(significant(tokenizeZig("a and !b or c"))).toEqual([
      run("default", "a"),
      run("keyword", "and"),
      run("operator", "!"),
      run("default", "b"),
      run("keyword", "or"),
      run("default", "c"),
    ]);
  });

  it("arrays, slices and sentinel pointers: the brackets ride operator singles", () => {
    expect(significant(tokenizeZig("const a: [32]u8 = x; const b: [*:0]const u8 = y; const s: []u8 = z;"))).toEqual([
      run("keyword", "const"),
      run("default", "a"),
      run("operator", ":"),
      run("operator", "["),
      run("number", "32"),
      run("operator", "]"),
      run("type", "u8"),
      run("operator", "="),
      run("default", "x"),
      run("operator", ";"),
      run("keyword", "const"),
      run("default", "b"),
      run("operator", ":"),
      run("operator", "["),
      run("operator", "*"),
      run("operator", ":"),
      run("number", "0"),
      run("operator", "]"),
      run("keyword", "const"),
      run("type", "u8"),
      run("operator", "="),
      run("default", "y"),
      run("operator", ";"),
      run("keyword", "const"),
      run("default", "s"),
      run("operator", ":"),
      run("operator", "["),
      run("operator", "]"),
      run("type", "u8"),
      run("operator", "="),
      run("default", "z"),
      run("operator", ";"),
    ]);
  });

  it("control flow with captures: `|item|` rides plain operators; calls peek fn", () => {
    expect(significant(tokenizeZig("while (it.next()) |item| { try item.write(); }"))).toEqual([
      run("keyword", "while"),
      run("operator", "("),
      run("default", "it"),
      run("operator", "."),
      run("fn", "next"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", ")"),
      run("operator", "|"),
      run("default", "item"),
      run("operator", "|"),
      run("operator", "{"),
      run("keyword", "try"),
      run("default", "item"),
      run("operator", "."),
      run("fn", "write"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("operator", "}"),
    ]);
  });
});

describe("tokenizeZig line-wise degradation (the file view tokenizes per line)", () => {
  it("an unterminated string stops at the newline; the splice carries on", () => {
    expect(tokenizeZig('a "oops\nset')).toEqual([
      run("default", "a"),
      run("default", " "),
      run("string", '"oops'),
      run("default", "\n"),
      run("default", "set"),
    ]);
    expect(tokenizeZig('"abc\\\ndef"')).toEqual([run("string", '"abc\\\ndef"')]);
  });

  it("each `\\\\` line is its own run under per-line calls", () => {
    expect(tokenizeZig("\\\\one")).toEqual([run("string", "\\\\one")]);
    expect(tokenizeZig("\\\\two")).toEqual([run("string", "\\\\two")]);
    expect(tokenizeZig("\\")).toEqual([run("default", "\\")]); // a lone backslash is just a byte
  });
});

describe("tokenizeZig registry contract", () => {
  it("guesses and fences resolve through the registry", () => {
    expect(guessLangForBase("main.zig")).toBe("zig");
    expect(guessLangForBase("build.zig")).toBe("zig");
    expect(guessLangForBase("MAIN.ZIG")).toBe("zig");
    expect(guessLangForBase("root.zigz")).toBeUndefined(); // unclaimed extension
    expect(guessLangForBase("zig")).toBeUndefined(); // no dot, no basename claim
    expect(resolveSyntaxLang("zig")).toBe("zig");
    expect(resolveSyntaxLang("ZIG")).toBeUndefined(); // no aliases: the fence word is the name
    expect(resolveSyntaxLang("ziglang")).toBeUndefined();
    expect(getTokenizer("zig")).toBe(tokenizeZig);
  });
});

describe("tokenizeZig losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\n",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "a".repeat(50000),
    "\\",
    "\\\\",
    "\\\n",
    "\\\\unterminated multiline",
    '"',
    "'",
    '"unterminated',
    "'unterminated",
    '"splice\\',
    "//c",
    "/*",
    "*/",
    "@",
    "@@",
    "@1",
    "@import",
    "@This(",
    "0x",
    "0o",
    "0b",
    "0x.",
    "0x1.2.3",
    "1_",
    ".5",
    "..",
    ".?",
    ".*",
    "<<|",
    "<<|=",
    "+|=",
    "=>",
    "&&",
    "**",
    "||",
    "++",
    "<=>",
    "...",
    "?",
    "!",
    "type",
    "anyframe",
    "undefined",
    "null",
    "use",
    "fn",
    "fn (",
    "pub fn",
    "#",
    "$",
    "🚀 emoji ünïcøde 漢字",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeZig(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "\\",
      "\\\\",
      "\\\\x",
      '"',
      "'",
      '"s"',
      "//",
      "/*",
      "@",
      "@import",
      "@(",
      "fn",
      "pub",
      "const",
      "u8",
      "anyerror",
      "type",
      "undefined",
      "null",
      "true",
      "0x1f",
      "0x",
      "0o7",
      "1_0",
      "1e",
      "<<|=",
      "<<|",
      "+%=",
      "+|",
      "=>",
      "..",
      ".?",
      ".*",
      "&&",
      "||",
      "++",
      "**",
      "<=>",
      ";",
      ":",
      "?",
      "!",
      "*",
      "&",
      "|",
      "=",
      "(",
      ")",
      "[",
      "]",
      "{",
      "}",
      " ",
      "\n",
      "\r\n",
      "\t",
      "🚀",
      "x",
      "Foo",
      "unreachable",
      '"unterminated',
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeZig(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("zig tokenizer wiring", () => {
  it("getTokenizer resolves zig to tokenizeZig and colors a real sample", () => {
    const code = [
      'const std = @import("std");',
      "pub const Allocator = struct {",
      "  ptr: *anyopaque,",
      "  fn alloc(self: *Allocator, n: usize) ![]u8 {",
      "    return self.raw(self, n) catch return error.OutOfMemory;",
      "  }",
      "};",
    ].join("\n");
    const runs = getTokenizer("zig")!(code);
    expect(runs.map((r) => r.text).join("")).toBe(code); // the registry contract, held
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual([
      "@import",
      "alloc",
      "raw",
    ]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "const",
      "pub",
      "const",
      "struct",
      "fn",
      "return",
      "catch",
      "return",
      "error",
    ]);
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual([
      "Allocator", // Capitalized (twice: the const binding and the parameter)
      "anyopaque",
      "Allocator",
      "usize",
      "u8",
    ]);
    // Allocator reads type twice (Capitalized after `const`, and after the
    // struct DECL arm); the parameter names ride plain.
    expect(runs.filter((r) => r.type === "type" || r.type === "default").filter((r) => r.text === "Allocator").map((r) => r.type)).toEqual(["type", "type"]);
  });
});
