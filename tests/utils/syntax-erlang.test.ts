// Unit tests for the Erlang tokenizer (src/utils/syntax/erlang.ts): the
// elixir sibling with the Capitalized-is-a-VARIABLE inversion (surviving
// the module dot, so `Mod:Var = ...` keeps its reading), `true`/`false`/
// `ok`/`error` as plain default atoms (no boolean/null class AT ALL),
// `%`-to-EOL comments swallowing the `%%` doc style and `%{...}` alike,
// the single-quoted ordinary string scan (the pinned contrast with
// crystal's char arm), the `$` code-point arm re-pointed from elixir's
// `?a` (escapes: named, octal, \xHH, \x{...}, \^A), the erl_scan operator
// table (three-char `=:=`/`=/=`/`...`/`<:-`/`<:=` first, `<<`/`>>` as the
// lexer's own tokens, `!` always the bind single, `#` the punctuation
// single), line-leading `-attr` as a preproc run for the NAME only, the
// call peek as the only fn reading (no def keyword exists), and the radix
// number zoo (`16#ff`, `16#ff.fe#e+6`) pinned against the degradations
// (`0x1f`, `1e6`, `.01`, `16#`, `1#0`) -- plus losslessness and registry
// pins (.erl/.hrl claimed, no aliases).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeErlang } from "@utils/syntax/erlang.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

// No boolean, no null, no type, no decorator: the inversion batch drops
// them all. "preproc" carries attribute names; "variable" is the
// Capitalized reading plus macro use.
const TYPES = new Set([
  "comment",
  "string",
  "variable",
  "preproc",
  "keyword",
  "fn",
  "number",
  "operator",
  "default",
]);

const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeErlang structure", () => {
  it("a module head: attributes as name-only preproc runs, the rest tokenizes", () => {
    const code = [
      "-module(greeter).",
      "-export([greet/1, shout/0]).",
      '-define(SAY, "hi").',
      "",
      "greet(Name) ->",
      "    {ok, Name}.",
    ].join("\n");
    expect(significant(tokenizeErlang(code))).toEqual([
      run("preproc", "-module"), // the NAME only: the export list keeps its candy
      run("operator", "("),
      run("default", "greeter"),
      run("operator", ")"),
      run("operator", "."),
      run("preproc", "-export"),
      run("operator", "("), // the export list's paren is its own run; the `[` follows
      run("operator", "["),
      run("default", "greet"), // `/1` is an arity, not a call: no fn reading
      run("operator", "/"),
      run("number", "1"),
      run("operator", ","),
      run("default", "shout"),
      run("operator", "/"),
      run("number", "0"),
      run("operator", "]"),
      run("operator", ")"),
      run("operator", "."),
      run("preproc", "-define"),
      run("operator", "("),
      run("variable", "SAY"), // UPPER is a variable here (the inversion)
      run("operator", ","),
      run("string", '"hi"'),
      run("operator", ")"),
      run("operator", "."),
      run("fn", "greet"), // the clause head: the call peek is the ONLY fn arm (no def)
      run("operator", "("),
      run("variable", "Name"),
      run("operator", ")"),
      run("operator", "->"),
      run("operator", "{"),
      run("default", "ok"), // `ok` is a plain atom: no keyword, no boolean
      run("operator", ","),
      run("variable", "Name"),
      run("operator", "}"),
      run("operator", "."),
    ]);
  });

  it("THE INVERSION: Capitalized words are variables, even after the module dot", () => {
    expect(significant(tokenizeErlang('Name = "x"\nMod:Var = {1, 2}\nfoo:bar(1)'))).toEqual([
      run("variable", "Name"),
      run("operator", "="),
      run("string", '"x"'),
      run("variable", "Mod"),
      run("operator", ":"),
      run("variable", "Var"), // `Mod:Var = Tuple` keeps its variables (the pin)
      run("operator", "="),
      run("operator", "{"),
      run("number", "1"),
      run("operator", ","),
      run("number", "2"),
      run("operator", "}"),
      run("default", "foo"), // lowercase before `:` is a plain module name
      run("operator", ":"),
      run("fn", "bar"), // the call peek survives the dot
      run("operator", "("),
      run("number", "1"),
      run("operator", ")"),
    ]);
    // The Capitalized TYPE heuristic is absent: there are no types to read.
    expect(significant(tokenizeErlang("Widget MAX_SIZE"))).toEqual([
      run("variable", "Widget"),
      run("variable", "MAX_SIZE"),
    ]);
  });

  it("no booleans, no null: true/false/ok/error/undefined ride default (pinned)", () => {
    for (const word of ["true", "false", "ok", "error", "undefined", "nil"]) {
      expect(significant(tokenizeErlang(word))).toEqual([run("default", word)]);
    }
  });

  it("comments: % to EOL anywhere, the %% doc style, %{...} NOT a map", () => {
    expect(significant(tokenizeErlang('X = 1 %% doc\n%{not, a, "map"}'))).toEqual([
      run("variable", "X"),
      run("operator", "="),
      run("number", "1"),
      run("comment", "%% doc"),
      run("comment", '%{not, a, "map"}'), // `%` comments from anywhere; maps are `#{`
    ]);
    expect(significant(tokenizeErlang("/* nope here */"))).toEqual([
      run("operator", "/"), // no block comments: the C opener degrades to singles
      run("operator", "*"),
      run("default", "nope"),
      run("default", "here"),
      run("operator", "*"),
      run("operator", "/"),
    ]);
  });

  it("strings and quoted atoms share the ordinary scan (no char/atom split)", () => {
    expect(significant(tokenizeErlang(`"a\\"b" 'plain' 'Foo Bar' 'it\\'s'`))).toEqual([
      run("string", '"a\\"b"'),
      run("string", "'plain'"), // `'a'` is BOTH a 97-char and an atom; display shows bytes
      run("string", "'Foo Bar'"), // a quoted uppercase atom is a string, not a variable
      run("string", "'it\\'s'"), // the language's own atom escape
    ]);
    // The `$` code point is the number side of the same invisible split:
    expect(significant(tokenizeErlang("$A $\\n $\\x41 $\\x{1F600} $\\377 $\\^A $$"))).toEqual([
      run("number", "$A"),
      run("number", "$\\n"),
      run("number", "$\\x41"),
      run("number", "$\\x{1F600}"), // the brace spelling included
      run("number", "$\\377"), // 1-3 octal digits
      run("number", "$\\^A"), // the control form
      run("number", "$$"),
    ]);
    // A `$` that arms nothing is a plain byte (no operator role):
    expect(significant(tokenizeErlang("$"))).toEqual([run("default", "$")]);
    // No interpolation exists here: `#{` and `~p` inside strings are bytes:
    expect(significant(tokenizeErlang('"~p~n done #{not_a_hole}"'))).toEqual([
      run("string", '"~p~n done #{not_a_hole}"'),
    ]);
  });

  it("the number zoo: separators, radix forms, and the pinned degradations", () => {
    expect(
      significant(tokenizeErlang("42 -1_234 007 2.3 2.3e-3 1_234.333_333 2#1010 16#1f 36#helloworld 16#ff.fe 16#ff.fe#e+6")),
    ).toEqual([
      run("number", "42"),
      run("operator", "-"), // the sign is its own token
      run("number", "1_234"),
      run("number", "007"), // leading zeroes are decimals (no octal here)
      run("number", "2.3"),
      run("number", "2.3e-3"),
      run("number", "1_234.333_333"),
      run("number", "2#1010"), // one run, base 2
      run("number", "16#1f"),
      run("number", "36#helloworld"), // the reference's own example
      run("number", "16#ff.fe"),
      run("number", "16#ff.fe#e+6"), // the based float with its decimal exponent
    ]);
    expect(
      significant(tokenizeErlang("0x1f 1e6 .01 16# 1#0 1__0")),
    ).toEqual([
      run("number", "0"), // NO 0x (the spec denies it): number plus word
      run("default", "x1f"),
      run("number", "1"), // `1e6` is NOT a float here (the dot is mandatory)
      run("default", "e6"),
      run("operator", "."), // floats must start with a digit
      run("number", "01"),
      run("default", "16#"), // the half radix form rides default (the pin)
      run("default", "1#0"), // base 1 fails the 2..36 range
      run("default", "1__0"), // only SINGLE underscores
    ]);
  });

  it("the erl_scan operator table: three-char first, the runs, the singles", () => {
    expect(significant(tokenizeErlang("A =:= B =/= C =< D >= E"))).toEqual([
      run("variable", "A"),
      run("operator", "=:="), // THREE-char checked first (the dart lesson)
      run("variable", "B"),
      run("operator", "=/="),
      run("variable", "C"),
      run("operator", "=<"),
      run("variable", "D"),
      run("operator", ">="),
      run("variable", "E"),
    ]);
    expect(significant(tokenizeErlang("[X || X <- L] <<1:1, 0:7>> M -- N ++ P"))).toEqual([
      run("operator", "["),
      run("variable", "X"),
      run("operator", "||"),
      run("variable", "X"),
      run("operator", "<-"), // the comprehension generator
      run("variable", "L"),
      run("operator", "]"),
      run("operator", "<<"), // the bitstring pair: the lexer lexes them as tokens (spec over draft)
      run("number", "1"),
      run("operator", ":"),
      run("number", "1"),
      run("operator", ","),
      run("number", "0"),
      run("operator", ":"),
      run("number", "7"),
      run("operator", ">>"),
      run("variable", "M"),
      run("operator", "--"),
      run("variable", "N"),
      run("operator", "++"),
      run("variable", "P"),
    ]);
    expect(significant(tokenizeErlang("M:#{k := v, k2 => 2} Rec#rec.a"))).toEqual([
      run("variable", "M"),
      run("operator", ":"),
      run("operator", "#"), // maps/records read as byte plus brackets (the documented shape)
      run("operator", "{"),
      run("default", "k"),
      run("operator", ":="), // map update
      run("default", "v"),
      run("operator", ","),
      run("default", "k2"),
      run("operator", "=>"), // map association
      run("number", "2"),
      run("operator", "}"),
      run("variable", "Rec"), // UPPER, wherever it stands
      run("operator", "#"),
      run("default", "rec"), // the record NAME is a lowercase word
      run("operator", "."),
      run("default", "a"),
    ]);
  });

  it("macros, ! and the guard reading", () => {
    expect(significant(tokenizeErlang("?MODULE:foo(?SAY)"))).toEqual([
      run("variable", "?MODULE"), // macro use is ONE variable run (the documented wash)
      run("operator", ":"),
      run("fn", "foo"),
      run("operator", "("),
      run("variable", "?SAY"),
      run("operator", ")"),
    ]);
    expect(significant(tokenizeErlang("Pid ! msg, !X"))).toEqual([
      run("variable", "Pid"),
      run("operator", "!"), // `!` is ALWAYS the bind single (the pin)
      run("default", "msg"),
      run("operator", ","),
      run("operator", "!"), // the guard `!X` reads operator plus...
      run("variable", "X"), // ...variable, the documented cost
    ]);
    expect(significant(tokenizeErlang("?foo"))).toEqual([
      run("operator", "?"), // a lowercase macro does not exist: `?` is the symbol single
      run("default", "foo"),
    ]);
  });

  it("?=, &&, .., ... are the lexer's newer tokens and they run", () => {
    expect(significant(tokenizeErlang("?= ok\n[A && B || C]\nfoo(...) ->"))).toEqual([
      run("operator", "?="),
      run("default", "ok"),
      run("operator", "["),
      run("variable", "A"),
      run("operator", "&&"),
      run("variable", "B"),
      run("operator", "||"),
      run("variable", "C"),
      run("operator", "]"),
      run("fn", "foo"),
      run("operator", "("),
      run("operator", "..."),
      run("operator", ")"),
      run("operator", "->"),
    ]);
  });

  it("keywords: the reference's set; the call peek names clause heads", () => {
    const code = "case X of\n  ok -> receive A when is_pid(A) -> after 1000 -> end\nend";
    expect(significant(tokenizeErlang(code))).toEqual([
      run("keyword", "case"),
      run("variable", "X"),
      run("keyword", "of"),
      run("default", "ok"),
      run("operator", "->"),
      run("keyword", "receive"),
      run("variable", "A"),
      run("keyword", "when"),
      run("fn", "is_pid"),
      run("operator", "("),
      run("variable", "A"),
      run("operator", ")"),
      run("operator", "->"),
      run("keyword", "after"),
      run("number", "1000"),
      run("operator", "->"),
      run("keyword", "end"),
      run("keyword", "end"),
    ]);
    expect(significant(tokenizeErlang("try catch else maybe fun begin let"))).toEqual([
      run("keyword", "try"),
      run("keyword", "catch"), // the additions the draft list missed
      run("keyword", "else"),
      run("keyword", "maybe"),
      run("keyword", "fun"),
      run("keyword", "begin"),
      run("keyword", "let"),
    ]);
  });

  it("attributes arm only at the line start, glued, letter-led", () => {
    expect(significant(tokenizeErlang("    -compile([export_all])."))).toEqual([
      run("preproc", "-compile"), // indentation past, glued name (c.ts's arm)
      run("operator", "("),
      run("operator", "["),
      run("default", "export_all"),
      run("operator", "]"),
      run("operator", ")"),
      run("operator", "."),
    ]);
    expect(significant(tokenizeErlang("-1 + 2"))).toEqual([
      run("operator", "-"), // a letter-less `-` cannot arm
      run("number", "1"),
      run("operator", "+"),
      run("number", "2"),
    ]);
    expect(significant(tokenizeErlang("a -b"))).toEqual([
      run("default", "a"), // mid-line, the attribute arm is spent
      run("operator", "-"),
      run("default", "b"),
    ]);
    expect(significant(tokenizeErlang("--comment-ish"))).toEqual([
      run("operator", "--"), // the list operator, not an attribute
      run("default", "comment"),
      run("operator", "-"),
      run("default", "ish"),
    ]);
  });

  it("-spec: the preproc claims the name, the type words ride default", () => {
    expect(significant(tokenizeErlang("-spec greet(term()) -> ok."))).toEqual([
      run("preproc", "-spec"),
      run("fn", "greet"), // the rest of the line tokenizes normally (the decision)
      run("operator", "("),
      run("fn", "term"), // `term()` is call-shaped candy; the type reading does not exist
      run("operator", "("),
      run("operator", ")"),
      run("operator", ")"),
      run("operator", "->"),
      run("default", "ok"),
      run("operator", "."),
    ]);
  });
});

describe("tokenizeErlang line-wise degradation (the file view tokenizes per line)", () => {
  it("unterminated literals stop at the newline; the next line re-reads", () => {
    expect(tokenizeErlang('x = "abc\ny = 1')).toEqual([
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
    expect(tokenizeErlang("'unterm atom\nx")).toEqual([
      run("string", "'unterm atom"),
      run("default", "\n"),
      run("default", "x"),
    ]);
  });

  it("a wrapped export list continuation re-reads plainly on its own line", () => {
    // The whole pass arms `-export` at its line start; the continuation
    // of a wrapped export list, tokenized alone, reads plain, honestly:
    expect(significant(tokenizeErlang("    foo/1, bar/0]"))).toEqual([
      run("default", "foo"),
      run("operator", "/"),
      run("number", "1"),
      run("operator", ","),
      run("default", "bar"),
      run("operator", "/"),
      run("number", "0"),
      run("operator", "]"),
    ]);
  });
});

describe("tokenizeErlang registry contract", () => {
  it("guesses and fences resolve through the registry; .escript stays unclaimed", () => {
    expect(guessLangForBase("main.erl")).toBe("erlang");
    expect(guessLangForBase("header.hrl")).toBe("erlang");
    expect(guessLangForBase("MAIN.ERL")).toBe("erlang"); // extensions are case-insensitive
    expect(guessLangForBase("app.escript")).toBeUndefined(); // a script dialect, honestly unclaimed
    expect(guessLangForBase("relx.config")).toBeUndefined(); // the release tool rides config shapes
    expect(guessLangForBase("erl")).toBeUndefined(); // dotless stem
    expect(resolveSyntaxLang("erlang")).toBe("erlang");
    expect(resolveSyntaxLang("erl")).toBeUndefined(); // extensions are never aliases
    expect(resolveSyntaxLang("hrl")).toBeUndefined();
    expect(resolveSyntaxLang("ERLANG")).toBeUndefined(); // the canonical name resolves exactly
    expect(getTokenizer("erlang")).toBe(tokenizeErlang);
  });
});

describe("tokenizeErlang losslessness", () => {
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
    "%",
    "$",
    "?",
    "#",
    "#_",
    "~",
    "`",
    "@",
    "^",
    "!~",
    "$\\",
    "$\\x",
    "$\\x{",
    "$\\3",
    "$\\^",
    "'",
    "'",
    "16#",
    "1#0",
    "2#",
    "36#",
    "<<",
    ">>",
    "->",
    "=:",
    "=:=",
    "...",
    "?=",
    "0x1f",
    "1e6",
    "-module",
    "-",
    "--",
    "..",
    "&&",
    "<-",
    "ok",
    "Foo",
    "🚀 emoji ünïcøde 漢字",
    '"unterminated',
    "'unterminated",
    "%unterminated",
    '"splice\\',
    "x\r\n-module(y).",
    "()[]{}",
    "$a $b",
    "?FOO?bar",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeErlang(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "%",
      "%%",
      "'",
      '"',
      "$",
      "$a",
      "?",
      "?FOO",
      "#",
      "#rec",
      "->",
      "=>",
      ":=",
      "::",
      "=:=",
      "=/=",
      "==",
      "/=",
      "=<",
      "++",
      "--",
      "||",
      "&&",
      "..",
      "?=",
      "<-",
      "<<",
      ">>",
      "!",
      ";",
      ",",
      ".",
      ":",
      "=",
      "16#",
      "2#1010",
      "1_0",
      "1.5",
      "0x1",
      "1e6",
      "ok",
      "true",
      "end",
      "fun",
      "case",
      "Foo",
      "foo",
      "(",
      ")",
      "{",
      "}",
      "[",
      "]",
      " ",
      "\n",
      "\r\n",
      "\t",
      "🚀",
      "'unterm",
      '"unterm',
      "\\",
      "\\\\",
      "@",
      "~",
      "-module",
      "-",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeErlang(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("erlang tokenizer wiring", () => {
  it("getTokenizer resolves erlang to tokenizeErlang and classes a real module", () => {
    const code = [
      "-module(greeter).",
      "-export([greet/1]).",
      "",
      '-define(GREETING, "hello").',
      "-record(state, {count = 0}).",
      "",
      "greet(Name) ->",
      '    Msg = ?GREETING ++ ", " ++ Name,',
      "    {ok, unicode:characters_to_binary(Msg)}.",
      "",
      "bits(X) when X >= 0 ->",
      "    <<1:1, X:31>>.",
    ].join("\n");
    const runs = getTokenizer("erlang")!(code);
    expect(runs.map((r) => r.text).join("")).toBe(code); // the registry contract, held
    expect(runs.filter((r) => r.type === "preproc").map((r) => r.text)).toEqual([
      "-module",
      "-export",
      "-define",
      "-record",
    ]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual([
      "greet",
      "characters_to_binary",
      "bits",
    ]);
    expect(runs.filter((r) => r.type === "variable").map((r) => r.text)).toEqual([
      "GREETING", // even the -define NAME wears the variable reading (UPPER is UPPER)
      "Name",
      "Msg",
      "?GREETING", // the macro USE is its own run
      "Name",
      "Msg",
      "X",
      "X",
      "X", // the bitstring body too
    ]);
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual(['"hello"', '", "']);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual(["when"]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual([
      "1", // greet/1
      "0", // the record default
      "0", // the guard
      "1", // the bitstring head
      "1",
      "31",
    ]);
    expect(runs.filter((r) => r.type === "operator" && r.text === "<<").map((r) => r.text)).toEqual(["<<"]);
    // The atoms never classed: no boolean/null run exists anywhere.
    expect(runs.filter((r) => r.type === "boolean" || r.type === "null")).toEqual([]);
  });
});
