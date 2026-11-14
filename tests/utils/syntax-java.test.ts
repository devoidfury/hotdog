// Unit tests for the Java tokenizer (src/utils/syntax/java.ts): typed runs
// with exact classes and spans over targeted fixtures (declaration names,
// annotations with one balanced argument group, the lambda arrow that is
// NOT member access, method refs that are, case-sensitive keywords, char
// literals, and the number dialect with `_` separators and L/F/D suffixes),
// a losslessness sweep over a nasty fixture corpus plus a deterministic
// fragment generator, and the registry wiring pins (.java now resolves
// through the registry).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeJava } from "@utils/syntax/java.ts";
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

describe("tokenizeJava structure", () => {
  it("declaration names, modifiers, and typed signatures read cleanly", () => {
    expect(
      significant(
        tokenizeJava("public class Point extends Vec2 implements Renderable { private final int count; public void draw(double amount) {} }"),
      ),
    ).toEqual([
      run("keyword", "public"),
      run("keyword", "class"),
      run("type", "Point"),
      run("keyword", "extends"),
      run("type", "Vec2"),
      run("keyword", "implements"),
      run("type", "Renderable"),
      run("operator", "{"),
      run("keyword", "private"),
      run("keyword", "final"),
      run("type", "int"),
      run("default", "count"),
      run("operator", ";"),
      run("keyword", "public"),
      run("type", "void"),
      run("fn", "draw"),
      run("operator", "("),
      run("type", "double"),
      run("default", "amount"),
      run("operator", ")"),
      run("operator", "{"),
      run("operator", "}"),
      run("operator", "}"),
    ]);
    // record is a declaration keyword too; the generic angle brackets ride
    // plain operators and the single-letter names take the Capitalized
    // reading (nothing inside `<>` is parsed).
    expect(significant(tokenizeJava("record Pair<K, V>(K key, V value) {}"))).toEqual([
      run("keyword", "record"),
      run("type", "Pair"), // the declaration arm claims the name before the call peek
      run("operator", "<"),
      run("type", "K"),
      run("operator", ","),
      run("type", "V"),
      run("operator", ">"),
      run("operator", "("),
      run("type", "K"),
      run("default", "key"),
      run("operator", ","),
      run("type", "V"),
      run("default", "value"),
      run("operator", ")"),
      run("operator", "{"),
      run("operator", "}"),
    ]);
  });

  it("control flow reads as keywords; the lambda arrow is NOT member access", () => {
    expect(significant(tokenizeJava("for (int i = 0; i < n; i++) {} if (a) {} else {} while (x) {}"))).toEqual([
      run("keyword", "for"),
      run("operator", "("),
      run("type", "int"),
      run("default", "i"),
      run("operator", "="),
      run("number", "0"),
      run("operator", ";"),
      run("default", "i"),
      run("operator", "<"),
      run("default", "n"),
      run("operator", ";"),
      run("default", "i"),
      run("operator", "+"),
      run("operator", "+"),
      run("operator", ")"),
      run("operator", "{"),
      run("operator", "}"),
      run("keyword", "if"),
      run("operator", "("),
      run("default", "a"),
      run("operator", ")"),
      run("operator", "{"),
      run("operator", "}"),
      run("keyword", "else"),
      run("operator", "{"),
      run("operator", "}"),
      run("keyword", "while"),
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
      run("operator", "{"),
      run("operator", "}"),
    ]);
    // `->` is the lambda arrow, not member access: unlike php's `->` it
    // does NOT set the dot flag, so the word after it keeps its readings
    // (`true` is still boolean).
    expect(significant(tokenizeJava("(a, b) -> true"))).toEqual([
      run("operator", "("),
      run("default", "a"),
      run("operator", ","),
      run("default", "b"),
      run("operator", ")"),
      run("operator", "->"),
      run("boolean", "true"),
    ]);
  });

  it("annotations are one decorator run; at most one paren group; bare @ rides default", () => {
    expect(
      significant(
        tokenizeJava('@Override\n@Target({ElementType.FIELD})\n@Named("a)b")\n@Test (timeout = 100)\n@Entity x'),
      ),
    ).toEqual([
      run("decorator", "@Override"),
      run("decorator", "@Target({ElementType.FIELD})"),
      run('decorator', '@Named("a)b")'), // the string is skipped: its `)` cannot cut the run short
      run("decorator", "@Test (timeout = 100)"), // the grammar allows whitespace before `(`
      run("decorator", "@Entity"), // no group: just the glued name
      run("default", "x"),
    ]);
    // Unclosed argument group: runs to end of input, string included.
    expect(significant(tokenizeJava('@Foo("a") @Bar("x'))).toEqual([
      run("decorator", '@Foo("a")'),
      run("decorator", '@Bar("x'),
    ]);
    // A `@` not glued to a name rides default (no bracket arm here).
    expect(significant(tokenizeJava("@\n@[x]"))).toEqual([
      run("default", "@"),
      run("default", "@"),
      run("operator", "["),
      run("default", "x"),
      run("operator", "]"),
    ]);
    // The call peek survives the dot; the member reading itself is refused,
    // and `::` is a member position (`int` after a dot is not the keyword).
    expect(
      significant(
        tokenizeJava("s.trim(); Foo.CONST; Foo::bar; Foo::new(); a.int; x.TRUE; Foo::class"),
      ),
    ).toEqual([
      run("default", "s"),
      run("operator", "."),
      run("fn", "trim"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("type", "Foo"),
      run("operator", "."),
      run("default", "CONST"),
      run("operator", ";"),
      run("type", "Foo"),
      run("operator", "::"),
      run("default", "bar"),
      run("operator", ";"),
      run("type", "Foo"),
      run("operator", "::"),
      run("fn", "new"), // `new` refuses keyword, takes the call peek (documented)
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("default", "a"),
      run("operator", "."),
      run("default", "int"),
      run("operator", ";"),
      run("default", "x"),
      run("operator", "."),
      run("default", "TRUE"),
      run("operator", ";"),
      run("type", "Foo"),
      run("operator", "::"),
      run("default", "class"),
    ]);
  });

  it("comments: two spellings, no nesting, unclosed runs out; Javadoc is ordinary", () => {
    expect(significant(tokenizeJava("// line\n/** javadoc */\nx"))).toEqual([
      run("comment", "// line"),
      run("comment", "/** javadoc */"),
      run("default", "x"),
    ]);
    expect(significant(tokenizeJava("/* outer /* inner */ still */ tail"))).toEqual([
      run("comment", "/* outer /* inner */"),
      run("default", "still"),
      run("operator", "*"),
      run("operator", "/"),
      run("default", "tail"),
    ]);
    expect(significant(tokenizeJava("/* unclosed"))).toEqual([run("comment", "/* unclosed")]);
  });

  it("strings: escapes, splice, unterminated stops at the newline; char literals take the simple rule", () => {
    expect(
      significant(tokenizeJava(String.raw`"a\nb" "e\"q" 'c' '\'' '\n' '\u0041' "un` + "\n" + `tail`)),
    ).toEqual([
      run("string", String.raw`"a\nb"`),
      run("string", String.raw`"e\"q"`),
      run("string", "'c'"),
      run("string", String.raw`'\''`),
      run("string", String.raw`'\n'`),
      run("string", String.raw`'\u0041'`),
      run("string", '"un'),
      run("default", "tail"),
    ]);
    // A backslash before the newline splices the line and the scan carries
    // on to the closer (the c.ts endOfString).
    expect(significant(tokenizeJava('"abc\\\ndef"'))).toEqual([run("string", '"abc\\\ndef"')]);
    // Not a char literal: the shape fails and the quote rides default
    // (`'` is never a lifetime here -- java has none). The common typo
    // `'''` does read as one literal, the documented cost of the rule.
    // (`' '` IS a java literal -- the space character -- so the shape
    // scan takes it; the failing shape here is an unclosed short one.)
    expect(significant(tokenizeJava("'ab' 'a"))).toEqual([
      run("default", "'"),
      run("default", "ab"),
      run("string", "' '"),
      run("default", "a"),
    ]);
  });

  it("keywords are case-sensitive: TRUE/NULL are plain words (the opposite of the php pin)", () => {
    expect(significant(tokenizeJava("true false null TRUE NULL False Class INT int var"))).toEqual([
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
    ]);
  });

  it("numbers: separators, radix, legacy octal, floats, suffixes; half-literals distrust; no 0o, no .5", () => {
    expect(
      significant(
        tokenizeJava("10 1_000 0xFF_FF 0777 0b10_1 6.02e23 1.5 42L 1.5f 3.14d 0 0x 1_ 0778 0o7 .5 1.2.3 1..2"),
      ),
    ).toEqual([
      run("number", "10"),
      run("number", "1_000"),
      run("number", "0xFF_FF"),
      run("number", "0777"),
      run("number", "0b10_1"),
      run("number", "6.02e23"),
      run("number", "1.5"),
      run("number", "42L"),
      run("number", "1.5f"),
      run("number", "3.14d"),
      run("number", "0"),
      run("default", "0x"),
      run("default", "1_"),
      run("default", "0778"),
      // java octal is the legacy `0NNN` only: `0o` is not a radix prefix,
      // so this is the number 0 followed by the word o7 (the opposite of
      // php, and what the real lexer's maximal munch spells).
      run("number", "0"),
      run("default", "o7"),
      run("operator", "."), // java has no leading-dot float: `.5` is a dot and a number
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

  it("multi-char operators are single runs; `=>`, `??`, `..` do not exist and degrade to singles", () => {
    expect(
      significant(tokenizeJava("a == b; c != d; e <= f; g >= h; i && j || k; void f(int... xs); a ?? b; x => y")),
    ).toEqual([
      run("default", "a"),
      run("operator", "=="),
      run("default", "b"),
      run("operator", ";"),
      run("default", "c"),
      run("operator", "!="),
      run("default", "d"),
      run("operator", ";"),
      run("default", "e"),
      run("operator", "<="),
      run("default", "f"),
      run("operator", ";"),
      run("default", "g"),
      run("operator", ">="),
      run("default", "h"),
      run("operator", ";"),
      run("default", "i"),
      run("operator", "&&"),
      run("default", "j"),
      run("operator", "||"),
      run("default", "k"),
      run("operator", ";"),
      run("type", "void"),
      run("fn", "f"),
      run("operator", "("),
      run("type", "int"),
      run("operator", "..."),
      run("default", "xs"),
      run("operator", ")"),
      run("operator", ";"),
      run("default", "a"),
      run("operator", "?"), // no null-coalescing in java: two ternary marks
      run("operator", "?"),
      run("default", "b"),
      run("operator", ";"),
      run("default", "x"),
      run("operator", "="), // no fat arrow in java: equals then greater
      run("operator", ">"),
      run("default", "y"),
    ]);
  });
});

describe("tokenizeJava registry contract", () => {
  it("guesses and fences resolve through the registry", () => {
    expect(guessLangForBase("Main.java")).toBe("java");
    expect(guessLangForBase("Main.JAVA")).toBe("java");
    expect(resolveSyntaxLang("java")).toBe("java");
    expect(resolveSyntaxLang("javax")).toBeUndefined(); // no aliases: the fence word is the name
    expect(getTokenizer("java")).toBe(tokenizeJava);
  });
});

describe("tokenizeJava losslessness", () => {
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
    "@[",
    "@interface",
    "@Foo(",
    '@Foo("',
    "'''",
    "'\\'",
    "$",
    "$$$",
    "0x",
    "1_",
    "0777",
    "0778",
    "0o7",
    "0b",
    ".5",
    "1..2",
    "1.2.3",
    "->",
    "::",
    "...",
    "TRUE NULL False",
    '"unterminated',
    "'unterminated",
    '"splice\\',
    '"""\nabc\n"""',
    "//x\n",
    "🚀 emoji ünïcøde 漢字",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeJava(input);
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
      "@",
      "@[",
      "@Foo",
      "@Foo(",
      "@Foo()",
      "@interface",
      "class",
      "record",
      "public",
      "true",
      "false",
      "TRUE",
      "NULL",
      "null",
      "int",
      "void",
      "var",
      "Widget",
      "MAX_SIZE",
      "Foo",
      "1",
      "0x",
      "1_",
      "1_2",
      "0777",
      "0o7",
      "42L",
      ".5",
      "1..2",
      "->",
      "::",
      "...",
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
      const runs = tokenizeJava(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("java tokenizer wiring", () => {
  it("getTokenizer resolves java to tokenizeJava and classifies a sample", () => {
    const doc = [
      "package com.example;",
      "",
      "import java.util.List;",
      "",
      '@Entity(table = "users")',
      "public class Greeter extends Base implements Wire {",
      "    // greeting cache",
      "    private static final int LIMIT = 10;",
      "    private final String name;",
      "",
      "    public Greeter(String name) {",
      "        this.name = name;",
      "    }",
      "",
      "    public List<String> greetAll() {",
      "        return names.stream().map(s -> prefix + s.trim()).toList(); // pipeline",
      "    }",
      "}",
    ].join("\n");
    const runs = getTokenizer("java")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual([
      "// greeting cache",
      "// pipeline",
    ]);
    expect(runs.filter((r) => r.type === "decorator").map((r) => r.text)).toEqual([
      '@Entity(table = "users")',
    ]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "package",
      "import",
      "public",
      "class",
      "extends",
      "implements",
      "private",
      "static",
      "final",
      "private",
      "final",
      "public",
      "this",
      "public",
      "return",
    ]);
    // The constructor declaration reads "fn" via the call peek (the
    // `class Greeter` declaration arm claimed the first occurrence only).
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual([
      "Greeter",
      "greetAll",
      "stream",
      "map",
      "trim",
      "toList",
    ]);
    // The `List` in `import java.util.List;` is a member position (the dot
    // refuses the Capitalized reading), so the types start at the class.
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual([
      "Greeter",
      "Base",
      "Wire",
      "int",
      "String",
      "String",
      "List",
      "String",
    ]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual(["10"]);
    // The annotation's argument string rides the decorator run (its
    // contents are skipped, not re-classified), like rust attributes.
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual([]);
  });
});
