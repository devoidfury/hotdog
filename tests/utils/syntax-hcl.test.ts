// Unit tests for the HCL tokenizer (src/utils/syntax/hcl.ts): the language
// with NO reserved words (no keyword class at all -- `for`/`in`/`if` ride
// default; no terraform vocabulary list, the cmake-doctrine rejection),
// the batch's signature identifier rule (UAX #31 plus the dash: `my-var`
// is ONE word, `x-1` is the spec's own subtraction trap, `a - 1` with air
// is arithmetic), the same-line `=` key glue with the pinned NO on `:`
// (the for-colon and ternary cost beats the rare JSON-flavored object
// spelling), the call peek as the only fn reading (survives the dot),
// both comment spellings plus the NEVER-nested block form, quoted
// templates with `${...}`/`%{...}` holes riding the run (a quote inside a
// hole closes the literal, the documented `"${join(", ", x)}"` cost),
// heredocs with glued labels and no quoted forms, the decimal-only number
// set with its pinned degradations, and the `$` that arms nothing at top
// level -- plus losslessness and registry pins (.tf/.tfvars/.hcl claimed,
// no aliases).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeHcl } from "@utils/syntax/hcl.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

// No keyword, no type, no variable, no decorator: the NO-reserved-words
// decision drops the whole vocabulary family. "key" is the same-line `=`
// glue; "fn" is the call peek.
const TYPES = new Set([
  "comment",
  "string",
  "number",
  "boolean",
  "null",
  "key",
  "fn",
  "operator",
  "default",
]);

const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeHcl structure", () => {
  it("a terraform resource: block headers are plain words, keys glue on `=`", () => {
    const code = [
      'resource "aws_s3_bucket" "web" {',
      '  bucket = "acme-web"',
      "  force_destroy = true",
      "}",
    ].join("\n");
    expect(significant(tokenizeHcl(code))).toEqual([
      run("default", "resource"), // NO terraform vocabulary list (the cmake STREQUAL rejection)
      run("string", '"aws_s3_bucket"'),
      run("string", '"web"'),
      run("operator", "{"),
      run("key", "bucket"), // identifier plus same-line `=` (json.ts's reading narrowed)
      run("operator", "="),
      run("string", '"acme-web"'),
      run("key", "force_destroy"),
      run("operator", "="),
      run("boolean", "true"),
      run("operator", "}"),
    ]);
  });

  it("THE SIGNATURE: identifiers carry dashes (the spec's own trap pinned)", () => {
    expect(significant(tokenizeHcl("my-var = 1"))).toEqual([
      run("key", "my-var"), // ONE word, not word-minus-word
      run("operator", "="),
      run("number", "1"),
    ]);
    expect(significant(tokenizeHcl("a - 1"))).toEqual([
      run("default", "a"), // with air, arithmetic
      run("operator", "-"),
      run("number", "1"),
    ]);
    expect(significant(tokenizeHcl("x-1"))).toEqual([
      run("default", "x-1"), // the spec's subtraction trap: one identifier, not a difference
    ]);
    expect(significant(tokenizeHcl("my-var-2\ntrailing-"))).toEqual([
      run("default", "my-var-2"), // digits and dashes ride together
      run("default", "trailing-"), // the greedy grammar eats the trailing dash
    ]);
  });

  it("NO reserved words: for/in/if ride default; booleans/null are lowercase-only", () => {
    expect(significant(tokenizeHcl("true false null True NULL for in if"))).toEqual([
      run("boolean", "true"),
      run("boolean", "false"),
      run("null", "null"),
      run("default", "True"), // case-sensitive: `True` is just a variable here
      run("default", "NULL"),
      run("default", "for"), // the honest NO-keyword decision: the spec has NO reserved words
      run("default", "in"),
      run("default", "if"),
    ]);
    // The for expression rides as plain words plus structural singles:
    expect(significant(tokenizeHcl("{for i, v in x : v => i}"))).toEqual([
      run("operator", "{"),
      run("default", "for"),
      run("default", "i"),
      run("operator", ","),
      run("default", "v"),
      run("default", "in"),
      run("default", "x"),
      run("operator", ":"),
      run("default", "v"), // `=>` denies the key glue (v is a value, not a key)
      run("operator", "=>"),
      run("default", "i"),
      run("operator", "}"),
    ]);
  });

  it("keys: the `=` must not head `==`/`=>`, the newline is a wall, and `:` is NOT glue (pinned)", () => {
    expect(significant(tokenizeHcl("foo = 1\nfoo == 2"))).toEqual([
      run("key", "foo"),
      run("operator", "="),
      run("number", "1"),
      run("default", "foo"), // a comparison is not an attribute definition
      run("operator", "=="),
      run("number", "2"),
    ]);
    expect(significant(tokenizeHcl("foo\n= 1"))).toEqual([
      run("default", "foo"), // the glue is SAME-LINE only: the newline is a wall
      run("operator", "="),
      run("number", "1"),
    ]);
    expect(significant(tokenizeHcl("{foo: 1}"))).toEqual([
      run("operator", "{"),
      run("default", "foo"), // THE DECISION: `:` does NOT glue keys
      run("operator", ":"), // (the for-colon and ternary shapes win over the rare object spelling)
      run("number", "1"),
      run("operator", "}"),
    ]);
    // The parenthesized-key shape keeps its `=` as the operator single:
    expect(significant(tokenizeHcl("{(foo) = 1}"))).toEqual([
      run("operator", "{"),
      run("operator", "("),
      run("default", "foo"),
      run("operator", ")"),
      run("operator", "="),
      run("number", "1"),
      run("operator", "}"),
    ]);
  });

  it("fn is the call peek ONLY, surviving the dot", () => {
    expect(significant(tokenizeHcl("length(x)"))).toEqual([
      run("fn", "length"),
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
    ]);
    expect(significant(tokenizeHcl("data.aws_ami.x"))).toEqual([
      run("default", "data"), // no paren, no reading: the reference chain rides plain
      run("operator", "."),
      run("default", "aws_ami"),
      run("operator", "."),
      run("default", "x"),
    ]);
    expect(significant(tokenizeHcl("aws_api.thing(1)"))).toEqual([
      run("default", "aws_api"),
      run("operator", "."),
      run("fn", "thing"), // the peek survives the dot (the house rule)
      run("operator", "("),
      run("number", "1"),
      run("operator", ")"),
    ]);
    // Indexing never lifts a word, and there is no prevFn arm (no def):
    expect(significant(tokenizeHcl("list[0]"))).toEqual([
      run("default", "list"),
      run("operator", "["),
      run("number", "0"),
      run("operator", "]"),
    ]);
  });

  it("numbers: decimal-only, and every degradation pinned", () => {
    expect(significant(tokenizeHcl("0 123 1.5 1e10 1.5e-3 0777"))).toEqual([
      run("number", "0"),
      run("number", "123"),
      run("number", "1.5"),
      run("number", "1e10"), // the exponent needs no dot
      run("number", "1.5e-3"),
      run("number", "0777"), // no octal: leading zeros are decimals
    ]);
    expect(significant(tokenizeHcl("0x1f 1_0 1e .5 1.2.3"))).toEqual([
      run("number", "0"), // NO hex (pinned): number plus word
      run("default", "x1f"),
      run("number", "1"), // NO underscore separators: the scan splits at the `_`
      run("default", "_0"),
      run("number", "1"), // a dangling exponent is not a number
      run("default", "e"),
      run("operator", "."), // no leading-dot float
      run("number", "5"),
      run("number", "1.2"), // the second fraction is not consumed
      run("operator", "."),
      run("number", "3"),
    ]);
  });

  it("comments: `#` AND `//` to EOL, the NEVER-nested block form", () => {
    expect(significant(tokenizeHcl("# hash\n// slashes\n/* block */ code"))).toEqual([
      run("comment", "# hash"), // two line spellings, both first-class
      run("comment", "// slashes"),
      run("comment", "/* block */"),
      run("default", "code"),
    ]);
    expect(significant(tokenizeHcl("/* a /* b */ c */"))).toEqual([
      run("comment", "/* a /* b */"), // NEVER nested: the first closer ends it...
      run("default", "c"),
      run("operator", "*"), // ...and the tail re-reads as singles
      run("operator", "/"),
    ]);
    expect(tokenizeHcl("/* open")).toEqual([run("comment", "/* open")]); // unclosed: end of input
    // A `/` that opens nothing is the division single:
    expect(significant(tokenizeHcl("a / b"))).toEqual([
      run("default", "a"),
      run("operator", "/"),
      run("default", "b"),
    ]);
  });

  it("quoted templates: escapes, holes ride the run, the hole-quote cost pinned", () => {
    expect(significant(tokenizeHcl('"hi ${name} bye" "%{ if x }y%{ endif }"'))).toEqual([
      run("string", '"hi ${name} bye"'), // `${...}` rides inside (the rust ruling)
      run("string", '"%{ if x }y%{ endif }"'), // `%{...}` directives too
    ]);
    expect(significant(tokenizeHcl('"a\\nb \\"q\\" \\u00e9"'))).toEqual([
      run("string", '"a\\nb \\"q\\" \\u00e9"'), // the escape family rides the generic backslash skip
    ]);
    // The documented cost: holes legally contain quoted strings, and a
    // quote inside a hole closes the literal (holes are not parsed):
    expect(significant(tokenizeHcl('"${join(", ", x)}"'))).toEqual([
      run("string", '"${join("'),
      run("operator", ","),
      run("string", '", x)}"'),
    ]);
    // Holes are STRING-ONLY: at top level `$` arms nothing (the pin),
    // and `%{` is the modulo plus a brace:
    expect(significant(tokenizeHcl("$foo"))).toEqual([
      run("default", "$"),
      run("default", "foo"),
    ]);
    expect(significant(tokenizeHcl("%{ x }"))).toEqual([
      run("operator", "%"),
      run("operator", "{"),
      run("default", "x"),
      run("operator", "}"),
    ]);
  });

  it("heredocs: glued labels, the closer line, `<<-` indentation, no quoted forms", () => {
    const code = ["msg = <<EOT", "line ${x}", "EOT", "tail"].join("\n");
    expect(significant(tokenizeHcl(code))).toEqual([
      run("key", "msg"),
      run("operator", "="),
      run("string", "<<EOT\nline ${x}\nEOT"), // interpolation rides the run; the closer ends right after the label
      run("default", "tail"), // the closer line's tail rides the next run
    ]);
    expect(significant(tokenizeHcl("<<-EOT\n  indented\n  EOT"))).toEqual([
      run("string", "<<-EOT\n  indented\n  EOT"), // `<<-` tolerates an indented closer
    ]);
    // The bare spelling wants column 0:
    expect(significant(tokenizeHcl("<<EOT\n  EOT x"))).toEqual([
      run("string", "<<EOT\n  EOT x"), // indented closer does NOT close a bare `<<`: the run ate it as content
    ]);
    // Dashed labels follow the identifier rule:
    expect(significant(tokenizeHcl("<<MY-TAG\nx\nMY-TAG"))).toEqual([
      run("string", "<<MY-TAG\nx\nMY-TAG"),
    ]);
    // Quoted labels DO NOT exist here (ruby's forms are gone), air is no
    // heredoc, and the foreign `~` marker degrades:
    expect(significant(tokenizeHcl('<<"EOT"\n<< EOT\n<<~EOT'))).toEqual([
      run("operator", "<"),
      run("operator", "<"),
      run("string", '"EOT"'),
      run("operator", "<"),
      run("operator", "<"),
      run("default", "EOT"),
      run("operator", "<"),
      run("operator", "<"),
      run("default", "~"),
      run("default", "EOT"),
    ]);
    // `a << b`: there is NO shift in this language, just two singles:
    expect(significant(tokenizeHcl("a << b"))).toEqual([
      run("default", "a"),
      run("operator", "<"),
      run("operator", "<"),
      run("default", "b"),
    ]);
  });

  it("operators: `...` first, the two-char runs, `?`/`:` separate singles", () => {
    expect(significant(tokenizeHcl("f(a...) x .... y"))).toEqual([
      run("fn", "f"),
      run("operator", "("),
      run("default", "a"),
      run("operator", "..."), // THREE-char checked first (the dart lesson)
      run("operator", ")"),
      run("default", "x"),
      run("operator", "..."), // `....` is the spread plus a member dot
      run("operator", "."),
      run("default", "y"),
    ]);
    expect(significant(tokenizeHcl("a && b || c <= d >= e == f != g"))).toEqual([
      run("default", "a"),
      run("operator", "&&"),
      run("default", "b"),
      run("operator", "||"),
      run("default", "c"),
      run("operator", "<="),
      run("default", "d"),
      run("operator", ">="),
      run("default", "e"),
      run("operator", "=="),
      run("default", "f"),
      run("operator", "!="),
      run("default", "g"),
    ]);
    expect(significant(tokenizeHcl("c ? 1 : 0"))).toEqual([
      run("default", "c"),
      run("operator", "?"), // the ternary is NOT a run: separate singles (pinned)
      run("number", "1"),
      run("operator", ":"),
      run("number", "0"),
    ]);
    expect(significant(tokenizeHcl("!x 10 % 3 a & b | c"))).toEqual([
      run("operator", "!"), // negation single
      run("default", "x"),
      run("number", "10"),
      run("operator", "%"), // modulo single
      run("number", "3"),
      run("default", "a"),
      run("operator", "&"), // leftover singles of the logical pair
      run("default", "b"),
      run("operator", "|"),
      run("default", "c"),
    ]);
    // No role at top level: tilde, at-sign, semicolon, backtick, backslash
    // ride DEFAULT bytes (they surface here because significant() keeps
    // non-blank default runs -- what is pinned is that none is an operator):
    expect(significant(tokenizeHcl("~ @ ; ` \\"))).toEqual([
      run("default", "~"),
      run("default", "@"),
      run("default", ";"),
      run("default", "`"),
      run("default", "\\"),
    ]);
  });
});

describe("tokenizeHcl line-wise degradation (the file view tokenizes per line)", () => {
  it("an unterminated string stops at the newline; the next line re-reads", () => {
    // Scanner reality: the assignment shapes on BOTH lines still read as
    // keys; only the string literal dies at the newline.
    expect(tokenizeHcl('x = "abc\ny = 1')).toEqual([
      run("key", "x"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("string", '"abc'),
      run("default", "\n"),
      run("key", "y"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("number", "1"),
    ]);
  });

  it("a block comment reaches its closer across newlines; unclosed runs on", () => {
    // Scanner reality (the c.ts indexOf shape): the block comment is NOT
    // line-bounded; it ends at the first closer wherever it lives, and
    // only an unclosed opener runs to end of the given input.
    expect(tokenizeHcl("x /* open\ny */ 1")).toEqual([
      run("default", "x"),
      run("default", " "),
      run("comment", "/* open\ny */"), // the closer is found a line down
      run("default", " "),
      run("number", "1"),
    ]);
    expect(tokenizeHcl("x /* open")).toEqual([
      run("default", "x"),
      run("default", " "),
      run("comment", "/* open"), // per line: no closer here, end of input
    ]);
  });

  it("an unclosed heredoc swallows its line alone; the whole pass sees the literal", () => {
    const code = "<<EOT\ntext\nEOT";
    expect(tokenizeHcl(code)).toEqual([run("string", "<<EOT\ntext\nEOT")]); // whole pass: one heredoc
    expect(tokenizeHcl("<<EOT")).toEqual([run("string", "<<EOT")]); // per line: unclosed opener
    expect(tokenizeHcl("text")).toEqual([run("default", "text")]);
    expect(tokenizeHcl("EOT")).toEqual([run("default", "EOT")]); // the orphan closer is plain junk
  });

  it("the orphan closer line of a heredoc re-reads as a plain word", () => {
    expect(tokenizeHcl("EOT")).toEqual([run("default", "EOT")]);
  });
});

describe("tokenizeHcl registry contract", () => {
  it("guesses and fences resolve through the registry", () => {
    expect(guessLangForBase("main.tf")).toBe("hcl");
    expect(guessLangForBase("terraform.tfvars")).toBe("hcl"); // via the extension, no basename needed
    expect(guessLangForBase("main.hcl")).toBe("hcl");
    expect(guessLangForBase("MAIN.TF")).toBe("hcl"); // extensions are case-insensitive
    expect(guessLangForBase("variables.tf.json")).toBe("json"); // the last-dot rule: the JSON profile IS json
    expect(guessLangForBase("file.hclx")).toBeUndefined();
    expect(guessLangForBase("tf")).toBeUndefined(); // dotless stem
    expect(resolveSyntaxLang("hcl")).toBe("hcl");
    expect(resolveSyntaxLang("tf")).toBeUndefined(); // extensions are never aliases
    expect(resolveSyntaxLang("tfvars")).toBeUndefined();
    expect(resolveSyntaxLang("terraform")).toBeUndefined(); // an application, not a syntax name
    expect(resolveSyntaxLang("HCL")).toBeUndefined(); // the canonical name resolves exactly
    expect(resolveSyntaxLang("hcl-native-thing")).toBeUndefined(); // a made-up fence word
    expect(getTokenizer("hcl")).toBe(tokenizeHcl);
  });
});

describe("tokenizeHcl losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\n",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "a".repeat(50000),
    "\\",
    '"',
    "#",
    "/",
    "//",
    "/*",
    "*/",
    "$",
    "$${",
    "%",
    "%{",
    "my-",
    "x-1",
    "-",
    "?",
    ":",
    "? :",
    "=>",
    "=",
    "==",
    "...",
    "....",
    "<<",
    "<<-",
    "<<EOT",
    "<<-EOT",
    "<<~EOT",
    "<< EOT",
    "<<EOT unterm",
    "<<MY-TAG\nx\nMY-TAG",
    '"unterminated',
    '"splice\\',
    '"${',
    '"${join(", ", x)}"',
    "1e",
    "1e+",
    "1_0",
    "0x",
    ".5",
    "1..2",
    "true",
    "false",
    "null",
    "🚀 emoji ünïcøde 漢字",
    "x\r\nfoo = 1",
    "()[]{}",
    "@ ~ ; `",
    "a\u00a0b", // NBSP is not the isWs family: the high unicode rides words/bytes
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeHcl(input);
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
      "//",
      "/*",
      "*/",
      '"',
      '"unterm',
      "${",
      "%{",
      "}",
      "$",
      "$${",
      "%",
      "<<",
      "<<-",
      "<<EOT",
      "EOT",
      "\n",
      "\r\n",
      "\t",
      " ",
      "my-",
      "x-1",
      "-",
      "=",
      "==",
      "=>",
      "?",
      ":",
      "...",
      "&&",
      "||",
      "!=",
      "<=",
      ">=",
      "!",
      "&",
      "|",
      "(",
      ")",
      "[",
      "]",
      "{",
      ",",
      ".",
      "/",
      "+",
      "*",
      "1e",
      "1_0",
      "0x",
      ".5",
      "42",
      "true",
      "null",
      "for",
      "in",
      "foo",
      "🚀",
      "~",
      "@",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeHcl(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("hcl tokenizer wiring", () => {
  it("getTokenizer resolves hcl to tokenizeHcl and classes a real terraform file", () => {
    const code = [
      "# The network stack.",
      "locals {",
      "  az-count = length(var.azs)",
      "  by_name  = {for n in var.subnets : n => n * 2}",
      '  banner   = "<<not-a-heredoc"',
      "}",
      "",
      'resource "aws_subnet" "private" {',
      "  count             = local.az-count",
      '  cidr_block        = "10.0.${count.index}.0/24"',
      "  availability_zone = var.azs[count.index]",
      "  tags = {",
      '    Name = "private-${count.index}"',
      "  }",
      "  enable_dns = true",
      "}",
      "",
      'provider "aws" {',
      '  version = "~> 5.0"',
      "  region  = null",
      "}",
    ].join("\n");
    const runs = getTokenizer("hcl")!(code);
    expect(runs.map((r) => r.text).join("")).toBe(code); // the registry contract, held
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual(["# The network stack."]);
    expect(runs.filter((r) => r.type === "key").map((r) => r.text)).toEqual([
      "az-count", // dashed key (the signature rule at work)
      "by_name",
      "banner",
      "count",
      "cidr_block",
      "availability_zone",
      "tags",
      "Name",
      "enable_dns",
      "version",
      "region",
    ]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual(["length"]);
    expect(runs.filter((r) => r.type === "boolean").map((r) => r.text)).toEqual(["true"]);
    expect(runs.filter((r) => r.type === "null").map((r) => r.text)).toEqual(["null"]);
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual([
      '"<<not-a-heredoc"', // the `<<` INSIDE a string is bytes (the string arm runs first)
      '"aws_subnet"', // block labels are just strings
      '"private"',
      '"10.0.${count.index}.0/24"', // the hole rides the run; the `/24` is string bytes too
      '"private-${count.index}"',
      '"aws"', // the provider block label
      '"~> 5.0"',
    ]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual(["2"]); // `n * 2`; the dotted digits all live inside strings
    expect(runs.filter((r) => r.type === "operator" && r.text === "=>").map((r) => r.text)).toEqual(["=>"]);
    // The keyword class does not exist: not even for the block words.
    expect(runs.filter((r) => r.type === "keyword")).toEqual([]);
  });
});
