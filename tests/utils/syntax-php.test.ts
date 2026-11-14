// Unit tests for the PHP tokenizer (src/utils/syntax/php.ts): typed runs
// with exact classes and spans over targeted fixtures (tag delimiters,
// declaration names, attributes, heredoc/nowdoc, interpolation, the two
// line-comment spellings, case-insensitive keywords, and the number
// dialect with `_` separators), a losslessness sweep over a nasty fixture
// corpus plus a deterministic fragment generator, and the registry wiring
// pins (.php now resolves through the registry).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizePhp } from "@utils/syntax/php.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

const TYPES = new Set([
  "preproc",
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

describe("tokenizePhp structure", () => {
  it("declaration names, modifiers, and typed signatures read cleanly", () => {
    expect(
      significant(tokenizePhp("final class Point extends Vec2 implements Renderable { public function draw(int $x): void {} }")),
    ).toEqual([
      run("keyword", "final"),
      run("keyword", "class"),
      run("type", "Point"),
      run("keyword", "extends"),
      run("type", "Vec2"),
      run("keyword", "implements"),
      run("type", "Renderable"),
      run("operator", "{"),
      run("keyword", "public"),
      run("keyword", "function"),
      run("fn", "draw"),
      run("operator", "("),
      run("type", "int"),
      run("variable", "$x"),
      run("operator", ")"),
      run("operator", ":"),
      run("type", "void"),
      run("operator", "{"),
      run("operator", "}"),
      run("operator", "}"),
    ]);
  });

  it("control flow and foreach as/=> read as keywords and operators", () => {
    expect(significant(tokenizePhp("if ($a) {} elseif ($b) {} else {} foreach ($xs as $k => $v) {}"))).toEqual([
      run("keyword", "if"),
      run("operator", "("),
      run("variable", "$a"),
      run("operator", ")"),
      run("operator", "{"),
      run("operator", "}"),
      run("keyword", "elseif"),
      run("operator", "("),
      run("variable", "$b"),
      run("operator", ")"),
      run("operator", "{"),
      run("operator", "}"),
      run("keyword", "else"),
      run("operator", "{"),
      run("operator", "}"),
      run("keyword", "foreach"),
      run("operator", "("),
      run("variable", "$xs"),
      run("keyword", "as"),
      run("variable", "$k"),
      run("operator", "=>"),
      run("variable", "$v"),
      run("operator", ")"),
      run("operator", "{"),
      run("operator", "}"),
    ]);
  });

  it("tag delimiters ride preproc; the template wash is the documented ceiling", () => {
    expect(significant(tokenizePhp("?>\n<html>\n<?= $name ?>\n<?php echo 1;"))).toEqual([
      run("preproc", "?>"),
      run("operator", "<"),
      run("default", "html"),
      run("operator", ">"),
      run("preproc", "<?="),
      run("variable", "$name"),
      run("preproc", "?>"),
      run("preproc", "<?php"),
      run("keyword", "echo"),
      run("number", "1"),
      run("operator", ";"),
    ]);
    // `<?phpx` is not a tag (word boundary); `<?` short tags ride plain.
    expect(significant(tokenizePhp("<?phpx"))).toEqual([
      run("operator", "<"),
      run("operator", "?"),
      run("default", "phpx"),
    ]);
  });

  it("PHP 8 attributes are one decorator run, strings and nested brackets skipped", () => {
    expect(significant(tokenizePhp('#[Route("/x", methods: ["GET"])]\n#[\\Attr]'))).toEqual([
      run("decorator", '#[Route("/x", methods: ["GET"])]'),
      run("decorator", "#[\\Attr]"),
    ]);
    // Unclosed: runs to end of input.
    expect(significant(tokenizePhp('#[Foo("a")] #[Bar'))).toEqual([
      run("decorator", "#[Foo(\"a\")]"),
      run("decorator", "#[Bar"),
    ]);
    // A `#` whose bracket is not glued to a name is the line comment.
    expect(significant(tokenizePhp("#[ x]\n$y"))).toEqual([
      run("comment", "#[ x]"),
      run("variable", "$y"),
    ]);
  });

  it("two line-comment spellings; block comments do NOT nest", () => {
    expect(significant(tokenizePhp("// line\n# hash\n$x"))).toEqual([
      run("comment", "// line"),
      run("comment", "# hash"),
      run("variable", "$x"),
    ]);
    expect(significant(tokenizePhp("/* outer /* inner */ still */ tail"))).toEqual([
      run("comment", "/* outer /* inner */"),
      run("default", "still"),
      run("operator", "*"),
      run("operator", "/"),
      run("default", "tail"),
    ]);
    expect(significant(tokenizePhp("/* unclosed"))).toEqual([run("comment", "/* unclosed")]);
  });

  it("interpolation stays in the string run; member positions refuse keyword/type readings, calls survive", () => {
    expect(
      significant(tokenizePhp('$s = "a $b c {$d[0]} e"; $n = $o->prop; $m = $o->call(); $p = C::FIELD; $q = C::go();')),
    ).toEqual([
      run("variable", "$s"),
      run("operator", "="),
      run("string", '"a $b c {$d[0]} e"'),
      run("operator", ";"),
      run("variable", "$n"),
      run("operator", "="),
      run("variable", "$o"),
      run("operator", "->"),
      run("default", "prop"),
      run("operator", ";"),
      run("variable", "$m"),
      run("operator", "="),
      run("variable", "$o"),
      run("operator", "->"),
      run("fn", "call"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
      run("variable", "$p"),
      run("operator", "="),
      run("type", "C"),
      run("operator", "::"),
      run("default", "FIELD"),
      run("operator", ";"),
      run("variable", "$q"),
      run("operator", "="),
      run("type", "C"),
      run("operator", "::"),
      run("fn", "go"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", ";"),
    ]);
  });

  it("heredoc/nowdoc run to the closer line (indented closer tolerated); unclosed runs out", () => {
    expect(significant(tokenizePhp("<<<EOT\nline $x\nEOT;\n$y = 1;"))).toEqual([
      run("string", "<<<EOT\nline $x\nEOT;"),
      run("variable", "$y"),
      run("operator", "="),
      run("number", "1"),
      run("operator", ";"),
    ]);
    expect(significant(tokenizePhp("$t = <<<'EOT'\nraw\n  EOT;"))).toEqual([
      run("variable", "$t"),
      run("operator", "="),
      run("string", "<<<'EOT'\nraw\n  EOT;"),
    ]);
    expect(significant(tokenizePhp("<<<EOT\nno closer"))).toEqual([run("string", "<<<EOT\nno closer")]);
    // `<<<` with no label on its opener line is not a heredoc: the
    // comparison sandwich rides single-char operators. (A label glued OR
    // spaced on the opener line IS the heredoc opener token to PHP's own
    // lexer, so `a <<< b` washes as a heredoc; documented, honest.)
    expect(significant(tokenizePhp("a <<<\n"))).toEqual([
      run("default", "a"),
      run("operator", "<"),
      run("operator", "<"),
      run("operator", "<"),
    ]);
  });

  it("numbers: separators, radix, legacy octal, floats; half-literals distrust; 1.2.3 stays a lookalike", () => {
    expect(
      significant(tokenizePhp("10 1_000 0xFF_FF 0777 0o7 0b10_1 6.02e23 1.5 .5 0x 1_ 0778 1.2.3")),
    ).toEqual([
      run("number", "10"),
      run("number", "1_000"),
      run("number", "0xFF_FF"),
      run("number", "0777"),
      run("number", "0o7"),
      run("number", "0b10_1"),
      run("number", "6.02e23"),
      run("number", "1.5"),
      run("number", ".5"),
      run("default", "0x"),
      run("default", "1_"),
      run("default", "0778"),
      run("number", "1.2"),
      run("default", ".3"),
    ]);
  });

  it("keywords/booleans/null are case-insensitive; reserved constructs keep the keyword in call position", () => {
    expect(significant(tokenizePhp("TRUE True false NULL null Function CLASS isset($x) match($y)"))).toEqual([
      run("boolean", "TRUE"),
      run("boolean", "True"),
      run("boolean", "false"),
      run("null", "NULL"),
      run("null", "null"),
      run("keyword", "Function"),
      run("keyword", "CLASS"),
      run("keyword", "isset"),
      run("operator", "("),
      run("variable", "$x"),
      run("operator", ")"),
      run("keyword", "match"),
      run("operator", "("),
      run("variable", "$y"),
      run("operator", ")"),
    ]);
  });

  it("multi-char operators are single runs; `...` spread lands, `..` does not exist", () => {
    expect(significant(tokenizePhp("$x?->y; $a ?? $b; $a <=> $b; $a === $b; foo(...$xs); $a ?: $b"))).toEqual([
      run("variable", "$x"),
      run("operator", "?->"),
      run("default", "y"),
      run("operator", ";"),
      run("variable", "$a"),
      run("operator", "??"),
      run("variable", "$b"),
      run("operator", ";"),
      run("variable", "$a"),
      run("operator", "<=>"),
      run("variable", "$b"),
      run("operator", ";"),
      run("variable", "$a"),
      run("operator", "==="),
      run("variable", "$b"),
      run("operator", ";"),
      run("fn", "foo"),
      run("operator", "("),
      run("operator", "..."),
      run("variable", "$xs"),
      run("operator", ")"),
      run("operator", ";"),
      run("variable", "$a"),
      run("operator", "?:"),
      run("variable", "$b"),
    ]);
    // Two adjacent dots never form one run (there is no `..` operator);
    // `1..2` rides number + dot + the float `.2` (the c.ts reading).
    expect(significant(tokenizePhp("$a..$b"))).toEqual([
      run("variable", "$a"),
      run("operator", "."),
      run("operator", "."),
      run("variable", "$b"),
    ]);
    expect(significant(tokenizePhp("1..2"))).toEqual([
      run("number", "1"),
      run("operator", "."),
      run("number", ".2"),
    ]);
  });
});

describe("tokenizePhp registry contract", () => {
  it("guesses and fences resolve through the registry", () => {
    expect(guessLangForBase("index.php")).toBe("php");
    expect(guessLangForBase("Site.PHP")).toBe("php");
    expect(resolveSyntaxLang("php")).toBe("php");
    expect(resolveSyntaxLang("phpx")).toBeUndefined(); // no aliases: the fence word is the name
    expect(getTokenizer("php")).toBe(tokenizePhp);
  });
});

describe("tokenizePhp losslessness", () => {
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
    "<?php",
    "<?PHP",
    "<?phpx",
    "?>",
    "<?=",
    "<?",
    "#",
    "#[",
    "#[]",
    "/*",
    "*/",
    "//",
    '"unterminated',
    "'unterminated",
    '"splice\\',
    "<<<",
    "<<<EOT",
    "<<<'EOT'",
    '<<<"EOT',
    "<<<EOT\nEOTX;\n",
    "<<<EOT\n EOT;",
    "$",
    "$$$",
    "$1",
    "${",
    "0x",
    "1_",
    "0777",
    "0778",
    "0o7",
    "0b",
    ".5",
    "1..2",
    "??",
    "?->",
    "?:",
    "<=>",
    "...",
    "TRUE NULL false",
    "🚀 emoji ünïcøde 漢字",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizePhp(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "<?php",
      "?>",
      "<?=",
      "<?",
      "//",
      "#",
      "#[",
      "#[Attr",
      "/*",
      "*/",
      "//x\n",
      '"',
      "'",
      "\\",
      '"str"',
      "<<<",
      "<<<EOT",
      "EOT;",
      "$",
      "$x",
      "$this",
      "function",
      "class",
      "true",
      "TRUE",
      "NULL",
      "array",
      "int",
      "Widget",
      "MAX_SIZE",
      "1",
      "0x",
      "1_",
      "1_2",
      ".5",
      "->",
      "?->",
      "::",
      "=>",
      "<=>",
      "??",
      "?:",
      "...",
      "==",
      "!",
      "(",
      ")",
      "{",
      "}",
      "<",
      ">",
      ";",
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
      const runs = tokenizePhp(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("php tokenizer wiring", () => {
  it("getTokenizer resolves php to tokenizePhp and classifies a sample", () => {
    const doc = [
      "<?php",
      "namespace App\\Http;",
      "",
      "#[Route('/greet')]",
      "final class Greeter extends Base implements Wire",
      "{",
      "    public function greet(string $name = 'world'): string",
      "    {",
      '        return "hi $name"; // interpolated',
      "    }",
      "}",
    ].join("\n");
    const runs = getTokenizer("php")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc);
    expect(runs.filter((r) => r.type === "preproc").map((r) => r.text)).toEqual(["<?php"]);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual(["// interpolated"]);
    expect(runs.filter((r) => r.type === "decorator").map((r) => r.text)).toEqual(["#[Route('/greet')]"]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "namespace",
      "final",
      "class",
      "extends",
      "implements",
      "public",
      "function",
      "return",
    ]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual(["greet"]);
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual([
      "App",
      "Http",
      "Greeter",
      "Base",
      "Wire",
      "string",
      "string",
    ]);
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual(["'world'", '"hi $name"']);
  });
});
