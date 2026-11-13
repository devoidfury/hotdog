// Unit tests for the INI tokenizer (src/utils/syntax/ini.ts): the toml
// scanner over the ini dialect -- typed runs with exact classes and spans
// over targeted fixtures (# and ; comments, = and : separators, run-to-EOL
// string values with trailing-comment splits), line-wise degradation pins,
// a losslessness sweep over a nasty fixture corpus plus a deterministic
// fragment generator, and the registry wiring pins.

import { describe, it, expect } from "bun:test";
import { getTokenizer } from "@utils/syntax/index.ts";
import { tokenizeIni } from "@utils/syntax/ini.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

/** The tokenizer's declared class vocabulary (every run must live here). */
const TYPES = new Set(["section", "key", "string", "comment", "operator", "default"]);

/** Drop the whitespace/newline passthrough to assert the interesting runs. */
const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeIni lines", () => {
  it("classifies a whole file skeleton", () => {
    expect(significant(tokenizeIni("; lead\n[server]\nport = 8080\nhost: example.com"))).toEqual([
      run("comment", "; lead"),
      run("section", "[server]"),
      run("key", "port"),
      run("operator", "="),
      run("string", "8080"), // no typed literals in ini: values are strings
      run("key", "host"),
      run("operator", ":"),
      run("string", "example.com"),
    ]);
  });

  it("# joins ; as a comment opener", () => {
    expect(significant(tokenizeIni("# hash\n; semi\nk = v"))).toEqual([
      run("comment", "# hash"),
      run("comment", "; semi"),
      run("key", "k"),
      run("operator", "="),
      run("string", "v"),
    ]);
  });

  it("a trailing comment needs whitespace; a glued # or ; is value bytes", () => {
    expect(significant(tokenizeIni("dsn = db://h;p # tail\nx = a#b;c"))).toEqual([
      run("key", "dsn"),
      run("operator", "="),
      run("string", "db://h;p"),
      run("comment", "# tail"),
      run("key", "x"),
      run("operator", "="),
      run("string", "a#b;c"),
    ]);
  });

  it("values keep = and : bytes; quoted values are their own runs", () => {
    expect(significant(tokenizeIni('b64 = YQ==\nmsg = "hi: there" ; note'))).toEqual([
      run("key", "b64"),
      run("operator", "="),
      run("string", "YQ=="),
      run("key", "msg"),
      run("operator", "="),
      run("string", '"hi: there"'),
      run("comment", "; note"),
    ]);
  });

  it("an empty value claims nothing", () => {
    expect(tokenizeIni("flag =")).toEqual([
      run("key", "flag"),
      run("default", " "),
      run("operator", "="),
    ]);
  });

  it("[[x]] degrades to a section run plus a stray bracket (no array tables)", () => {
    expect(significant(tokenizeIni("[[x]]"))).toEqual([run("section", "[[x]"), run("default", "]")]);
  });
});

describe("tokenizeIni line-wise degradation (the file view tokenizes per line)", () => {
  it("an unclosed header stops at the line end", () => {
    expect(tokenizeIni("[open\nk = v")).toEqual([
      run("section", "[open"),
      run("default", "\n"),
      run("key", "k"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("string", "v"),
    ]);
  });

  it("an unterminated quoted value stops at the newline", () => {
    expect(tokenizeIni('k = "oops\nj = 1')).toEqual([
      run("key", "k"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("string", '"oops'),
      run("default", "\n"),
      run("key", "j"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("string", "1"),
    ]);
  });

  it("a bare word with no separator stays default", () => {
    expect(significant(tokenizeIni("stray words here"))).toEqual([
      run("default", "stray"),
      run("default", "words"),
      run("default", "here"),
    ]);
  });
});

describe("tokenizeIni losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "x".repeat(50000),
    "[",
    "[]",
    "[[",
    "[[]]]",
    "]",
    "=",
    ":",
    "=:",
    "k=",
    "k:",
    "#",
    ";",
    '"',
    "'",
    '"unterm',
    "'unterm",
    "k = \"a\\\"b\"", // backslash is not an ini escape: value bytes
    "k = v ; c ; d",
    "k = ;c",
    "k = ; c",
    "[s] ; c",
    "🚀 emoji ünïcøde 漢字 = 🚀",
    "a=1\r\nb=2\r",
    "; c\r\n[s]\r\nk=v\r\n",
    "key with spaces = 1",
    "k=v".repeat(5000),
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeIni(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "[",
      "]",
      "[[",
      "]]",
      "=",
      ":",
      ";c\n",
      "#c\n",
      ";",
      "#",
      "'",
      '"',
      '"str"',
      "\\",
      "1",
      "key",
      "a.b",
      "value",
      " ",
      "\n",
      "\r\n",
      "\t",
      "🚀",
      '"unterminated',
      "k = ",
      "k:",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeIni(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("ini tokenizer wiring", () => {
  it("getTokenizer resolves ini to tokenizeIni and colors a setup.ini sample", () => {
    expect(getTokenizer("ini")).toBe(tokenizeIni);
    const doc = [
      "; release config",
      "[paths]",
      "data = /var/lib/hotdog",
      "[server] ; runtime",
      "port: 8765",
    ].join("\n");
    const runs = getTokenizer("ini")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc); // the registry contract, held
    expect(runs.filter((r) => r.type === "section").map((r) => r.text)).toEqual(["[paths]", "[server]"]);
    expect(significant(runs)).toContainEqual(run("comment", "; release config"));
    expect(significant(runs)).toContainEqual(run("comment", "; runtime"));
    expect(runs.filter((r) => r.type === "key").map((r) => r.text)).toEqual(["data", "port"]);
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual(["/var/lib/hotdog", "8765"]);
  });
});
