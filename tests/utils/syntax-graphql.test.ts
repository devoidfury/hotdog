// Unit tests for the GraphQL tokenizer (src/utils/syntax/graphql.ts): typed
// runs with exact classes and spans over targeted fixtures (type/query keywords,
// variable and directive forms, block strings, comment lines, the scalar-ish
// number forms), a losslessness sweep over a nasty fixture corpus plus a
// deterministic fragment generator, and the registry wiring pins (extensions
// and fence aliases).

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeGraphQL } from "@utils/syntax/graphql.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

const TYPES = new Set([
  "comment",
  "string",
  "number",
  "boolean",
  "null",
  "keyword",
  "type",
  "key",
  "variable",
  "decorator",
  "fn",
  "operator",
  "default",
]);

const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeGraphQL structure", () => {
  it("schema keywords, types, keys and non-null markers read cleanly", () => {
    expect(significant(tokenizeGraphQL("type Query { id: ID! }"))).toEqual([
      run("keyword", "type"),
      run("type", "Query"),
      run("operator", "{"),
      run("key", "id"),
      run("operator", ":"),
      run("type", "ID"),
      run("operator", "!"),
      run("operator", "}"),
    ]);
  });

  it("variables, directives, and aliases are distinct classes", () => {
    expect(significant(tokenizeGraphQL(`{ ...Frag me @deprecated(reason: "old") }`))).toEqual([
      run("operator", "{"),
      run("operator", "..."),
      run("type", "Frag"),
      run("default", "me"),
      run("decorator", "@deprecated"),
      run("operator", "("),
      run("key", "reason"),
      run("operator", ":"),
      run("string", '"old"'),
      run("operator", ")"),
      run("operator", "}"),
    ]);
  });

  it("query operations lift, literals classify, and block strings survive newlines", () => {
    expect(significant(tokenizeGraphQL('query Foo($a: Int = 3, $b: Boolean = true) { x(a: -1, e: 1.2e3) }'))).toEqual([
      run("keyword", "query"),
      run("type", "Foo"),
      run("operator", "("),
      run("variable", "$a"),
      run("operator", ":"),
      run("type", "Int"),
      run("operator", "="),
      run("number", "3"),
      run("operator", ","),
      run("variable", "$b"),
      run("operator", ":"),
      run("type", "Boolean"),
      run("operator", "="),
      run("boolean", "true"),
      run("operator", ")"),
      run("operator", "{"),
      run("fn", "x"),
      run("operator", "("),
      run("key", "a"),
      run("operator", ":"),
      run("number", "-1"),
      run("operator", ","),
      run("key", "e"),
      run("operator", ":"),
      run("number", "1.2e3"),
      run("operator", ")"),
      run("operator", "}"),
    ]);

    expect(significant(tokenizeGraphQL('"""block\nstring"""'))).toEqual([
      run("string", '"""block\nstring"""'),
    ]);
  });

  it("comments survive to the line end", () => {
    expect(significant(tokenizeGraphQL("# note\nquery Foo { x }"))).toEqual([
      run("comment", "# note"),
      run("keyword", "query"),
      run("type", "Foo"),
      run("operator", "{"),
      run("default", "x"),
      run("operator", "}"),
    ]);
  });
});

describe("tokenizeGraphQL registry contract", () => {
  it("guesses: common extensions and fence aliases land", () => {
    expect(guessLangForBase("schema.graphql")).toBe("graphql");
    expect(guessLangForBase("schema.gql")).toBe("graphql");
    expect(guessLangForBase("schema.graphqls")).toBe("graphql");
    expect(resolveSyntaxLang("gql")).toBe("graphql");
    expect(resolveSyntaxLang("graphqls")).toBe("graphql");
    expect(getTokenizer("graphql")).toBe(tokenizeGraphQL);
  });
});

describe("tokenizeGraphQL losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\n",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "a".repeat(50000),
    "#",
    "#\n",
    "{",
    "}",
    "...",
    "$a",
    "@x",
    '"""',
    '"""a',
    '"',
    "'oops",
    "true false null",
    "type Query { id: ID! }",
    "{ x(a: -1, e: 1.2e3, s: 'ok', d: \"ok\") }",
    "🚀 emoji ünïcøde 漢字",
    "#c\n{ x }",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeGraphQL(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "#c\n",
      "{",
      "}",
      "(",
      ")",
      "[",
      "]",
      ":",
      "!",
      "|",
      "&",
      "=",
      ",",
      "...",
      "$a",
      "@x",
      '"',
      "'",
      '"""',
      '"str"',
      "1",
      "-1",
      "1.2",
      "1e3",
      "true",
      "false",
      "null",
      "query",
      "type",
      "Foo",
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
      const runs = tokenizeGraphQL(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("graphql tokenizer wiring", () => {
  it("getTokenizer resolves graphql to tokenizeGraphQL and classifies a sample", () => {
    const doc = [
      "# schema",
      "type Query {",
      "  user(id: ID!): User!",
      '  search(term: String = "x"): [SearchResult!]!',
      "}",
    ].join("\n");
    const runs = getTokenizer("graphql")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual(["# schema"]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual(["type"]);
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual([
      "Query",
      "ID",
      "User",
      "String",
      "SearchResult",
    ]);
    expect(runs.filter((r) => r.type === "key").map((r) => r.text)).toEqual(["id", "term"]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual(["user", "search"]);
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual(['"x"']);
  });
});
