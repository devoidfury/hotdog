// Unit tests for the Make tokenizer (src/utils/syntax/make.ts): typed runs
// with exact classes and spans over targeted fixtures (the tab-led recipe
// rule with its comment/variable lifts, the directive words, the
// target/variable key reading with the glued operator run, variable
// interpolation everywhere else), line-wise degradation pins for the file
// view (continuations read as their own lines), a losslessness sweep over
// a nasty fixture corpus plus a deterministic fragment generator, and the
// registry wiring pins (basenames, extension, the makefile fence alias).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeMake } from "@utils/syntax/make.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

/** The tokenizer's declared class vocabulary (every run must live here). */
const TYPES = new Set(["keyword", "comment", "variable", "key", "operator", "default"]);

/** Drop the whitespace/newline passthrough to assert the interesting runs. */
const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeMake structure", () => {
  it("classifies a whole makefile", () => {
    expect(significant(tokenizeMake("CC = gcc\n\n.PHONY: all\nall: app\n\t$(CC) -o app main.c # build\n"))).toEqual([
      run("key", "CC"),
      run("operator", "="),
      run("default", "gcc"),
      run("key", ".PHONY"), // targets share the key accent (the yaml-keys reading)
      run("operator", ":"),
      run("default", "all"),
      run("key", "all"),
      run("operator", ":"),
      run("default", "app"),
      run("variable", "$(CC)"), // lifted out of the recipe
      run("default", " -o app main.c "),
      run("comment", "# build"), // the one other reading inside a recipe
    ]);
  });

  it("directives are keyword at line start (lowercase; endif joins its openers)", () => {
    expect(significant(tokenizeMake("ifeq ($(OS),Linux)\nexport LD = ld\nendif\ninclude rules.mk"))).toEqual([
      run("keyword", "ifeq"),
      run("default", "("),
      run("variable", "$(OS)"),
      run("default", ","),
      run("default", "Linux"),
      run("default", ")"),
      run("keyword", "export"),
      run("key", "LD"),
      run("operator", "="),
      run("default", "ld"),
      run("keyword", "endif"),
      run("keyword", "include"),
      run("default", "rules.mk"),
    ]);
  });

  it("every glued operator form is one run", () => {
    expect(significant(tokenizeMake("A := 1\nB ::= 2\nC += 3\nD ?= 4\nE: F\ntarget:: prereq"))).toEqual([
      run("key", "A"),
      run("operator", ":="),
      run("default", "1"),
      run("key", "B"),
      run("operator", "::="),
      run("default", "2"),
      run("key", "C"),
      run("operator", "+="),
      run("default", "3"),
      run("key", "D"),
      run("operator", "?="),
      run("default", "4"),
      run("key", "E"),
      run("operator", ":"),
      run("default", "F"),
      run("key", "target"),
      run("operator", "::"),
      run("default", "prereq"),
    ]);
  });

  it("a name without a peeked operator is a plain word; a mid-line # is still a comment", () => {
    expect(significant(tokenizeMake("deps one two # what we need"))).toEqual([
      run("default", "deps"),
      run("default", "one"),
      run("default", "two"),
      run("comment", "# what we need"),
    ]);
  });

  it("the recipe tab rule wins over everything on the line", () => {
    // A tab-led line is NOT a directive and NOT a target, whatever it holds.
    expect(significant(tokenizeMake("\tinclude stdio.h\n\tCC := nope"))).toEqual([
      run("default", "\tinclude stdio.h"),
      run("default", "\tCC := nope"),
    ]);
  });
});

describe("tokenizeMake recipes", () => {
  it("automatic variables and interpolations lift; the rest of the shell is opaque", () => {
    expect(tokenizeMake("\t@echo $@\n\t@echo $@-$(VERSION)")).toEqual([
      run("default", "\t@echo "),
      run("variable", "$@"),
      run("default", "\n"),
      run("default", "\t@echo "),
      run("variable", "$@"),
      run("default", "-"),
      run("variable", "$(VERSION)"),
    ]);
  });

  it("make has no string quotes, so nothing guards the # in a recipe (documented)", () => {
    expect(tokenizeMake("\t@echo 'literal # inside quotes'")).toEqual([
      run("default", "\t@echo 'literal "),
      run("comment", "# inside quotes'"),
    ]);
  });

  it("a lone $ and an unclosed brace degrade to plain bytes / line ends", () => {
    expect(tokenizeMake("\techo $ && ${oops")).toEqual([
      // `$ ` opens nothing (plain byte); an unclosed `${` runs to the line end.
      run("default", "\techo $ && "),
      run("variable", "${oops"),
    ]);
  });
});

describe("tokenizeMake variables and honest misreads", () => {
  it("$(NAME)/${NAME} lift anywhere on a non-recipe line", () => {
    expect(significant(tokenizeMake("SRCS = $(wildcard *.c) ${BUILD}/out"))).toEqual([
      run("key", "SRCS"),
      run("operator", "="),
      run("variable", "$(wildcard *.c)"),
      run("variable", "${BUILD}"),
      run("default", "/out"),
    ]);
  });

  it("a value that looks like NAME: gets the key reading (cheerful documented false positive)", () => {
    expect(significant(tokenizeMake("see http://example.com"))).toEqual([
      run("default", "see"),
      run("key", "http"),
      run("operator", ":"),
      run("default", "//example.com"),
    ]);
  });
});

describe("tokenizeMake line-wise degradation (the file view tokenizes per line)", () => {
  it("a continuation tail reads as its own junk line, never garble", () => {
    expect(significant(tokenizeMake("define NOTE\nsee http://x"))).toEqual([
      run("keyword", "define"),
      run("default", "NOTE"),
      run("default", "see"),
      run("key", "http"), // the continuation body is just another line
      run("operator", ":"),
      run("default", "//x"),
    ]);
  });

  it("a recipe line stands on its own; the following line re-arms the line start", () => {
    expect(significant(tokenizeMake("\tcc $<\nCC = gcc"))).toEqual([
      run("default", "\tcc "),
      run("variable", "$<"),
      run("key", "CC"),
      run("operator", "="),
      run("default", "gcc"),
    ]);
  });
});

describe("tokenizeMake losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\n",
    "\t",
    "\t\n",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "x".repeat(50000),
    "#",
    "#\n",
    "$",
    "$(",
    "${",
    "$@",
    ":=",
    "=",
    "::=",
    "?:",
    "+",
    "?",
    "\\",
    "a\\=b", // a bare backslash before an operator: no name, no hang
    "FOO",
    "FOO=",
    "FOO := bar",
    "a:b",
    "%.o: %.c",
    "-include foo.mk",
    "\t# comment-only recipe",
    "\t@echo $@ $< $? $^ $* % ? ^ + | -\n",
    "\tcc 'a # b' \"c # d\"\n",
    "#c\n",
    "ifeq (",
    "define\nendef\n",
    ".PHONY: all",
    "http://x\n",
    "tab\tvalue", // a mid-line tab is NOT a recipe marker
    "a\r\n\tb\r\n",
    "🚀 emoji ünïcøde 漢字",
    "A = $(B\nC = ${D\nE = $",
    "make: --not-flag && echo hi",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeMake(input);
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
      "{",
      "}",
      ",",
      ":",
      ";",
      ".",
      "#",
      "\\",
      "1",
      "->",
      "$",
      "@",
      "?",
      "%",
      "=",
      ":=",
      "?=",
      "+=",
      "#c\n",
      "tab\t",
      "\tcmd $@ ",
      "ifeq",
      "endif",
      "include",
      "FOO",
      "FOO=",
      "bar: baz",
      "$(V)",
      "${W}",
      "$@",
      "define",
      "endef",
      "http://x",
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
      const runs = tokenizeMake(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("make tokenizer wiring", () => {
  it("getTokenizer resolves make to tokenizeMake and colors a makefile sample", () => {
    expect(getTokenizer("make")).toBe(tokenizeMake);
    expect(resolveSyntaxLang("make")).toBe("make");
    expect(resolveSyntaxLang("makefile")).toBe("make"); // the fence alias (the basename spelling)
    const code = [
      "# build the thing",
      "CC ?= gcc",
      "OBJS = $(SRC:.c=.o)",
      "",
      ".PHONY: all",
      "all: app # the default",
      "\t$(CC) $(CFLAGS) -o $@ $(OBJS) # link",
    ].join("\n");
    const runs = getTokenizer("make")!(code);
    expect(runs.map((r) => r.text).join("")).toBe(code); // the registry contract, held
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual([
      "# build the thing",
      "# the default",
      "# link",
    ]);
    expect(runs.filter((r) => r.type === "key").map((r) => r.text)).toEqual(["CC", "OBJS", ".PHONY", "all"]);
    expect(runs.filter((r) => r.type === "variable").map((r) => r.text)).toEqual([
      "$(SRC:.c=.o)",
      "$(CC)",
      "$(CFLAGS)",
      "$@",
      "$(OBJS)",
    ]);
    expect(runs.filter((r) => r.type === "operator").map((r) => r.text)).toEqual(["?=", "=", ":", ":"]);
  });

  it("guesses: basenames (exact and variant) outrank nothing to fall through to", () => {
    expect(guessLangForBase("Makefile")).toBe("make");
    expect(guessLangForBase("GNUmakefile")).toBe("make");
    expect(guessLangForBase("makefile")).toBe("make"); // case-insensitive
    expect(guessLangForBase("Makefile.dev")).toBe("make"); // the variant spelling
    expect(guessLangForBase("build.mk")).toBe("make");
    expect(guessLangForBase("rules.mak")).toBe("make");
    expect(guessLangForBase("my.Makefile")).toBeUndefined(); // not the Makefile.* shape
  });
});
