// Unit tests for the Kotlin tokenizer (src/utils/syntax/kotlin.ts): typed
// runs with exact classes and spans over targeted fixtures (the `fun`
// name arm, raw triple-quoted strings scanning to the first closer with no
// escape processing, nested block comments -- the one java-family rule
// that does NOT transfer, annotations with one balanced argument group,
// case-sensitive keywords with val/var riding hard, the no-octal number
// dialect with the unsigned suffix zoo, and the elvis/not-null/range
// operator runs against the `??`/`...`/`..<` degradations), a losslessness
// sweep over a nasty fixture corpus plus a deterministic fragment
// generator, and the registry wiring pins (.kt/.kts now resolve through
// the registry).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeKotlin } from "@utils/syntax/kotlin.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

// No "variable": kotlin identifiers have no sigils, and `$x` interpolation
// stays inside the string run.
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

describe("tokenizeKotlin structure", () => {
  it("class/fun declarations read cleanly; the fun name rides prevFn", () => {
    expect(
      significant(
        tokenizeKotlin('class Greeter : Base {\n  val items = mutableListOf<String>()\n  fun greet(name: String): String = "hi $name!"\n}'),
      ),
    ).toEqual([
      run("keyword", "class"),
      run("type", "Greeter"), // the declaration arm claims the name before the call peek
      run("operator", ":"), // supertype separation is a plain colon
      run("type", "Base"),
      run("operator", "{"),
      run("keyword", "val"), // val IS a hard keyword here (unlike java's contextual var)
      run("default", "items"),
      run("operator", "="),
      run("default", "mutableListOf"), // lowercase, and `<` not `(` follows: no fn reading
      run("operator", "<"), // generics ride plain operators
      run("type", "String"), // no primitive keywords: Int/String are Capitalized classes
      run("operator", ">"),
      run("operator", "("),
      run("operator", ")"),
      run("keyword", "fun"),
      run("fn", "greet"), // prevFn (php's `function` shape): the name after fun
      run("operator", "("),
      run("default", "name"),
      run("operator", ":"),
      run("type", "String"),
      run("operator", ")"),
      run("operator", ":"),
      run("type", "String"),
      run("operator", "="),
      run("string", '"hi $name!"'), // interpolation stays inside the run
      run("operator", "}"),
    ]);
    // typealias/object names ride the declaration arm; constructor CALLS
    // take the peek just like java.
    expect(significant(tokenizeKotlin("typealias Handler = (Int) -> Unit\nobject Single\nPoint(1)"))).toEqual([
      run("keyword", "typealias"),
      run("type", "Handler"),
      run("operator", "="),
      run("operator", "("),
      run("type", "Int"),
      run("operator", ")"),
      run("operator", "->"),
      run("type", "Unit"),
      run("keyword", "object"),
      run("type", "Single"),
      run("fn", "Point"), // constructor call: the peek claims it, like java
      run("operator", "("),
      run("number", "1"),
      run("operator", ")"),
    ]);
    // The trailing-lambda ceiling (documented, ruby's optional-parens
    // cousin): `map` before `{` gets no fn reading.
    expect(significant(tokenizeKotlin("list.map { it * 2 }"))).toEqual([
      run("default", "list"),
      run("operator", "."),
      run("default", "map"), // no `(`: honest miss
      run("operator", "{"),
      run("default", "it"), // `it` is NOT a keyword
      run("operator", "*"),
      run("number", "2"),
      run("operator", "}"),
    ]);
  });

  it("when/is/as keywords; the lambda arrow keeps the boolean reading", () => {
    expect(
      significant(tokenizeKotlin('when (x) {\n  is Int -> "one"\n  in list -> 2\n  else -> null\n}')),
    ).toEqual([
      run("keyword", "when"),
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
      run("operator", "{"),
      run("keyword", "is"),
      run("type", "Int"),
      run("operator", "->"),
      run("string", '"one"'),
      run("keyword", "in"),
      run("default", "list"),
      run("operator", "->"),
      run("number", "2"),
      run("keyword", "else"),
      run("operator", "->"),
      run("null", "null"),
      run("operator", "}"),
    ]);
    // java's ruling transfers: `->` is the lambda arrow, NOT member
    // access, so the word after it keeps its readings.
    expect(significant(tokenizeKotlin("-> true"))).toEqual([run("operator", "->"), run("boolean", "true")]);
  });

  it("raw strings scan to the first closer with no escapes; interpolation rides inside", () => {
    expect(significant(tokenizeKotlin('x = """\n  line $x ${p}\n"""'))).toEqual([
      run("default", "x"),
      run("operator", "="),
      run("string", '"""\n  line $x ${p}\n"""'), // multiline, holes inside
    ]);
    // A backslash is LITERAL in a raw string, so `\"""` is backslash plus
    // closer -- the adjacent-quote edge the raw scan gets right for free.
    expect(significant(tokenizeKotlin('"""a\\"""'))).toEqual([run("string", '"""a\\"""')]);
    // The documented cost of the first-closer scan: a string whose content
    // ends in a quote (`"""""`) reads as unclosed and runs to end of input.
    expect(significant(tokenizeKotlin('"""""'))).toEqual([run("string", '"""""')]);
    expect(significant(tokenizeKotlin('"""raw'))).toEqual([run("string", '"""raw')]);
    // `""` is the ordinary empty string, not a broken raw opener.
    expect(significant(tokenizeKotlin('x = ""'))).toEqual([
      run("default", "x"),
      run("operator", "="),
      run("string", '""'),
    ]);
    // A quote inside an interpolation hole closes the literal (the holes
    // are not parsed), and the hole's CLOSING quote then opens a fresh
    // string that swallows the `}b` tail: documented cost, lossless
    // either way (ruby's `#{` fixture behaves the same way).
    expect(significant(tokenizeKotlin('x = "a${"in"}b" c'))).toEqual([
      run("default", "x"),
      run("operator", "="),
      run("string", '"a${"'),
      run("keyword", "in"),
      run("string", '"}b"'),
      run("default", "c"),
    ]);
    // Interpreted strings keep the house splice/stop rules.
    expect(significant(tokenizeKotlin('"un\ntail'))).toEqual([run("string", '"un'), run("default", "tail")]);
    expect(significant(tokenizeKotlin('"abc\\\ndef"'))).toEqual([run("string", '"abc\\\ndef"')]);
  });

  it("char literals take the java rule; the `\'\'\'` typo reads as one literal", () => {
    expect(significant(tokenizeKotlin(String.raw`'c' '\'' '\n' '\u0041'`))).toEqual([
      run("string", "'c'"),
      run("string", String.raw`'\''`),
      run("string", String.raw`'\n'`),
      run("string", String.raw`'\u0041'`),
    ]);
    // The common typo reads as one literal, same documented cost as java.
    expect(significant(tokenizeKotlin("'''"))).toEqual([run("string", "'''")]);
    // A failing shape rides default: no string runs at all.
    expect(tokenizeKotlin("'ab' x 'a").filter((r) => r.type === "string")).toEqual([]);
  });

  it("annotations are one decorator run; at most one paren group; bare @ rides default", () => {
    expect(
      significant(
        tokenizeKotlin('@Inject\n@Named("a)b")\n@Test (timeout = 100)\n@Entity x\n@\n@[x]'),
      ),
    ).toEqual([
      run("decorator", "@Inject"),
      run("decorator", '@Named("a)b")'), // the string is skipped: its `)` cannot cut the run short
      run("decorator", "@Test (timeout = 100)"), // the grammar allows whitespace before `(`
      run("decorator", "@Entity"), // no group: just the glued name
      run("default", "x"),
      run("default", "@"), // unglued: plain
      run("default", "@"),
      run("operator", "["),
      run("default", "x"),
      run("operator", "]"),
    ]);
    // Unclosed argument group: runs to end of input.
    expect(significant(tokenizeKotlin('@Foo("a") @Bar("x'))).toEqual([
      run("decorator", '@Foo("a")'),
      run("decorator", '@Bar("x'),
    ]);
    // Use-site targets split at the colon (java arm verbatim, honest):
    // the annotation site rides the decorator, the annotation follows.
    expect(significant(tokenizeKotlin("@field:Nullable"))).toEqual([
      run("decorator", "@field"),
      run("operator", ":"),
      run("type", "Nullable"),
    ]);
  });

  it("comments: // line, nested block (the java rule that does NOT transfer)", () => {
    expect(significant(tokenizeKotlin("// line\n/** kdoc */\nx"))).toEqual([
      run("comment", "// line"),
      run("comment", "/** kdoc */"), // KDoc is an ordinary block comment
      run("default", "x"),
    ]);
    // Kotlin's grammar NESTS block comments (unlike java/cs): the inner
    // pair does not cut the outer run short.
    expect(significant(tokenizeKotlin("/* outer /* inner */ still */ tail"))).toEqual([
      run("comment", "/* outer /* inner */ still */"),
      run("default", "tail"),
    ]);
    // An unmatched closer after the outer closes rides operators.
    expect(significant(tokenizeKotlin("/* x */ */ y"))).toEqual([
      run("comment", "/* x */"),
      run("operator", "*"),
      run("operator", "/"),
      run("default", "y"),
    ]);
    expect(significant(tokenizeKotlin("/* unclosed /* deeper"))).toEqual([
      run("comment", "/* unclosed /* deeper"),
    ]);
  });

  it("keywords are case-sensitive: no primitives, val/var ride hard, it rides default", () => {
    expect(
      significant(tokenizeKotlin("true false null TRUE NULL False Int String val var it this super when")),
    ).toEqual([
      run("boolean", "true"),
      run("boolean", "false"),
      run("null", "null"),
      run("default", "TRUE"),
      run("default", "NULL"),
      run("type", "False"), // the Capitalized heuristic, not the boolean reading
      run("type", "Int"), // no primitive keywords: Int is an ordinary Capitalized class
      run("type", "String"),
      run("keyword", "val"),
      run("keyword", "var"), // hard keywords here, unlike java's contextual var
      run("default", "it"), // the implicit lambda parameter is not a keyword
      run("keyword", "this"),
      run("keyword", "super"),
      run("keyword", "when"),
    ]);
  });

  it("numbers: NO octal ever, separators, radix, unsigned suffixes; half-literals distrust; no .5", () => {
    expect(
      significant(
        tokenizeKotlin("10 1_000 0xFF_FF 0777 0778 0b10_1 6.02e23 1.0e-3 1.5 42L 1.5f 128u 1uL 1UL 0 0x 1_ 0b2 .5 1.2.3 1..2 1ull"),
      ),
    ).toEqual([
      run("number", "10"),
      run("number", "1_000"),
      run("number", "0xFF_FF"),
      // kotlin has NO octal in ANY spelling (not even the legacy `0NNN`):
      // `0777` is a plain decimal, pinned like cs.ts did.
      run("number", "0777"),
      run("number", "0778"),
      run("number", "0b10_1"),
      run("number", "6.02e23"),
      run("number", "1.0e-3"),
      run("number", "1.5"),
      run("number", "42L"),
      run("number", "1.5f"),
      run("number", "128u"), // kotlin's unsigned literals are real
      run("number", "1uL"),
      run("number", "1UL"),
      run("number", "0"),
      run("default", "0x"),
      run("default", "1_"),
      run("default", "0b2"), // the radix scan eats the `2`, the shape check distrusts the whole run
      run("operator", "."), // no leading-dot float: `.5` is a dot and a number
      run("number", "5"),
      run("number", "1.2"),
      run("operator", "."),
      run("number", "3"),
      run("number", "1"),
      run("operator", ".."), // the range IS an operator run
      run("number", "2"),
      // The ill-formed suffix tail is declined: the number keeps `1`, and
      // `ull` rides as the ordinary word it degrades to.
      run("number", "1"),
      run("default", "ull"),
    ]);
  });

  it("operators: elvis, !!, === and .. are runs; :: and ?. set dot; ??, ..., ..<, => degrade", () => {
    expect(
      significant(tokenizeKotlin("a === b; c !== d; x ?: y; v!!; o?.trim(); f = { x -> x }")),
    ).toEqual([
      run("default", "a"),
      run("operator", "==="), // reference identity IS a three-char run
      run("default", "b"),
      run("operator", ";"),
      run("default", "c"),
      run("operator", "!=="),
      run("default", "d"),
      run("operator", ";"),
      run("default", "x"),
      run("operator", "?:"), // the elvis IS one run (cs lacked it; kotlin has it)
      run("default", "y"),
      run("operator", ";"),
      run("default", "v"),
      run("operator", "!!"), // the not-null assertion IS one run
      run("operator", ";"),
      run("default", "o"),
      run("operator", "?."), // safe call IS a member position (the cs ruling)
      run("fn", "trim"), // the call peek survives the safe call
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("default", "f"),
      run("operator", "="),
      run("operator", "{"),
      run("default", "x"),
      run("operator", "->"),
      run("default", "x"),
      run("operator", "}"),
    ]);
    // `::` (callable refs) IS a member position; after it even a loud or
    // Capitalized name is a plain member name.
    expect(significant(tokenizeKotlin("Foo::bar; Foo::BAR; Foo::new()"))).toEqual([
      run("type", "Foo"),
      run("operator", "::"),
      run("default", "bar"),
      run("operator", ";"),
      run("type", "Foo"),
      run("operator", "::"),
      run("default", "BAR"),
      run("operator", ";"),
      run("type", "Foo"),
      run("operator", "::"),
      run("fn", "new"), // `new` is not a kotlin keyword; the call peek takes it
      run("operator", "("),
      run("operator", ")"),
    ]);
    // The non-rulings degrade to singles: `??` is two ternary marks (the
    // null-coalescing spelling is elvis `?:`), `1...2` is the range plus a
    // dot, `..<` (the 1.9 stdlib gesture) is range-plus-less-than, `=>` is
    // equals-then-greater.
    expect(significant(tokenizeKotlin("x ?? y; 1...2; a..<b; x => y"))).toEqual([
      run("default", "x"),
      run("operator", "?"),
      run("operator", "?"),
      run("default", "y"),
      run("operator", ";"),
      run("number", "1"),
      run("operator", ".."),
      run("operator", "."),
      run("number", "2"),
      run("operator", ";"),
      run("default", "a"),
      run("operator", ".."),
      run("operator", "<"),
      run("default", "b"),
      run("operator", ";"),
      run("default", "x"),
      run("operator", "="),
      run("operator", ">"),
      run("default", "y"),
    ]);
  });
});

describe("tokenizeKotlin registry contract", () => {
  it("guesses and fences resolve through the registry", () => {
    expect(guessLangForBase("Main.kt")).toBe("kotlin");
    expect(guessLangForBase("settings.KTS")).toBe("kotlin");
    expect(resolveSyntaxLang("kotlin")).toBe("kotlin");
    expect(resolveSyntaxLang("kt")).toBeUndefined(); // an extension is not an alias
    expect(getTokenizer("kotlin")).toBe(tokenizeKotlin);
  });
});

describe("tokenizeKotlin losslessness", () => {
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
    "*/",
    "//",
    "/*",
    "/* /* */",
    "'''",
    "@",
    "@[",
    "@Foo(",
    '@Foo("',
    "@field:",
    '"""',
    '""""',
    '"""""',
    '""""""',
    '"""a\\"""',
    "${",
    "$x",
    "0x",
    "1_",
    "0b",
    "0b2",
    "0777",
    "0778",
    "0o7",
    ".5",
    "1..2",
    "1.2.3",
    "1ull",
    "->",
    "::",
    "?:",
    "!!",
    "===",
    "!==",
    "??",
    "...",
    "..<",
    "TRUE False",
    '"unterminated',
    "'unterminated",
    '"splice\\',
    '"""raw',
    "fun",
    "val",
    "it",
    "🚀 emoji ünïcøde 漢字",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeKotlin(input);
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
      "@",
      "@Foo",
      "@Foo(",
      "fun",
      "val",
      "var",
      "class",
      "object",
      "when",
      "true",
      "null",
      "TRUE",
      "it",
      "this",
      "Widget",
      "MAX_SIZE",
      "Int",
      "1",
      "0x",
      "1_",
      "1_2",
      "0777",
      "0b2",
      "128u",
      "1ull",
      ".5",
      "1..2",
      "->",
      "::",
      "?.",
      "?:",
      "!!",
      "===",
      "!==",
      "??",
      "...",
      "..<",
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
      const runs = tokenizeKotlin(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("kotlin tokenizer wiring", () => {
  it("getTokenizer resolves kotlin to tokenizeKotlin and classifies a sample", () => {
    const doc = [
      "package com.example",
      "",
      "import java.util.Locale",
      "",
      "@Entity",
      "class Greeter(private val name: String) : Base() {",
      "    companion object {",
      "        const val LIMIT = 10",
      "    }",
      "",
      "    // greeting cache",
      "    fun greetAll(names: List<String>): List<String> {",
      '        return names.map { it.trim() }.joinToString(" ") // pipeline',
      "    }",
      "}",
    ].join("\n");
    const runs = getTokenizer("kotlin")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual([
      "// greeting cache",
      "// pipeline",
    ]);
    expect(runs.filter((r) => r.type === "decorator").map((r) => r.text)).toEqual(["@Entity"]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "package",
      "import",
      "class",
      "private",
      "val",
      "companion",
      "object",
      "const",
      "val",
      "fun",
      "return",
    ]);
    // `Base()` is the superclass constructor CALL, which takes the peek
    // like any `Foo(...)`; `map` sits behind a trailing lambda and gets
    // none, honestly.
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual([
      "Base",
      "greetAll",
      "trim",
      "joinToString",
    ]);
    // `Locale` sits behind a dot (member position: the Capitalized reading
    // is refused); `LIMIT` is an all-caps constant, not Capitalized.
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual([
      "Greeter",
      "String",
      "List",
      "String",
      "List",
      "String",
    ]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual(["10"]);
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual(['" "']);
  });
});
