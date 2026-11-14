// Unit tests for the Nix tokenizer (src/utils/syntax/nix.ts): the batch's
// signature degrade (`//` is the attribute-set UPDATE operator, NOT a
// comment; comments are `#` lines and star-slash blocks that NEVER nest),
// the spec's exact ten reserved words (`or` unconditionally -- its name
// leak is the pinned false positive; `null`/`import`/`builtins` are plain
// identifiers and NO null class exists), the ASCII identifier with
// apostrophe and hyphen, quoted strings that LEGALLY SPAN LINES (an
// unterminated one runs to end of input, not the newline) with `${...}`
// holes riding the run (a quote inside a hole closes the literal), the
// `''` indented form with its exact escape polarity (closing unless
// followed by `'`, `$` or `\`; `''${` is a literal hole opener; `$` alone
// means nothing), path literals (`./x`, `../y`, `/abs`, `~/home`, the bare
// glued `builder.sh/out`) and bare URI literals as "string" class, the
// same-line `=` key glue with the pinned NO on `:` (the lambda arrow),
// `...` as the lone three-char operator (checked before two-char: `|>`
// `<|` included), the decimal-only numbers with the manual's own leading
// `.27e13` float and the pinned `0x1f`/`1_0` degradations, and `<nixpkgs>`
// NOT scanned -- plus losslessness and registry pins (.nix only, no
// basenames needed).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeNix } from "@utils/syntax/nix.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

// No null, no type, no decorator: Nix has NO null literal (the erlang
// ruling) and casing means nothing (no type reading, the hcl doctrine).
const TYPES = new Set([
  "comment",
  "string",
  "number",
  "boolean",
  "keyword",
  "key",
  "fn",
  "operator",
  "default",
]);

const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeNix structure", () => {
  it("THE SIGNATURE: `//` is the update operator, NOT a comment", () => {
    expect(significant(tokenizeNix("a // b"))).toEqual([
      run("default", "a"),
      run("operator", "//"), // the attribute-set update (the manual's table)
      run("default", "b"),
    ]);
    expect(significant(tokenizeNix("# hash\nx = 1;\n/* block */ y"))).toEqual([
      run("comment", "# hash"),
      run("key", "x"),
      run("operator", "="),
      run("number", "1"),
      run("operator", ";"),
      run("comment", "/* block */"),
      run("default", "y"),
    ]);
    expect(significant(tokenizeNix("/* a /* b */ c */"))).toEqual([
      run("comment", "/* a /* b */"), // NEVER nested (the spec proves it outright)
      run("default", "c"),
      run("operator", "*"), // ...and the tail re-reads as singles
      run("operator", "/"),
    ]);
    // `//` arms before the path arm can (a path wants ONE slash):
    expect(significant(tokenizeNix("//c"))).toEqual([
      run("operator", "//"),
      run("default", "c"),
    ]);
  });

  it("keywords: the spec's exact ten; no null literal; builtins are plain", () => {
    expect(significant(tokenizeNix("with assert inherit if then else let in rec or null true false import builtins True"))).toEqual([
      run("keyword", "with"),
      run("keyword", "assert"),
      run("keyword", "inherit"),
      run("keyword", "if"),
      run("keyword", "then"),
      run("keyword", "else"),
      run("keyword", "let"),
      run("keyword", "in"),
      run("keyword", "rec"),
      run("keyword", "or"),
      run("default", "null"), // Nix has NO null literal: a plain identifier, no null class
      run("boolean", "true"),
      run("boolean", "false"),
      run("default", "import"), // a builtin VALUE, not a keyword
      run("default", "builtins"),
      run("default", "True"), // case-sensitive booleans
    ]);
    // `or` is keyword unconditionally (contextual select default); the
    // pinned false positive: `{ or = 2; }` (legal legacy spelling).
    expect(significant(tokenizeNix("{ a.b.c or 1; or = 2; }"))).toEqual([
      run("operator", "{"),
      run("default", "a"),
      run("operator", "."),
      run("default", "b"),
      run("operator", "."),
      run("default", "c"),
      run("keyword", "or"),
      run("number", "1"),
      run("operator", ";"),
      run("keyword", "or"), // the leak: reads as a keyword here, pinned
      run("operator", "="),
      run("number", "2"),
      run("operator", ";"),
      run("operator", "}"),
    ]);
  });

  it("keys: same-line `=` glue, attr paths key the LAST name, `:` is NOT glue", () => {
    expect(significant(tokenizeNix("{ foo = 1; a.b = c; x == 2; }"))).toEqual([
      run("operator", "{"),
      run("key", "foo"),
      run("operator", "="),
      run("number", "1"),
      run("operator", ";"),
      run("default", "a"), // the dot is a wall...
      run("operator", "."),
      run("key", "b"), // ...so the attribute path keys only the last name
      run("operator", "="),
      run("default", "c"),
      run("operator", ";"),
      run("default", "x"), // a comparison is not a binding
      run("operator", "=="),
      run("number", "2"),
      run("operator", ";"),
      run("operator", "}"),
    ]);
    expect(significant(tokenizeNix("x\n= 1;"))).toEqual([
      run("default", "x"), // the glue is SAME-LINE only: the newline is a wall
      run("operator", "="),
      run("number", "1"),
      run("operator", ";"),
    ]);
    // THE DECISION: `:` arms nothing -- it is the lambda arrow:
    expect(significant(tokenizeNix("x: body"))).toEqual([
      run("default", "x"), // a lambda parameter is a plain word
      run("operator", ":"),
      run("default", "body"),
    ]);
  });

  it("fn is the call peek ONLY (keywords win it); lambdas stay plain", () => {
    expect(significant(tokenizeNix("map (x: x) [ 1 2 ]"))).toEqual([
      run("fn", "map"),
      run("operator", "("),
      run("default", "x"),
      run("operator", ":"),
      run("default", "x"),
      run("operator", ")"),
      run("operator", "["),
      run("number", "1"),
      run("number", "2"),
      run("operator", "]"),
    ]);
    expect(significant(tokenizeNix("with (import ./d.nix);"))).toEqual([
      run("keyword", "with"), // keyword BEFORE the call peek
      run("operator", "("),
      run("default", "import"), // no paren directly after it: plain word
      run("string", "./d.nix"),
      run("operator", ")"),
      run("operator", ";"),
    ]);
    // Application is juxtaposition; a bare `f` before a word rides default:
    expect(significant(tokenizeNix("f z; a.b.c"))).toEqual([
      run("default", "f"),
      run("default", "z"),
      run("operator", ";"),
      run("default", "a"),
      run("operator", "."),
      run("default", "b"),
      run("operator", "."),
      run("default", "c"),
    ]);
  });

  it("identifiers: ASCII with apostrophes and hyphens; unicode rides bytes", () => {
    expect(significant(tokenizeNix("my-var = x'-y';"))).toEqual([
      run("key", "my-var"), // dashes ride (the hcl family trait)
      run("operator", "="),
      run("default", "x'-y'"), // and so do apostrophes (the spec's grammar)
      run("operator", ";"),
    ]);
    // Raw runs: `significant()`'s trim() also eats NBSP (JS whitespace),
    // so the byte pin goes against the unfiltered scanner.
    expect(tokenizeNix("a\u00a0b")).toEqual([
      run("default", "a"),
      run("default", "\u00a0"), // high unicode is not an identifier char here: its own byte
      run("default", "b"),
    ]);
  });

  it("paths and URIs read as one string literal each", () => {
    expect(significant(tokenizeNix("./x.nix ../y /abs/p ~/home builder.sh/out pkg/lib.nix"))).toEqual([
      run("string", "./x.nix"),
      run("string", "../y"),
      run("string", "/abs/p"),
      run("string", "~/home"),
      run("string", "builder.sh/out"), // the manual's bare-path example
      run("string", "pkg/lib.nix"),
    ]);
    expect(significant(tokenizeNix("a / b"))).toEqual([
      run("default", "a"), // division wants air, as the language states
      run("operator", "/"),
      run("default", "b"),
    ]);
    expect(significant(tokenizeNix("http://example.org/x.tar.bz2 (https://a.b:8080/p?q=1)"))).toEqual([
      run("string", "http://example.org/x.tar.bz2"), // bare URIs are literals
      run("operator", "("),
      run("string", "https://a.b:8080/p?q=1"),
      run("operator", ")"),
    ]);
    // The grammar matches ANY scheme:chars, so `x:x` is a URI (pinned);
    // a space after the colon is the lambda/read shape, not a URI:
    expect(significant(tokenizeNix("x:x foo: bar"))).toEqual([
      run("string", "x:x"),
      run("default", "foo"),
      run("operator", ":"),
      run("default", "bar"),
    ]);
    // Lookup paths are NOT scanned (they collide with `<`): pinned degrade.
    expect(significant(tokenizeNix("import <nixpkgs>"))).toEqual([
      run("default", "import"),
      run("operator", "<"),
      run("default", "nixpkgs"),
      run("operator", ">"),
    ]);
  });

  it("numbers: decimals and floats (leading dot included), every degrade pinned", () => {
    expect(significant(tokenizeNix("0 123 1.5 .27e13 1e10 1.5e-3 0777"))).toEqual([
      run("number", "0"),
      run("number", "123"),
      run("number", "1.5"),
      run("number", ".27e13"), // the manual's own leading-dot float
      run("number", "1e10"),
      run("number", "1.5e-3"),
      run("number", "0777"), // no octal form: leading zeros are decimals
    ]);
    expect(significant(tokenizeNix("0x1f 1_0 1e 1.2.3 0."))).toEqual([
      run("number", "0"), // NO hex (pinned): number plus word
      run("default", "x1f"),
      run("number", "1"), // NO underscore separators (pinned)
      run("default", "_0"),
      run("number", "1"), // a dangling exponent is not a number
      run("default", "e"),
      run("number", "1.2"), // the second fraction re-reads as a leading-dot float
      run("number", ".3"),
      run("number", "0"), // a trailing dot is the member single
      run("operator", "."),
    ]);
    // Negation is a separate operator (the manual: literals parse as unary minus):
    expect(significant(tokenizeNix("-1"))).toEqual([run("operator", "-"), run("number", "1")]);
  });

  it("quoted strings: multi-line, holes ride, the hole-quote cost pinned", () => {
    expect(significant(tokenizeNix('"a\nb" "x ${y} z" "esc \\" \\\\ \\n"'))).toEqual([
      run("string", '"a\nb"'), // newlines are LEGAL inside (the manual)
      run("string", '"x ${y} z"'), // `${...}` rides the run (the rust ruling)
      run("string", '"esc \\" \\\\ \\n"'), // escapes ride the backslash skip
    ]);
    expect(significant(tokenizeNix('"${ "q" }"'))).toEqual([
      run("string", '"${ "'), // the hole's quote CLOSES the literal, pinned cost
      run("default", "q"),
      run("string", '" }"'),
    ]);
    // `\$` and `$${` ride their strings without special shapes:
    expect(significant(tokenizeNix('"\\${" "$${"'))).toEqual([
      run("string", '"\\${"'),
      run("string", '"$${"'),
    ]);
  });

  it("indented '' strings: the escape polarity pinned", () => {
    expect(significant(tokenizeNix("''\n  literal $out and ''${PATH}\n''"))).toEqual([
      run("string", "''\n  literal $out and ''${PATH}\n''"), // `$` is literal unless `${`; `''${` rides as the escaped hole opener
    ]);
    expect(significant(tokenizeNix("''it''''s''"))).toEqual([
      run("string", "''it''''s''"), // `''` closes UNLESS followed by `'`, `$` or `\`
    ]);
    expect(significant(tokenizeNix("''a''b''"))).toEqual([
      run("string", "''a''"), // `''b`: the closer wins (b is no escape)...
      run("default", "b''"), // ...and the greedy identifier eats the rest
    ]);
    expect(significant(tokenizeNix("''x''$y''"))).toEqual([
      run("string", "''x''$y''"), // `''$` is the escaped dollar: one run
    ]);
  });

  it("operators: `...` first, the two-char runs, the single set, the byte set", () => {
    expect(significant(tokenizeNix("f { ... }: x ... .. ."))).toEqual([
      run("default", "f"),
      run("operator", "{"),
      run("operator", "..."), // THREE-char, checked before anything two
      run("operator", "}"),
      run("operator", ":"),
      run("default", "x"),
      run("operator", "..."),
      run("operator", "."), // `..` is NOT a run: two singles
      run("operator", "."),
      run("operator", "."),
    ]);
    expect(significant(tokenizeNix("a == b != c <= d >= e && f || g -> h ++ i |> j <| k"))).toEqual([
      run("default", "a"),
      run("operator", "=="),
      run("default", "b"),
      run("operator", "!="),
      run("default", "c"),
      run("operator", "<="),
      run("default", "d"),
      run("operator", ">="),
      run("default", "e"),
      run("operator", "&&"),
      run("default", "f"),
      run("operator", "||"),
      run("default", "g"),
      run("operator", "->"),
      run("default", "h"),
      run("operator", "++"),
      run("default", "i"),
      run("operator", "|>"), // the experimental pipe pair (the manual's table)
      run("default", "j"),
      run("operator", "<|"),
      run("default", "k"),
    ]);
    // No `%`, `&`, `|`, `~`, `@`, `$` or backtick operator: plain bytes
    // (`$` arms NOTHING at top level, the hcl pin; `@`-patterns ride one):
    expect(significant(tokenizeNix("$ % & | ~ @ ` args@{ x }: x"))).toEqual([
      run("default", "$"),
      run("default", "%"),
      run("default", "&"),
      run("default", "|"),
      run("default", "~"),
      run("default", "@"),
      run("default", "`"),
      run("default", "args"),
      run("default", "@"),
      run("operator", "{"),
      run("default", "x"),
      run("operator", "}"),
      run("operator", ":"),
      run("default", "x"),
    ]);
  });
});

describe("tokenizeNix line-wise degradation (the file view tokenizes per line)", () => {
  it("an unterminated quoted string runs to END OF INPUT, not the newline", () => {
    // Scanner reality (and the language): newlines are LEGAL inside `"`
    // strings, so a per-line pass of the file view swallows the line and a
    // whole-file pass keeps scanning past every newline.
    expect(tokenizeNix('x = "abc\ny = 1;')).toEqual([
      run("key", "x"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("string", '"abc\ny = 1;'), // the newline is string material here
    ]);
  });

  it("a block comment reaches its closer across newlines; unclosed runs on", () => {
    expect(tokenizeNix("x /* open\ny */ 1")).toEqual([
      run("default", "x"),
      run("default", " "),
      run("comment", "/* open\ny */"),
      run("default", " "),
      run("number", "1"),
    ]);
    expect(tokenizeNix("x /* open")).toEqual([
      run("default", "x"),
      run("default", " "),
      run("comment", "/* open"),
    ]);
  });

  it("an unclosed '' string swallows the given input; `#` stops at the newline", () => {
    expect(tokenizeNix("''\n  tail")).toEqual([run("string", "''\n  tail")]);
    expect(tokenizeNix("# c\nx")).toEqual([run("comment", "# c"), run("default", "\n"), run("default", "x")]);
  });
});

describe("tokenizeNix registry contract", () => {
  it("guesses and fences resolve through the registry", () => {
    expect(guessLangForBase("flake.nix")).toBe("nix");
    expect(guessLangForBase("default.nix")).toBe("nix");
    expect(guessLangForBase("shell.nix")).toBe("nix"); // no basenames needed
    expect(guessLangForBase("MAIN.NIX")).toBe("nix"); // case-insensitive extensions
    expect(guessLangForBase("file.nixx")).toBeUndefined();
    expect(guessLangForBase("nix")).toBeUndefined(); // dotless stem
    expect(resolveSyntaxLang("nix")).toBe("nix");
    expect(resolveSyntaxLang("NIX")).toBeUndefined(); // the canonical name resolves exactly
    expect(resolveSyntaxLang("nixos")).toBeUndefined(); // an application, not a syntax name
    expect(resolveSyntaxLang("nix-flake")).toBeUndefined(); // a made-up fence word
    expect(getTokenizer("nix")).toBe(tokenizeNix);
  });
});

describe("tokenizeNix losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\n",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "a".repeat(50000),
    "#",
    "//",
    "/*",
    "*/",
    "'",
    "''",
    "'''",
    "''''",
    "''''''",
    '"',
    '"unterm',
    "$",
    "${",
    "$${",
    "%",
    "&",
    "|",
    "@",
    "`",
    "^",
    "~",
    "~/",
    "~x",
    "./",
    "../",
    "...",
    "..",
    ".",
    ".5",
    ".27e13",
    "0x",
    "1_0",
    "1e",
    "1e+",
    "->",
    "|>",
    "<|",
    "++",
    "==",
    "=",
    "?",
    ":",
    ";",
    ",",
    "{",
    "}",
    "[",
    "]",
    "(",
    ")",
    "\\",
    "builder.sh",
    "a/b",
    "x:x",
    "http://",
    "import",
    "or",
    "null",
    "true",
    "false",
    "True",
    "a\u00a0b", // NBSP is not the isWs family: it rides its own byte
    "rocket emoji ünïcøde 漢字",
    "''${",
    "''$x",
    "''a''",
    "x=",
    "x==",
    "a-",
    "a'",
    "-1",
    "0",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeNix(input);
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
      "'",
      "''",
      "''${",
      '"',
      "$",
      "${",
      "$${",
      "\n",
      "\r\n",
      "~/",
      "./",
      "../",
      "...",
      ".",
      "=",
      "==",
      "->",
      "++",
      "|>",
      "<|",
      "?",
      ":",
      ";",
      ",",
      "{",
      "}",
      "(",
      ")",
      "0x",
      "1_0",
      ".5",
      "42",
      "e",
      "x:x",
      "a/b",
      "http://",
      "or",
      "true",
      "null",
      "let",
      "in",
      "rocket",
      " ",
      "\\",
      "x",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeNix(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("nix tokenizer wiring", () => {
  it("getTokenizer resolves nix to tokenizeNix and classes a real flake", () => {
    const code = [
      "{",
      '  description = "A flake for the widget";',
      "  inputs.nixpkgs.url = github:NixOS/nixpkgs/nixos-24.05;",
      "  outputs = { self, nixpkgs, ... }@args: let",
      '    systems = [ "x86_64-linux" "aarch64-linux" ];',
      "    forAll = f: nixpkgs.lib.genAttrs systems (system: f system);",
      "  in {",
      "    packages = forAll (system:",
      "      let",
      "        pkgs = import nixpkgs { inherit system; overlays = [ self.overlays.default ]; };",
      "      in rec {",
      '        widget = pkgs.stdenv.mkDerivation rec {',
      '          pname = "widget";',
      '          version = "1.0.0";',
      "          src = ./src;",
      "          buildInputs = [ pkgs.openssl ];",
      "          postInstall = ''",
      "            mkdir -p $out/bin",
      "            cp build/widget $out/bin/widget",
      '            echo "installed to $out" # literal $ until dollar-curly',
      "          '';",
      "        };",
      "        default = widget;",
      "      };",
      "    );",
      "    checks = forAll (system: self.packages.${system}.widget or null);",
      "  };",
      "}",
    ].join("\n");
    const runs = getTokenizer("nix")!(code);
    expect(runs.map((r) => r.text).join("")).toBe(code); // the registry contract, held
    expect(runs.filter((r) => r.type === "comment")).toEqual([]); // the `#` lives INSIDE the '' string
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual([
      '"A flake for the widget"',
      "github:NixOS/nixpkgs/nixos-24.05", // the flake-id URI literal, unprefixed
      '"x86_64-linux"',
      '"aarch64-linux"',
      '"widget"',
      '"1.0.0"',
      "./src", // a path literal
      // The postInstall script: literal `$`, literal `"` and literal `#`
      // are all inert string bytes inside the indented literal:
      "''\n            mkdir -p $out/bin\n            cp build/widget $out/bin/widget\n            echo \"installed to $out\" # literal $ until dollar-curly\n          ''",
    ]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "let",
      "in",
      "let",
      "inherit",
      "in",
      "rec",
      "rec",
      "or", // the select default at the tail
    ]);
    expect(runs.filter((r) => r.type === "key").map((r) => r.text)).toEqual([
      "description",
      "url", // `inputs.nixpkgs.url`: the attr path keys the last name
      "outputs",
      "systems",
      "forAll",
      "packages",
      "pkgs",
      "overlays",
      "widget",
      "pname",
      "version",
      "src",
      "buildInputs",
      "postInstall",
      "default",
      "checks",
    ]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual([
      "systems", // `genAttrs systems (...)`: the peek survives whitespace
      "forAll",
      "forAll",
    ]);
    expect(runs.filter((r) => r.type === "boolean")).toEqual([]);
    // `null` rides default (no null class), and `${system}` at top level
    // is the `$` byte plus braces (the hcl pin):
    expect(runs.filter((r) => r.type === "null")).toEqual([]);
    expect(runs.filter((r) => r.type === "operator" && r.text === "...").length).toBe(1);
  });
});
