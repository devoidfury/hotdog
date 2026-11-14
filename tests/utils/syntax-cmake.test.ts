// Unit tests for the CMake tokenizer (src/utils/syntax/cmake.ts): typed runs
// with exact classes and spans over targeted fixtures (the dockerfile.ts
// family, narrowed to what CMake actually is: CASE-INSENSITIVE keywords for
// the block/flow vocabulary and the boolean spellings, the call peek as the
// only command arm, `${}`/`$ENV{}`/`$CACHE{}` and the nested `$<...>` genex
// as variable while a bare `$FOO` rides default, the raw bracket argument
// and bracket comment forms, the version-not-number ruling (`3.10`,
// `3.10.2` ride default; only closed integers and 0x hex are numbers), the
// STREQUAL-zoo rejection, no type reading at all, and single quotes as
// literal bytes), a losslessness sweep over a nasty fixture corpus plus a
// deterministic fragment generator, and the registry wiring pins (the
// CMakeLists.txt basename including the .in variant).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeCmake } from "@utils/syntax/cmake.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

// No "type" (no name reading in this language), no "variable" sigils
// beyond `${...}`/genex, no "decorator", no "preproc" (`#` is a comment).
const TYPES = new Set([
  "comment",
  "string",
  "variable",
  "keyword",
  "boolean",
  "null",
  "fn",
  "number",
  "operator",
  "default",
]);

const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeCmake structure", () => {
  it("a command line: fn, argument words as default, comment to EOL", () => {
    expect(significant(tokenizeCmake("set(SOURCES src/main.cpp) # the entry point"))).toEqual([
      run("fn", "set"), // the call peek is the only command arm
      run("operator", "("),
      run("default", "SOURCES"),
      run("default", "src"), // `/` is an argument byte, not an operator
      run("default", "/"),
      run("default", "main.cpp"), // `.` is word material here
      run("operator", ")"),
      run("comment", "# the entry point"),
    ]);
  });

  it("block vocabulary is case-insensitive; commands that look like keywords keep it", () => {
    const code = [
      "IF(NOT APPLE)",
      "  set(FLAG \"-O2\")",
      "elseif(UNIX)",
      "  message(STATUS \"on=${UNIX}\")",
      "else()",
      "  return()",
      "endif()",
    ].join("\n");
    expect(significant(tokenizeCmake(code))).toEqual([
      run("keyword", "IF"), // case-insensitive, as command names are
      run("operator", "("),
      run("keyword", "NOT"), // the if operators are keywords too
      run("default", "APPLE"),
      run("operator", ")"),
      run("fn", "set"),
      run("operator", "("),
      run("default", "FLAG"),
      run("string", '"-O2"'),
      run("operator", ")"),
      run("keyword", "elseif"),
      run("operator", "("),
      run("default", "UNIX"),
      run("operator", ")"),
      run("fn", "message"),
      run("operator", "("),
      run("default", "STATUS"),
      run("string", '"on=${UNIX}"'), // the `${...}` hole rides inside the string (rust ruling)
      run("operator", ")"),
      run("keyword", "else"),
      run("operator", "("),
      run("operator", ")"),
      run("keyword", "return"),
      run("operator", "("),
      run("operator", ")"),
      run("keyword", "endif"),
      run("operator", "("),
      run("operator", ")"),
    ]);
    // The block words arm WITHOUT a paren, and a bare `endwhile` is still
    // a keyword; `and`/`or` mid-argument are keywords too.
    expect(significant(tokenizeCmake("while X\nendwhile\nif(A AND B OR NOT C)"))).toEqual([
      run("keyword", "while"),
      run("default", "X"),
      run("keyword", "endwhile"),
      run("keyword", "if"),
      run("operator", "("),
      run("default", "A"),
      run("keyword", "AND"),
      run("default", "B"),
      run("keyword", "OR"),
      run("keyword", "NOT"),
      run("default", "C"),
      run("operator", ")"),
    ]);
  });

  it("foreach/function/macro/block pairs; the loop variables ride plain", () => {
    const code = [
      "foreach(item IN LISTS SOURCES)",
      "  list(APPEND OUT ${item})",
      "endforeach()",
      "function(greet name)",
      '  message("hello ${name}")',
      "endfunction()",
      "macro(m)",
      "endmacro()",
      "block()",
      "endblock()",
    ].join("\n");
    expect(significant(tokenizeCmake(code))).toEqual([
      run("keyword", "foreach"),
      run("operator", "("),
      run("default", "item"), // no loop-variable reading: argument words are words
      run("default", "IN"),
      run("default", "LISTS"),
      run("default", "SOURCES"),
      run("operator", ")"),
      run("fn", "list"),
      run("operator", "("),
      run("default", "APPEND"),
      run("default", "OUT"),
      run("variable", "${item}"),
      run("operator", ")"),
      run("keyword", "endforeach"),
      run("operator", "("),
      run("operator", ")"),
      run("keyword", "function"),
      run("operator", "("),
      run("default", "greet"), // no fn reading after `function`: CMake has no def-keyword arm
      run("default", "name"),
      run("operator", ")"),
      run("fn", "message"),
      run("operator", "("),
      run("string", '"hello ${name}"'),
      run("operator", ")"),
      run("keyword", "endfunction"),
      run("operator", "("),
      run("operator", ")"),
      run("keyword", "macro"),
      run("operator", "("),
      run("default", "m"),
      run("operator", ")"),
      run("keyword", "endmacro"),
      run("operator", "("),
      run("operator", ")"),
      run("keyword", "block"),
      run("operator", "("),
      run("operator", ")"),
      run("keyword", "endblock"),
      run("operator", "("),
      run("operator", ")"),
    ]);
  });

  it("booleans and NOTFOUND are case-insensitive; IGNORE rides plain", () => {
    const code = [
      'option(USE_GUI "GUI support" ON)',
      "set(T1 TRUE)",
      "set(T2 False)",
      "set(F1 off)",
      "set(F2 NO)",
      "set(N NOTFOUND)",
      'option(IGNORE "ignored")',
    ].join("\n");
    expect(significant(tokenizeCmake(code))).toEqual([
      run("fn", "option"),
      run("operator", "("),
      run("default", "USE_GUI"),
      run("string", '"GUI support"'),
      run("boolean", "ON"), // the option() spellings are as boolean as true
      run("operator", ")"),
      run("fn", "set"),
      run("operator", "("),
      run("default", "T1"),
      run("boolean", "TRUE"),
      run("operator", ")"),
      run("fn", "set"),
      run("operator", "("),
      run("default", "T2"),
      run("boolean", "False"), // any case
      run("operator", ")"),
      run("fn", "set"),
      run("operator", "("),
      run("default", "F1"),
      run("boolean", "off"),
      run("operator", ")"),
      run("fn", "set"),
      run("operator", "("),
      run("default", "F2"),
      run("boolean", "NO"),
      run("operator", ")"),
      run("fn", "set"),
      run("operator", "("),
      run("default", "N"),
      run("null", "NOTFOUND"), // the false value of this language rides null
      run("operator", ")"),
      run("fn", "option"),
      run("operator", "("),
      run("default", "IGNORE"), // a plain word (the decision)
      run("string", '"ignored"'),
      run("operator", ")"),
    ]);
  });

  it("variables: ${}, $ENV{}, $CACHE{}, the nested genex; a bare $FOO rides plain", () => {
    const code = "${CMAKE_SOURCE_DIR} $ENV{PATH} $CACHE{CMAKE_CXX_COMPILER} $<$<CONFIG:Debug>:DBG> $FOO ${UNCLOSED tail";
    expect(significant(tokenizeCmake(code))).toEqual([
      run("variable", "${CMAKE_SOURCE_DIR}"),
      run("variable", "$ENV{PATH}"),
      run("variable", "$CACHE{CMAKE_CXX_COMPILER}"),
      run("variable", "$<$<CONFIG:Debug>:DBG>"), // the nested genex is ONE run (depth counted)
      run("default", "$"), // a bare `$FOO` is NOT a reference in this language (the pin)
      run("default", "FOO"),
      run("variable", "${UNCLOSED tail"), // unclosed brace runs to the line end
    ]);
    // A `$` that opens neither brace nor genex is one plain byte; the
    // ENV/CACHE prefixes only arm when glued to `{`.
    expect(significant(tokenizeCmake("$$ ${}}"))).toEqual([
      run("default", "$"),
      run("default", "$"),
      run("variable", "${}"),
      run("operator", "}"), // a stray closing brace is structural
    ]);
  });

  it("bracket arguments are raw multiline strings; bracket comments too", () => {
    const code = [
      'set(MSG [=[a "b" # c]=]) # trailing comment',
      "#[[ brack \"quote\" ]] more",
      "set(R2 [==[ has ]=] inside ]==])",
    ].join("\n");
    expect(significant(tokenizeCmake(code))).toEqual([
      run("fn", "set"),
      run("operator", "("),
      run("default", "MSG"),
      run("string", '[=[a "b" # c]=]'), // raw: no escape, no expansion, no comment start
      run("operator", ")"),
      run("comment", "# trailing comment"),
      run("comment", '#[[ brack "quote" ]]'), // the bracket comment form
      run("default", "more"), // peek past the newline finds no `(`
      run("fn", "set"),
      run("operator", "("),
      run("default", "R2"),
      run("string", "[==[ has ]=] inside ]==]"), // the marks must match: the inner short closer is content
      run("operator", ")"),
    ]);
    // An unclosed bracket argument runs to end of input.
    expect(significant(tokenizeCmake("set(X [=[unclosed"))).toEqual([
      run("fn", "set"),
      run("operator", "("),
      run("default", "X"),
      run("string", "[=[unclosed"),
    ]);
    // A bare `[` that is not the marked opener is just an operator; the
    // `=`s and content ride along as plain bytes.
    expect(significant(tokenizeCmake("a[0]=1"))).toEqual([
      run("default", "a"),
      run("operator", "["),
      run("number", "0"),
      run("operator", "]"),
      run("default", "="), // CMake has no operator class beyond the brackets
      run("number", "1"),
    ]);
  });

  it("numbers: closed integers and hex only; versions and pseudo-numbers ride default", () => {
    expect(
      significant(tokenizeCmake("cmake_minimum_required(VERSION 3.10)\nif(V VERSION_LESS 3.10.2 AND N EQUAL 42)")),
    ).toEqual([
      run("fn", "cmake_minimum_required"), // a command, NOT a keyword (the decision)
      run("operator", "("),
      run("default", "VERSION"),
      run("default", "3.10"), // a version argument, not a number (the ruling)
      run("operator", ")"),
      run("keyword", "if"),
      run("operator", "("),
      run("default", "V"),
      run("default", "VERSION_LESS"), // the if-operator zoo is argument sugar, not keywords
      run("default", "3.10.2"),
      run("keyword", "AND"),
      run("default", "N"),
      run("default", "EQUAL"),
      run("number", "42"),
      run("operator", ")"),
    ]);
    expect(
      significant(tokenizeCmake("0 0777 0x1f 0xFF 1_000 1e5 0x1g -1 42abc")),
    ).toEqual([
      run("number", "0"),
      run("number", "0777"), // radix-blind integer class
      run("number", "0x1f"),
      run("number", "0xFF"),
      // No separators, no exponents, no ill-formed hex: the WHOLE word
      // rides default (there is no split scan here, unlike the java family).
      run("default", "1_000"),
      run("default", "1e5"),
      run("default", "0x1g"),
      run("default", "-1"), // the sign is an argument byte
      run("default", "42abc"),
    ]);
  });

  it("quotes: double-quoted strings with escapes; single quotes are literal bytes", () => {
    expect(significant(tokenizeCmake('x "a\\"b" \'q\' "${y}z"'))).toEqual([
      run("default", "x"),
      run("string", '"a\\"b"'),
      run("default", "'"), // single quotes are NOT strings here (the honest split)
      run("default", "q"),
      run("default", "'"),
      run("string", '"${y}z"'), // the hole rides inside the run
    ]);
    // The house splice/stop rules on ordinary literals.
    expect(significant(tokenizeCmake('"un\ntail'))).toEqual([run("string", '"un'), run("default", "tail")]);
    expect(significant(tokenizeCmake('"abc\\\ndef"'))).toEqual([run("string", '"abc\\\ndef"')]);
  });

  it("no type reading: capitalized, screaming and lowercase names all ride plain", () => {
    expect(significant(tokenizeCmake("Widget MAX_SIZE widget Foo::Bar"))).toEqual([
      run("default", "Widget"), // the Capitalized heuristic is DELIBERATELY absent here
      run("default", "MAX_SIZE"),
      run("default", "widget"),
      run("default", "Foo::Bar"), // the colon is word material: one run
    ]);
  });
});

describe("tokenizeCmake line-wise degradation (the file view tokenizes per line)", () => {
  it("an unterminated string stops at the newline; the next line re-reads", () => {
    expect(tokenizeCmake('a "oops\nset(b 1)')).toEqual([
      run("default", "a"),
      run("default", " "),
      run("string", '"oops'),
      run("default", "\n"),
      run("fn", "set"),
      run("operator", "("),
      run("default", "b"),
      run("default", " "),
      run("number", "1"),
      run("operator", ")"),
    ]);
  });

  it("a bracket argument spanning lines swallows its open line; the tail re-reads as junk", () => {
    expect(tokenizeCmake("[=[\nline2\n]=]")).toEqual([run("string", "[=[\nline2\n]=]")]); // whole pass: one raw string
    // The file view's per-line calls, lossless but structure-blind (the
    // c.ts block-comment story):
    expect(tokenizeCmake("[=[")).toEqual([run("string", "[=[")]);
    expect(tokenizeCmake("line2")).toEqual([run("default", "line2")]);
    expect(tokenizeCmake("]=]")).toEqual([run("operator", "]"), run("default", "="), run("operator", "]")]);
  });

  it("an unclosed genex and an unclosed bracket comment stop honestly, never garble", () => {
    expect(tokenizeCmake("$<genex\nset(x 1)")).toEqual([
      run("variable", "$<genex"), // the genex scan is line-bounded
      run("default", "\n"),
      run("fn", "set"),
      run("operator", "("),
      run("default", "x"),
      run("default", " "),
      run("number", "1"),
      run("operator", ")"),
    ]);
    expect(tokenizeCmake("#[[unterm forever")).toEqual([run("comment", "#[[unterm forever")]);
  });
});

describe("tokenizeCmake registry contract", () => {
  it("guesses and fences resolve through the registry; the basename claims hold", () => {
    expect(guessLangForBase("CMakeLists.txt")).toBe("cmake");
    expect(guessLangForBase("CMakeLists.txt.in")).toBe("cmake"); // the .in template variant (prefix rule)
    expect(guessLangForBase("cmakelists.txt")).toBe("cmake"); // basenames are case-insensitive
    expect(guessLangForBase("modules.cmake")).toBe("cmake");
    expect(guessLangForBase("MAIN.CMAKE")).toBe("cmake");
    expect(guessLangForBase("CMakeCache.txt")).toBeUndefined(); // generated, unclaimed
    expect(guessLangForBase("CMakeLists.txtx")).toBeUndefined(); // not the prefix shape either
    expect(resolveSyntaxLang("cmake")).toBe("cmake");
    expect(resolveSyntaxLang("cmakelists")).toBeUndefined(); // no aliases: the fence word is the name
    expect(getTokenizer("cmake")).toBe(tokenizeCmake);
  });
});

describe("tokenizeCmake losslessness", () => {
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
    "#[",
    "#[[",
    "#[=[",
    "$",
    "${",
    "${x",
    "$<",
    "$<x",
    "$ENV{",
    "$CACHE",
    "$$",
    "$$$",
    "[",
    "[]",
    "[[",
    "[=[",
    "[[]=]",
    "[]=]",
    "]==]",
    "]=[",
    "=",
    "}",
    "{",
    ";",
    ":",
    "::",
    "foo::bar",
    "-Wall",
    "0x",
    "0x1g",
    "3.10.2",
    "42",
    "1_0",
    "1e5",
    "ON",
    "NOTFOUND",
    "if",
    "endif",
    "CMakeLists.txt",
    "@",
    "x[0]",
    "a;b",
    "🚀 emoji ünïcøde 漢字",
    '"unterminated',
    "'unterminated",
    '"splice\\',
    "#[[unterm",
    "[=[unterm",
    "set(",
    "IF(AND OR NOT)",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeCmake(input);
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
      "[=[",
      "[[]]",
      "]=]",
      "]==]",
      "{",
      "}",
      ";",
      ",",
      ":",
      "#",
      "#[",
      "#[[",
      '"',
      "'",
      "\\",
      '"s"',
      "${",
      "$",
      "$<",
      ">",
      "<",
      "$ENV{",
      "$CACHE{",
      "set",
      "set(",
      "if",
      "IF",
      "endif",
      "NOT",
      "and",
      "ON",
      "True",
      "NOTFOUND",
      "0x1f",
      "42",
      "3.10",
      "-Wall",
      "foo::bar",
      "x[0]",
      "=",
      "@",
      "msg",
      " ",
      "\n",
      "\r\n",
      "\t",
      "🚀",
      '"unterminated',
      "#[[unterm",
      "[=[unterm",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeCmake(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("cmake tokenizer wiring", () => {
  it("getTokenizer resolves cmake to tokenizeCmake and colors a CMakeLists sample", () => {
    const code = [
      "cmake_minimum_required(VERSION 3.25)",
      "# greeting target",
      "project(Greeter LANGUAGES CXX)",
      'option(USE_GUI "GUI support" ON)',
      "set(PREFIX ${CMAKE_SOURCE_DIR}/lib)",
      "set(PORT 8080)",
      "add_executable(app src/main.cpp)",
      "if(UNIX AND NOT APPLE)",
      "  target_link_libraries(app PRIVATE foo::bar)",
      '  message(STATUS "gui=${USE_GUI}")',
      "endif()",
    ].join("\n");
    const runs = getTokenizer("cmake")!(code);
    expect(runs.map((r) => r.text).join("")).toBe(code); // the registry contract, held
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual(["# greeting target"]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual([
      "cmake_minimum_required",
      "project",
      "option",
      "set",
      "set",
      "add_executable",
      "target_link_libraries",
      "message",
    ]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual(["if", "AND", "NOT", "endif"]);
    expect(runs.filter((r) => r.type === "boolean").map((r) => r.text)).toEqual(["ON"]);
    // The bare `${CMAKE_SOURCE_DIR}` is the only variable run: the hole
    // inside the message string rides the string.
    expect(runs.filter((r) => r.type === "variable").map((r) => r.text)).toEqual(["${CMAKE_SOURCE_DIR}"]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual(["8080"]); // 3.25 is a version, not a number
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual(['"GUI support"', '"gui=${USE_GUI}"']);
  });
});
