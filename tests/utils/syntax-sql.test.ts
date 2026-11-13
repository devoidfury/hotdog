// Unit tests for the SQL tokenizer (src/utils/syntax/sql.ts): typed runs
// with exact classes and spans over targeted fixtures (case-insensitive
// keyword matching, the literal classes, both quote forms with the ''
// doubling, the tight fn peek, the structural-only operator accent),
// line-wise degradation pins for the file view, a losslessness sweep over
// a nasty fixture corpus plus a deterministic fragment generator, and the
// registry wiring pins.

import { describe, it, expect } from "bun:test";
import { getTokenizer, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeSql } from "@utils/syntax/sql.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

/** The tokenizer's declared class vocabulary (every run must live here). */
const TYPES = new Set([
  "keyword",
  "boolean",
  "null",
  "fn",
  "string",
  "comment",
  "number",
  "operator",
  "default",
]);

/** Drop the whitespace/newline passthrough to assert the interesting runs. */
const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeSql structure", () => {
  it("classifies a whole query", () => {
    expect(significant(tokenizeSql("SELECT COUNT(*), u.name FROM users AS u WHERE u.id = 42; -- tail"))).toEqual([
      run("keyword", "SELECT"),
      run("fn", "COUNT"), // glued `(`: the call reading
      run("default", "("),
      run("default", "*"),
      run("default", ")"),
      run("operator", ","),
      run("default", "u"),
      run("operator", "."),
      run("default", "name"),
      run("keyword", "FROM"),
      run("default", "users"),
      run("keyword", "AS"),
      run("default", "u"),
      run("keyword", "WHERE"),
      run("default", "u"),
      run("operator", "."),
      run("default", "id"),
      run("default", "="), // comparison is prose; only ; . , are the accent
      run("number", "42"),
      run("operator", ";"),
      run("comment", "-- tail"),
    ]);
  });

  it("keywords match case-insensitively; the literals ride their classes", () => {
    expect(significant(tokenizeSql("select null, TRUE, False, \"Order\" from t where x is not null"))).toEqual([
      run("keyword", "select"),
      run("null", "null"),
      run("operator", ","),
      run("boolean", "TRUE"),
      run("operator", ","),
      run("boolean", "False"),
      run("operator", ","),
      run("string", '"Order"'), // quoted identifiers ride string (documented leniency)
      run("keyword", "from"),
      run("default", "t"),
      run("keyword", "where"),
      run("default", "x"),
      run("keyword", "is"),
      run("keyword", "not"),
      run("null", "null"),
    ]);
  });

  it("DDL: table names stay words (the fn peek does not cross whitespace)", () => {
    const runs = significant(tokenizeSql("CREATE TABLE t (id INT PRIMARY KEY); INSERT INTO t VALUES (1);"));
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "CREATE",
      "TABLE",
      "PRIMARY",
      "KEY",
      "INSERT",
      "INTO",
      "VALUES",
    ]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual([]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual(["1"]);
  });

  it("whole-word matching: SELECTED is not SELECT", () => {
    expect(significant(tokenizeSql("SELECTED selectX"))).toEqual([
      run("default", "SELECTED"),
      run("default", "selectX"),
    ]);
  });

  it("prefixed variables and params ride one default run", () => {
    const runs = tokenizeSql("$1 :name @var @@version ?");
    expect(runs.map((r) => r.text).join("")).toBe("$1 :name @var @@version ?");
    expect(runs.every((r) => r.type === "default" || r.text.trim() === "")).toBe(true);
  });
});

describe("tokenizeSql strings and comments", () => {
  it("'' doubling keeps a quote inside; both forms and the block comment degrade honestly", () => {
    expect(significant(tokenizeSql("'it''s' \"quoted\" 'unterm\nnext /* blk */ ; /* unterm"))).toEqual([
      run("string", "'it''s'"),
      run("string", '"quoted"'),
      run("string", "'unterm"),
      run("default", "next"),
      run("comment", "/* blk */"),
      run("operator", ";"),
      run("comment", "/* unterm"),
    ]);
  });

  it("a backslash is a literal byte (standard SQL): the string closes at the next quote", () => {
    expect(significant(tokenizeSql("'a\\' b'"))).toEqual([
      run("string", "'a\\'"),
      run("default", "b"),
      run("string", "'"),
    ]);
  });

  it("double dash runs to EOL; the block form to its closer or end of input", () => {
    expect(tokenizeSql("a -- b\nc")).toEqual([
      run("default", "a"),
      run("default", " "),
      run("comment", "-- b"),
      run("default", "\n"),
      run("default", "c"),
    ]);
    expect(tokenizeSql("/* unterm forever")).toEqual([run("comment", "/* unterm forever")]);
  });

  it("comment openers inside strings stay strings", () => {
    expect(significant(tokenizeSql("x = '-- not a comment /* */'"))).toEqual([
      run("default", "x"),
      run("default", "="), // comparison is prose
      run("string", "'-- not a comment /* */'"),
    ]);
  });
});

describe("tokenizeSql numbers", () => {
  it("plain numeric literals; comparison minus is prose", () => {
    const runs = significant(tokenizeSql("[1, 1.5, .5, 1e3, -2, 1.2.3]"));
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual([
      "1",
      "1.5",
      ".5",
      "1e3",
      "2", // the `-` is prose, not part of the literal
      "1.2",
      ".3",
    ]);
  });

  it("a tail like `1e` never lands its exponent", () => {
    expect(significant(tokenizeSql("1e x"))).toEqual([
      run("number", "1"),
      run("default", "e"),
      run("default", "x"),
    ]);
  });
});

describe("tokenizeSql line-wise degradation (the file view tokenizes per line)", () => {
  it("an unterminated string stops at the end of input; the next line re-reads", () => {
    expect(tokenizeSql("SELECT 'oops")).toEqual([
      run("keyword", "SELECT"),
      run("default", " "),
      run("string", "'oops"),
    ]);
    expect(significant(tokenizeSql("SELECT 1"))).toEqual([run("keyword", "SELECT"), run("number", "1")]);
  });

  it("an unterminated block comment runs to end of input; a closer fragment re-reads honest", () => {
    expect(tokenizeSql("/* open")).toEqual([run("comment", "/* open")]);
    expect(tokenizeSql("*/")).toEqual([run("default", "*"), run("default", "/")]);
  });
});

describe("tokenizeSql losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "x".repeat(50000),
    "-",
    "--",
    "--\n",
    "/",
    "/*",
    "*/",
    "'",
    '"',
    "''",
    '""',
    "'it''s'",
    "'''",
    "'trail\\",
    "$",
    "$1",
    "@",
    ":",
    "::",
    "?",
    "1..",
    ".5.",
    "1e 1e+ 1.2.3",
    "🚀 emoji ünïcøde 漢字",
    "SELECT 'unterm\nINSERT /* unterm\nUPDATE -- c\nDELETE",
    "'--x /*y*/'",
    '"a--b"',
    "count(x) COUNT (y) NOW()",
    "select NULL, True, fALSE",
    "end;END;End",
    "-- 'not a string",
    "/* 'also not */ SELECT 1",
    "a\r\nb\r",
    "e2 EXCEPT 2e",
    ":name @ver $1 ?",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeSql(input);
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
      "=",
      "--c\n",
      "/*",
      "*/",
      "'",
      '"',
      "'it''s'",
      '"str"',
      "'unterm",
      "1",
      "1e",
      "0x",
      "SELECT",
      "select",
      "null",
      "NULL",
      "TRUE",
      "false",
      "COUNT",
      "x",
      " ",
      "\n",
      "\r\n",
      "\t",
      "🚀",
      "$",
      "$1",
      "@",
      ":",
      ":name",
      "?",
      "%",
      "\\",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeSql(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("sql tokenizer wiring", () => {
  it("getTokenizer resolves sql to tokenizeSql and colors a query sample", () => {
    expect(getTokenizer("sql")).toBe(tokenizeSql);
    expect(resolveSyntaxLang("sql")).toBe("sql");
    const code = [
      "-- report",
      "SELECT name, COUNT(*) AS n FROM users",
      "WHERE active = TRUE GROUP BY name;",
    ].join("\n");
    const runs = getTokenizer("sql")!(code);
    expect(runs.map((r) => r.text).join("")).toBe(code); // the registry contract, held
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual(["-- report"]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "SELECT",
      "AS",
      "FROM",
      "WHERE",
      "GROUP",
      "BY",
    ]);
    expect(runs.filter((r) => r.type === "boolean").map((r) => r.text)).toEqual(["TRUE"]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual(["COUNT"]);
    expect(runs.filter((r) => r.type === "operator").map((r) => r.text)).toEqual([",", ";"]);
  });

  it("no dialect aliases are registered (no speculative spellings)", () => {
    expect(resolveSyntaxLang("mysql")).toBeUndefined();
    expect(resolveSyntaxLang("postgres")).toBeUndefined();
    expect(resolveSyntaxLang("plsql")).toBeUndefined();
  });
});
