// Unit tests for the Elixir tokenizer (src/utils/syntax/elixir.ts): typed
// runs with exact classes and spans over targeted fixtures (the ruby/kotlin
// family with the elixir decision surface: `#`-only comments with the C-
// shaped opener degrading, atoms and keyword keys, charlists as strings,
// escape-skipping heredocs, the seven-pair sigil family with modifiers
// riding the run and the pipe pair honestly rejected, glued-paren module
// attributes, prevFn after def so `def foo do` names the function, the
// `?`/`!` identifier tails (and the `!=` refusal), `?a` code points as
// numbers, and the `|>`/`=>`/`::`/`<-`/`->`/`//` operator runs against the
// `^^^`/`=~=`/`~~~`/`?.` rejections), a losslessness sweep over a nasty
// fixture corpus plus a deterministic fragment generator, and the registry
// wiring pins (.ex/.exs claimed, .heex honestly not).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeElixir } from "@utils/syntax/elixir.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

// No "preproc" (`#` is a comment), no "variable" (`@` attrs are decorator).
const TYPES = new Set([
  "comment",
  "string",
  "key",
  "keyword",
  "boolean",
  "null",
  "type",
  "fn",
  "number",
  "operator",
  "decorator",
  "default",
]);

const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeElixir structure", () => {
  it("a module: defmodule names a type, prevFn names functions, attrs are decorators", () => {
    const code = [
      "defmodule Greeter do",
      '  @moduledoc "Says hi"',
      "  def greet(name) do",
      '    IO.puts("hi " <> name)',
      "  end",
      "end",
    ].join("\n");
    expect(significant(tokenizeElixir(code))).toEqual([
      run("keyword", "defmodule"),
      run("type", "Greeter"), // the name after defmodule (DECL_KW)
      run("keyword", "do"),
      run("decorator", "@moduledoc"), // glued name; the string is its argument, not part of the run
      run("string", '"Says hi"'),
      run("keyword", "def"),
      run("fn", "greet"), // prevFn (the plan's trio)
      run("operator", "("),
      run("default", "name"),
      run("operator", ")"),
      run("keyword", "do"),
      run("default", "IO"), // all-caps is the MAX_SIZE exclusion: honestly not type-shaped
      run("operator", "."),
      run("fn", "puts"), // the call peek survives the dot
      run("operator", "("),
      run("string", '"hi "'),
      run("operator", "<>"), // binary concatenation is a run
      run("default", "name"),
      run("operator", ")"),
      run("keyword", "end"),
      run("keyword", "end"),
    ]);
  });

  it("paren-less definitions: `def foo do` and `def valid?/1` ride prevFn; `do:` is a key", () => {
    const code = ["def valid?(x), do: x > 0", "def foo! do", "end"].join("\n");
    expect(significant(tokenizeElixir(code))).toEqual([
      run("keyword", "def"),
      run("fn", "valid?"), // the `?` tail glues into the name (one word)
      run("operator", "("),
      run("default", "x"),
      run("operator", ")"),
      run("operator", ","),
      run("key", "do:"), // the colon moved to the end: the keyword form IS the atom :do
      run("default", "x"),
      run("operator", ">"),
      run("number", "0"),
      run("keyword", "def"),
      run("fn", "foo!"), // the bang tail, glued before `do` -- no paren anywhere (the pin)
      run("keyword", "do"),
      run("keyword", "end"),
    ]);
  });

  it("the pipe, anonymous fns and remote calls", () => {
    expect(significant(tokenizeElixir("result = xs |> Enum.map(fn x -> x * 2 end) |> Enum.to_list()"))).toEqual([
      run("default", "result"),
      run("operator", "="),
      run("default", "xs"),
      run("operator", "|>"), // the pipe is a run and NOT a member gesture
      run("type", "Enum"),
      run("operator", "."),
      run("fn", "map"),
      run("operator", "("),
      run("keyword", "fn"),
      run("default", "x"),
      run("operator", "->"), // the function head arrow: a run, not member
      run("default", "x"),
      run("operator", "*"),
      run("number", "2"),
      run("keyword", "end"),
      run("operator", ")"),
      run("operator", "|>"),
      run("type", "Enum"),
      run("operator", "."),
      run("fn", "to_list"),
      run("operator", "("),
      run("operator", ")"),
    ]);
  });

  it("atoms ride string; keyword keys ride key; `::` stays two operator bytes as one run", () => {
    const code = [
      '{:ok, value} = fetch(id)',
      "%{status: :active, count: 2}",
      '%{"raw" => 1}',
      "@spec fetch(id :: integer) :: :ok",
    ].join("\n");
    expect(significant(tokenizeElixir(code))).toEqual([
      run("operator", "{"),
      run("string", ":ok"), // atoms are string-like constants
      run("operator", ","),
      run("default", "value"),
      run("operator", "}"),
      run("operator", "="),
      run("fn", "fetch"),
      run("operator", "("),
      run("default", "id"),
      run("operator", ")"),
      run("operator", "%"),
      run("operator", "{"),
      run("key", "status:"), // the trailing-colon keyword form
      run("string", ":active"),
      run("operator", ","),
      run("key", "count:"),
      run("number", "2"),
      run("operator", "}"),
      run("operator", "%"),
      run("operator", "{"),
      run("string", '"raw"'),
      run("operator", "=>"), // the map arrow IS a real token (spec pin)
      run("number", "1"),
      run("operator", "}"),
      run("decorator", "@spec"),
      run("fn", "fetch"), // the attribute does not swallow the head (glued-paren rule)
      run("operator", "("),
      run("default", "id"),
      run("operator", "::"), // the typespec cons: a run, and `id:` does NOT glue
      run("default", "integer"), // typespec words are plain atoms, not keywords
      run("operator", ")"),
      run("operator", "::"),
      run("string", ":ok"),
    ]);
  });

  it("strings: interpolation holes ride the run (and a hole-closing quote is the pinned cost)", () => {
    expect(significant(tokenizeElixir('s = "hello #{name |> String.upcase()}!"'))).toEqual([
      run("default", "s"),
      run("operator", "="),
      run("string", '"hello #{name |> String.upcase()}!"'), // the hole is not parsed (rust ruling)
    ]);
    expect(significant(tokenizeElixir('"a#{"b"}c"'))).toEqual([
      run("string", '"a#{"'), // the hole quote closes the literal: pinned
      run("default", "b"),
      run("string", '"}c"'),
    ]);
  });

  it("charlists are strings: the ordinary scan opens on the single quote", () => {
    expect(significant(tokenizeElixir("c = 'abc'"))).toEqual([
      run("default", "c"),
      run("operator", "="),
      run("string", "'abc'"), // a charlist is a string-shaped value (dart doctrine)
    ]);
    // The apostrophe-in-text cost: a bare quote opens a run to EOL.
    expect(significant(tokenizeElixir("x ' y"))).toEqual([
      run("default", "x"),
      run("string", "' y"),
    ]);
  });

  it("heredocs scan to the next same-triple skipping escapes; quotes inside ride the run", () => {
    const code = ["doc = \"\"\"", "  indented \"with quotes\"", String.raw`  and \n more`, "  \"\"\"", "x = '''", "  raw '", "  '''"].join("\n");
    expect(significant(tokenizeElixir(code))).toEqual([
      run("default", "doc"),
      run("operator", "="),
      run("string", "\"\"\"\n  indented \"with quotes\"\n  and \\n more\n  \"\"\""),
      run("default", "x"),
      run("operator", "="),
      run("string", "'''\n  raw '\n  '''"), // an inner lone quote does not close the triple
    ]);
    // An escaped quote before the closer does NOT cut the run (swift's
    // escape-skip transfer): `\"""` inside is an escaped quote, not three.
    const esc = '"""' + "\n" + 'b \\""" c' + "\n" + '"""';
    expect(tokenizeElixir(esc)).toEqual([run("string", esc)]);
    // An unclosed heredoc runs to end of input.
    expect(tokenizeElixir('"""\nnever closed')).toEqual([run("string", '"""\nnever closed')]);
  });

  it("sigils: letter + delimiter pair + modifiers ride one string run; the pipe pair is NOT one", () => {
    expect(significant(tokenizeElixir('~r/foo\\d+/i ~S"C:\\path" ~w(a b "c d") ~c"hello"'))).toEqual([
      run("string", '~r/foo\\d+/i'), // the escape is skipped, the modifier rides
      run("string", '~S"C:\\path"'),
      run("string", '~w(a b "c d")'), // bracket pairs balance; quotes are bytes inside
      run("string", '~c"hello"'), // the charlist sigil
    ]);
    // The bare `~` is the regex sigil; uppercase letters may repeat, and
    // bracket pairs NEST (depth-counted), with modifiers riding.
    expect(significant(tokenizeElixir('~"plain regex" ~SS{a{b}}c'))).toEqual([
      run("string", '~"plain regex"'),
      run("string", "~SS{a{b}}c"),
    ]);
    // The reference lists exactly seven pairs -- `|` is not one, so `~w|..|`
    // degrades to the `~` operator plus ordinary tokens (spec pin).
    expect(significant(tokenizeElixir("~w|a b|"))).toEqual([
      run("operator", "~"),
      run("default", "w"),
      run("operator", "|"),
      run("default", "a"),
      run("default", "b"),
      run("operator", "|"),
    ]);
    // An unclosed sigil runs to end of input; a bare slash is division.
    expect(tokenizeElixir("~r/abc")).toEqual([run("string", "~r/abc")]);
    expect(significant(tokenizeElixir("a / b"))).toEqual([
      run("default", "a"),
      run("operator", "/"), // tilde-led or nothing: a bare `/` never opens a regex
      run("default", "b"),
    ]);
  });

  it("module attributes: decorator runs, the paren group only glues", () => {
    const code = ["@impl true", "@on_load(:init)", "@spec", "  foo(a) :: b", "@doc ~S\"raw\""].join("\n");
    expect(significant(tokenizeElixir(code))).toEqual([
      run("decorator", "@impl"),
      run("boolean", "true"),
      run("decorator", "@on_load(:init)"), // the glued group joins the run
      run("decorator", "@spec"), // no swallow: the next line's head stays code (the pin)
      run("fn", "foo"),
      run("operator", "("),
      run("default", "a"),
      run("operator", ")"),
      run("operator", "::"),
      run("default", "b"),
      run("decorator", "@doc"),
      run("string", '~S"raw"'),
    ]);
  });

  it("identifier tails: `!` and `?` glue as END marks, `!=` refuses, a spaced `!` is the operator", () => {
    expect(significant(tokenizeElixir('if ready?, do: raise!("boom")\nx != y\nfoo!=bar\nx? :y\n!!x'))).toEqual([
      run("keyword", "if"),
      run("default", "ready?"), // one word: the predicate tail
      run("operator", ","),
      run("key", "do:"),
      run("fn", "raise!"), // the bang tail, then the call peek claims fn
      run("operator", "("),
      run("string", '"boom"'),
      run("operator", ")"),
      run("default", "x"),
      run("operator", "!="), // `!=` is never absorbed into a name
      run("default", "y"),
      run("default", "foo"),
      run("operator", "!="),
      run("default", "bar"),
      run("default", "x?"), // the mark glues to the word...
      run("string", ":y"), // ...and the atom is the next token
      run("operator", "!"),
      run("operator", "!"),
      run("default", "x"),
    ]);
  });

  it("code points: `?a` is a number (the ruby contrast); a glued `?word` degrades", () => {
    expect(significant(tokenizeElixir("?a ?\\n ?ab"))).toEqual([
      run("number", "?a"), // 97: an integer here, not a string like ruby's
      run("number", "?\\n"),
      run("default", "?"), // glued to a longer word: no code point, a plain byte
      run("default", "ab"),
    ]);
  });

  it("numbers: radices, separators, floats; no octal legacy; validation degrades", () => {
    expect(significant(tokenizeElixir("42 1_000_000 0x1F 0o755 0b1010 123.4e10 1e10 017"))).toEqual([
      run("number", "42"),
      run("number", "1_000_000"),
      run("number", "0x1F"),
      run("number", "0o755"),
      run("number", "0b1010"),
      run("number", "123.4e10"),
      run("number", "1e10"), // an integer with an exponent is a float here
      run("number", "017"), // plain decimal: NO legacy octal
    ]);
    expect(significant(tokenizeElixir("0x 1_ 0b2 0o8 1.2.3"))).toEqual([
      run("default", "0x"),
      run("default", "1_"),
      run("default", "0b2"), // the radix scan eats the bad tail: the WHOLE word rides default
      run("default", "0o8"), // (kotlin's shape; there is no digit-restricted split scan)
      run("number", "1.2"), // no leading-dot float
      run("operator", "."),
      run("number", "3"),
    ]);
  });

  it("the operator zoo: real runs vs rejected spellings", () => {
    expect(significant(tokenizeElixir("a |> b <- c :: d .. e // f ++ g -- h && i || j =~ k"))).toEqual([
      run("default", "a"),
      run("operator", "|>"),
      run("default", "b"),
      run("operator", "<-"), // the comprehension generator
      run("default", "c"),
      run("operator", "::"),
      run("default", "d"),
      run("operator", ".."),
      run("default", "e"),
      run("operator", "//"), // the range step token (`1..10//2`)
      run("default", "f"),
      run("operator", "++"),
      run("default", "g"),
      run("operator", "--"),
      run("default", "h"),
      run("operator", "&&"),
      run("default", "i"),
      run("operator", "||"),
      run("default", "j"),
      run("operator", "=~"),
      run("default", "k"),
    ]);
    expect(significant(tokenizeElixir("x === y !== z <<< w >>> v ||| u &&& t"))).toEqual([
      run("default", "x"),
      run("operator", "==="), // the three-char check runs first (the dart lesson)
      run("default", "y"),
      run("operator", "!=="),
      run("default", "z"),
      run("operator", "<<<"),
      run("default", "w"),
      run("operator", ">>>"),
      run("default", "v"),
      run("operator", "|||"),
      run("default", "u"),
      run("operator", "&&&"),
      run("default", "t"),
    ]);
    // Rejected spellings degrade to singles (`=~` munches before the `=`).
    expect(significant(tokenizeElixir("a ^^^ b =~= c ~~~ d <=> g"))).toEqual([
      run("default", "a"),
      run("operator", "^"),
      run("operator", "^"),
      run("operator", "^"),
      run("default", "b"),
      run("operator", "=~"), // `=~=` is not a token: `=~` munches, then `=`
      run("operator", "="),
      run("default", "c"),
      run("operator", "~"), // `~~~` is gone from the operator table (the spec pin)
      run("operator", "~"),
      run("operator", "~"),
      run("default", "d"),
      run("operator", "<="), // no spaceship: `<=` munches first
      run("operator", ">"),
      run("default", "g"),
    ]);
    // `x?.y` (no safe navigation) reads as the word `x?`, a dot, a word --
    // the tail arm beats any operator reading, which is the whole point.
    expect(significant(tokenizeElixir("x?.y"))).toEqual([
      run("default", "x?"),
      run("operator", "."),
      run("default", "y"),
    ]);
  });

  it("comments: `#` to EOL (shebang included); NO block comments", () => {
    expect(significant(tokenizeElixir("#!/usr/bin/env elixir\nx = 1 # trailing\ny /* no a comment */ z"))).toEqual([
      run("comment", "#!/usr/bin/env elixir"),
      run("default", "x"),
      run("operator", "="),
      run("number", "1"),
      run("comment", "# trailing"),
      run("default", "y"),
      run("operator", "/"), // the C-shaped opener degrades (pinned)
      run("operator", "*"),
      run("default", "no"), // no word inside survives as a comment: they are all code now
      run("default", "a"),
      run("default", "comment"),
      run("operator", "*"),
      run("operator", "/"),
      run("default", "z"),
    ]);
  });

  it("comprehensions, with, and try/rescue/after: the block vocabulary reads", () => {
    expect(significant(tokenizeElixir("for x <- 1..3, into: %{}, do: x\nwith {:ok, v} <- f() do v end\ntry do g() rescue e -> e after cleanup() end"))).toEqual([
      run("keyword", "for"),
      run("default", "x"),
      run("operator", "<-"),
      run("number", "1"),
      run("operator", ".."),
      run("number", "3"),
      run("operator", ","),
      run("key", "into:"),
      run("operator", "%"),
      run("operator", "{"),
      run("operator", "}"),
      run("operator", ","),
      run("key", "do:"),
      run("default", "x"),
      run("keyword", "with"),
      run("operator", "{"),
      run("string", ":ok"),
      run("operator", ","),
      run("default", "v"),
      run("operator", "}"),
      run("operator", "<-"),
      run("fn", "f"),
      run("operator", "("),
      run("operator", ")"),
      run("keyword", "do"),
      run("default", "v"),
      run("keyword", "end"),
      run("keyword", "try"),
      run("keyword", "do"),
      run("fn", "g"),
      run("operator", "("),
      run("operator", ")"),
      run("keyword", "rescue"),
      run("default", "e"),
      run("operator", "->"),
      run("default", "e"),
      run("keyword", "after"),
      run("fn", "cleanup"),
      run("operator", "("),
      run("operator", ")"),
      run("keyword", "end"),
    ]);
  });

  it("booleans and nil ride their classes; True/Nil take the Capitalized reading", () => {
    expect(significant(tokenizeElixir("nil\ntrue and false or not nil"))).toEqual([
      run("null", "nil"), // the spelling pin: nil, not null/None
      run("boolean", "true"),
      run("keyword", "and"),
      run("boolean", "false"),
      run("keyword", "or"),
      run("keyword", "not"),
      run("null", "nil"),
    ]);
    expect(significant(tokenizeElixir("True Nil FALSE xor"))).toEqual([
      run("type", "True"),
      run("type", "Nil"),
      run("default", "FALSE"),
      run("default", "xor"), // a Kernel function, not a keyword (the spec pin)
    ]);
  });
});

describe("tokenizeElixir line-wise degradation (the file view tokenizes per line)", () => {
  it("unterminated literals stop honestly", () => {
    expect(tokenizeElixir('a "oops\nb')).toEqual([
      run("default", "a"),
      run("default", " "),
      run("string", '"oops'),
      run("default", "\n"),
      run("default", "b"),
    ]);
    expect(tokenizeElixir("'oops")).toEqual([run("string", "'oops")]);
    expect(tokenizeElixir('"splice\\')).toEqual([run("string", '"splice\\')]);
  });

  it("a heredoc opened on one line swallows that line; the tail re-reads", () => {
    expect(tokenizeElixir('x = """')).toEqual([
      run("default", "x"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("string", '"""'),
    ]);
    expect(tokenizeElixir("tail")).toEqual([run("default", "tail")]);
  });
});

describe("tokenizeElixir registry contract", () => {
  it("guesses and fences resolve through the registry", () => {
    expect(guessLangForBase("web.ex")).toBe("elixir");
    expect(guessLangForBase("script.exs")).toBe("elixir");
    expect(guessLangForBase("MAIN.EX")).toBe("elixir");
    expect(guessLangForBase("page.heex")).toBeUndefined(); // honestly unclaimed
    expect(guessLangForBase("mix.lock")).toBeUndefined();
    expect(resolveSyntaxLang("elixir")).toBe("elixir");
    expect(resolveSyntaxLang("ex")).toBeUndefined(); // extensions are never aliases
    expect(resolveSyntaxLang("exs")).toBeUndefined();
    expect(resolveSyntaxLang("Elixir")).toBeUndefined(); // the canonical name resolves exactly
    expect(getTokenizer("elixir")).toBe(tokenizeElixir);
  });
});

describe("tokenizeElixir losslessness", () => {
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
    "~",
    "~~~",
    "~r",
    "~r/",
    '~r"unterminated',
    "~w(",
    "~S'''x",
    "@",
    "@@",
    "@1",
    "@spec(",
    ":",
    "::",
    ":foo",
    ':"quoted',
    ":'c'",
    ":",
    "?",
    "?a",
    "?\\",
    "?(",
    "a?",
    "a!",
    "a!=",
    "x:",
    "x::",
    '"unterminated',
    "'unterminated",
    '"splice\\',
    '"""',
    "'''",
    '"""\nunterm',
    "0x",
    "0o",
    "0b",
    "1_",
    "0x1.2.3",
    "|>",
    "=>",
    "===",
    "<<<",
    "|||",
    "&&&",
    "^^^",
    "?.",
    "..",
    "//",
    "<-",
    "->",
    "\\\\",
    "^",
    "&",
    "|",
    "def",
    "def do",
    "nil",
    "end",
    "🚀 emoji ünïcøde 漢字",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeElixir(input);
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
      "#c",
      '"',
      "'",
      '"s"',
      "'c'",
      '"""',
      "'''",
      "~",
      "~r",
      "~r/",
      "~S(",
      "~w[",
      "~M",
      "@",
      "@spec",
      "@impl(",
      ":",
      "::",
      ":ok",
      ':"q"',
      "?",
      "?a",
      "x?",
      "x!",
      "x!=",
      "k:",
      "def",
      "defmodule",
      "do",
      "end",
      "fn",
      "true",
      "nil",
      "Foo",
      "0x1f",
      "0o7",
      "1_0",
      "1.5",
      "|>",
      "=>",
      "===",
      "<<<",
      "&&&",
      "<-",
      "->",
      "..",
      "//",
      "\\",
      "|",
      "&",
      "^",
      "!",
      "?",
      "(",
      ")",
      "[",
      "]",
      "{",
      "}",
      "%",
      "<",
      ">",
      "=",
      " ",
      "\n",
      "\r\n",
      "\t",
      "🚀",
      '"unterminated',
      "~r/unterm",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeElixir(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("elixir tokenizer wiring", () => {
  it("getTokenizer resolves elixir to tokenizeElixir and colors a web sample", () => {
    const code = [
      "defmodule MyApp.Router do",
      "  use Phoenix.Router",
      '  @moduledoc false',
      "",
      "  pipeline :browser do",
      '    plug :accepts, ["html"]',
      "  end",
      "",
      "  scope \"/\", MyApp do",
      '    get "/users", UserController, :index',
      "  end",
      "end",
    ].join("\n");
    const runs = getTokenizer("elixir")!(code);
    expect(runs.map((r) => r.text).join("")).toBe(code); // the registry contract, held
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "defmodule",
      "do",
      "use",
      "do", // pipeline ... do
      "end",
      "do", // scope ... do
      "end",
      "end",
    ]);
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual([
      "MyApp", // prevDecl after defmodule (mixed-case: only the DECL arm reads it)
      "Phoenix", // Capitalized before the dot
    ]); // `MyApp` in the scope line and `UserController` wash plain: the
    // typedef heuristic honestly misses multi-capital module names
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual([
      ":browser",
      ":accepts",
      '"html"',
      '"/"',
      '"/users"',
      ":index",
    ]);
    expect(runs.filter((r) => r.type === "decorator").map((r) => r.text)).toEqual(["@moduledoc"]);
    expect(runs.filter((r) => r.type === "boolean").map((r) => r.text)).toEqual(["false"]);
  });
});
