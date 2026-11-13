// Unit tests for the Dockerfile tokenizer (src/utils/syntax/dockerfile.ts):
// typed runs with exact classes and spans over targeted fixtures
// (instruction words at line start, builder-directive comments, $var
// interpolation, quoted arguments), line-wise degradation pins for the
// file view, a losslessness sweep over a nasty fixture corpus plus a
// deterministic fragment generator, and the registry wiring pins.

import { describe, it, expect } from "bun:test";
import { getTokenizer } from "@utils/syntax/index.ts";
import { tokenizeDockerfile } from "@utils/syntax/dockerfile.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

/** The tokenizer's declared class vocabulary (every run must live here). */
const TYPES = new Set(["keyword", "comment", "string", "variable", "operator", "default"]);

/** Drop the whitespace/newline passthrough to assert the interesting runs. */
const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeDockerfile instructions", () => {
  it("classifies a whole recipe: directives, instructions, strings", () => {
    expect(significant(tokenizeDockerfile('# syntax=docker/dockerfile:1\nFROM golang:1.21 AS build'))).toEqual([
      run("comment", "# syntax=docker/dockerfile:1"), // builder directives are comments to the parser too
      run("keyword", "FROM"),
      run("default", "golang:1.21"),
      run("default", "AS"), // stage names ride plain words (documented)
      run("default", "build"),
    ]);
    expect(significant(tokenizeDockerfile('CMD ["nginx", "-g", "daemon off;"]'))).toEqual([
      run("keyword", "CMD"),
      run("default", "["),
      run("string", '"nginx"'),
      run("default", ","),
      run("string", '"-g"'),
      run("default", ","),
      run("string", '"daemon off;"'),
      run("default", "]"),
    ]);
  });

  it("instructions are case-insensitive per the spec", () => {
    expect(significant(tokenizeDockerfile("from alpine\nrun $HOME"))).toEqual([
      run("keyword", "from"),
      run("default", "alpine"),
      run("keyword", "run"),
      run("variable", "$HOME"),
    ]);
  });

  it("a word that merely starts with an instruction is not one", () => {
    expect(significant(tokenizeDockerfile("FORM x\nRUNNER=1\nRUNX"))).toEqual([
      run("default", "FORM"),
      run("default", "x"),
      run("default", "RUNNER"),
      run("operator", "="),
      run("default", "1"),
      run("default", "RUNX"),
    ]);
  });

  it("no instruction mid-line: only line-start words read", () => {
    expect(significant(tokenizeDockerfile("echo FROM x"))).toEqual([
      run("default", "echo"),
      run("default", "FROM"),
      run("default", "x"),
    ]);
  });
});

describe("tokenizeDockerfile arguments", () => {
  it("$VAR and ${VAR...} ride variable; a bare $ is text", () => {
    expect(significant(tokenizeDockerfile("ENV A=${X:-y} B=$ Z=$PATH/x"))).toEqual([
      run("keyword", "ENV"),
      run("default", "A"),
      run("operator", "="),
      run("variable", "${X:-y}"), // whatever the braces hold rides the run
      run("default", "B"),
      run("operator", "="),
      run("default", "$"),
      run("default", "Z"),
      run("operator", "="),
      run("variable", "$PATH"),
      run("default", "/x"),
    ]);
  });

  it("interpolation inside quotes rides the string run", () => {
    expect(significant(tokenizeDockerfile('LABEL note="${HOME} here"'))).toEqual([
      run("keyword", "LABEL"),
      run("default", "note"),
      run("operator", "="),
      run("string", '"${HOME} here"'),
    ]);
  });

  it("a mid-line # is literal bytes; only a line-leading one comments", () => {
    expect(significant(tokenizeDockerfile("RUN echo a#b"))).toEqual([
      run("keyword", "RUN"),
      run("default", "echo"),
      run("default", "a#b"),
    ]);
  });

  it("the shell inside RUN is not parsed: operators, flags and pipes ride default", () => {
    expect(significant(tokenizeDockerfile("RUN make -j4 | tee log && exit 1"))).toEqual([
      run("keyword", "RUN"),
      run("default", "make"),
      run("default", "-j4"),
      run("default", "|"),
      run("default", "tee"),
      run("default", "log"),
      run("default", "&&"),
      run("default", "exit"),
      run("default", "1"),
    ]);
  });
});

describe("tokenizeDockerfile line-wise degradation (the file view tokenizes per line)", () => {
  it("the trailing-backslash continuation is not modeled: each line reads on its own", () => {
    const src = "RUN apt-get update \\\n    && apt-get install -y curl \\\n    && rm -rf /var";
    const runs = tokenizeDockerfile(src);
    expect(runs.map((r) => r.text).join("")).toBe(src); // lossless regardless
    const sig = significant(runs);
    expect(sig[0]).toEqual(run("keyword", "RUN"));
    // The continuation tails are their own junk lines: shell noise reads as
    // plain words, the backslashes ride default. Never garble.
    expect(sig).toContainEqual(run("default", "\\"));
    expect(sig).toContainEqual(run("default", "&&"));
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual(["RUN"]);
  });

  it("an unterminated string stops at the newline; an unterminated ${...} stops too", () => {
    expect(tokenizeDockerfile('a "unterm\nb = 1')).toEqual([
      run("default", "a"),
      run("default", " "),
      run("string", '"unterm'),
      run("default", "\n"),
      run("default", "b"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("default", "1"),
    ]);
    expect(tokenizeDockerfile("X ${OPEN")).toEqual([
      run("default", "X"),
      run("default", " "),
      run("variable", "${OPEN"), // runs to the line end, honest open span
    ]);
  });
});

describe("tokenizeDockerfile losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "x".repeat(50000),
    "#",
    "# c",
    "$",
    "${",
    "${}",
    "$}",
    "{",
    "}",
    '"',
    "'",
    '""',
    "''",
    '"trail\\',
    "\\",
    "\\\n",
    "=",
    "==",
    "FROM",
    "FROM ",
    "from",
    "RUN\u0000x",
    "ENV A=",
    "$VAR",
    "${A:-b}",
    "${A",
    "🚀 emoji ünïcøde 漢字",
    "RUN a\rb\nc",
    "COPY x y # trailing comment",
    "HEALTHCHECK CMD curl -f http://x/ || exit 1",
    "FROM$X",
    '"unterm\nnext',
    "'unterm\r\nnext",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeDockerfile(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "FROM",
      "RUN",
      "COPY",
      "ENV",
      "as",
      "AS",
      "#",
      "#c\n",
      '"',
      "'",
      '"s"',
      "'s'",
      "$",
      "${",
      "}",
      "$VAR",
      "${VAR}",
      "=",
      "\\",
      " ",
      "\n",
      "    ",
      "\t",
      "\r\n",
      "&&",
      "--flag",
      "/app",
      ":",
      ",",
      "🚀",
      "x",
      "1",
      '"unterminated',
      "${UNTERM",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeDockerfile(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("dockerfile tokenizer wiring", () => {
  it("getTokenizer resolves dockerfile to tokenizeDockerfile and colors a recipe sample", () => {
    expect(getTokenizer("dockerfile")).toBe(tokenizeDockerfile);
    const recipe = [
      "# build stage",
      "FROM golang:1.21 AS build",
      "WORKDIR /src",
      "COPY go.mod .",
      "RUN CGO=0 make build # link",
      'CMD ["/bin/app", "--port=8080"]',
    ].join("\n");
    const runs = getTokenizer("dockerfile")!(recipe);
    expect(runs.map((r) => r.text).join("")).toBe(recipe); // the registry contract, held
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "FROM",
      "WORKDIR",
      "COPY",
      "RUN",
      "CMD",
    ]);
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual(["# build stage"]);
    expect(runs.filter((r) => r.type === "operator").map((r) => r.text)).toEqual(["="]);
    expect(significant(runs)).toContainEqual(run("string", '"--port=8080"'));
    // The RUN shell body is default bytes; CGO=0's = is the one operator.
    expect(runs.some((r) => r.type === "default" && r.text === "make")).toBe(true);
  });
});
