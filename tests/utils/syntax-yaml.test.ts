// Unit tests for the YAML tokenizer (src/utils/syntax/yaml.ts): typed runs
// with exact classes and spans over targeted fixtures, a losslessness sweep
// over a nasty fixture corpus plus a deterministic fragment generator, and
// the registry wiring pin that enables workflow_validate's lang:"yaml"
// display declaration (the tool itself is not touched here).

import { describe, it, expect } from "bun:test";
import { getTokenizer, type SyntaxRun } from "@utils/syntax/index.ts";
import { tokenizeYaml } from "@utils/syntax/yaml.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

/** The tokenizer's declared class vocabulary (every run must live here). */
const TYPES = new Set([
  "key",
  "string",
  "comment",
  "number",
  "boolean",
  "null",
  "anchor",
  "alias",
  "tag",
  "marker",
  "operator",
  "default",
]);

/** Drop the whitespace/newline passthrough to assert the interesting runs. */
const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeYaml comments", () => {
  it("classifies a line-leading #", () => {
    expect(tokenizeYaml("# just a note")).toEqual([run("comment", "# just a note")]);
  });

  it("classifies a trailing # after whitespace", () => {
    expect(tokenizeYaml("key: value # trailing")).toEqual([
      run("key", "key"),
      run("operator", ":"),
      run("default", " "),
      run("string", "value"),
      run("default", " "),
      run("comment", "# trailing"),
    ]);
  });

  it("keeps # inside quoted strings out of the comment class", () => {
    const runs = significant(tokenizeYaml('name: "a # b" # real'));
    expect(runs).toEqual([
      run("key", "name"),
      run("operator", ":"),
      run("string", '"a # b"'),
      run("comment", "# real"),
    ]);
    expect(significant(tokenizeYaml("msg: 'it''s # fine'"))).toEqual([
      run("key", "msg"),
      run("operator", ":"),
      run("string", "'it''s # fine'"),
    ]);
  });

  it("leaves # glued inside a plain scalar (URL fragments) in the scalar", () => {
    expect(significant(tokenizeYaml("url: http://x#frag"))).toEqual([
      run("key", "url"),
      run("operator", ":"),
      run("string", "http://x#frag"),
    ]);
    // Colon-in-URL too: the ':' only cuts at space/EOL.
    expect(significant(tokenizeYaml("url: http://example.com:8080/p#f"))).toEqual([
      run("key", "url"),
      run("operator", ":"),
      run("string", "http://example.com:8080/p#f"),
    ]);
  });
});

describe("tokenizeYaml mappings and sequences", () => {
  it("types a simple mapping key and its value", () => {
    expect(tokenizeYaml("key: value")).toEqual([
      run("key", "key"),
      run("operator", ":"),
      run("default", " "),
      run("string", "value"),
    ]);
  });

  it("types keys at every indentation level", () => {
    expect(tokenizeYaml("a:\n  b:\n    c: 1\n")).toEqual([
      run("key", "a"),
      run("operator", ":"),
      run("default", "\n"),
      run("default", "  "),
      run("key", "b"),
      run("operator", ":"),
      run("default", "\n"),
      run("default", "    "),
      run("key", "c"),
      run("operator", ":"),
      run("default", " "),
      run("number", "1"),
      run("default", "\n"),
    ]);
  });

  it("types list dashes as operators, keys after a dash as keys", () => {
    expect(tokenizeYaml("- one\n- two: 2\n")).toEqual([
      run("operator", "-"),
      run("default", " "),
      run("string", "one"),
      run("default", "\n"),
      run("operator", "-"),
      run("default", " "),
      run("key", "two"),
      run("operator", ":"),
      run("default", " "),
      run("number", "2"),
      run("default", "\n"),
    ]);
    // Glued "-3" is a number, not a dash.
    expect(significant(tokenizeYaml("- -3"))).toEqual([
      run("operator", "-"),
      run("number", "-3"),
    ]);
  });

  it("types quoted keys too, with escape handling", () => {
    expect(significant(tokenizeYaml("'a: b': c"))).toEqual([
      run("key", "'a: b'"),
      run("operator", ":"),
      run("string", "c"),
    ]);
    expect(significant(tokenizeYaml('"x\\"y": 1'))).toEqual([
      run("key", '"x\\"y"'),
      run("operator", ":"),
      run("number", "1"),
    ]);
    // A quoted scalar with no colon after it is a value, not a key.
    expect(significant(tokenizeYaml('say: "hi"'))).toEqual([
      run("key", "say"),
      run("operator", ":"),
      run("string", '"hi"'),
    ]);
  });
});

describe("tokenizeYaml scalar classes", () => {
  it("numbers, booleans and nulls read as themselves", () => {
    expect(significant(tokenizeYaml("n: 42\nf: -1.5e3\nb: True\no: OFF\nz: ~\nh: 0x1F\n"))).toEqual([
      run("key", "n"),
      run("operator", ":"),
      run("number", "42"),
      run("key", "f"),
      run("operator", ":"),
      run("number", "-1.5e3"),
      run("key", "b"),
      run("operator", ":"),
      run("boolean", "True"),
      run("key", "o"),
      run("operator", ":"),
      run("boolean", "OFF"),
      run("key", "z"),
      run("operator", ":"),
      run("null", "~"),
      run("key", "h"),
      run("operator", ":"),
      run("number", "0x1F"),
    ]);
    // A key is a key even when it reads as a scalar.
    expect(significant(tokenizeYaml("true: yes\nnull: ~"))).toEqual([
      run("key", "true"),
      run("operator", ":"),
      run("boolean", "yes"),
      run("key", "null"),
      run("operator", ":"),
      run("null", "~"),
    ]);
  });

  it("anchors, aliases and tags", () => {
    expect(significant(tokenizeYaml("base: &b\nuse: *base\ntype: !!str hi\n"))).toEqual([
      run("key", "base"),
      run("operator", ":"),
      run("anchor", "&b"),
      run("key", "use"),
      run("operator", ":"),
      run("alias", "*base"),
      run("key", "type"),
      run("operator", ":"),
      run("tag", "!!str"),
      run("string", "hi"),
    ]);
  });

  it("--- and ... are document markers at column 0", () => {
    expect(tokenizeYaml("---\na: 1\n...\n")).toEqual([
      run("marker", "---"),
      run("default", "\n"),
      run("key", "a"),
      run("operator", ":"),
      run("default", " "),
      run("number", "1"),
      run("default", "\n"),
      run("marker", "..."),
      run("default", "\n"),
    ]);
    // "----" is not a marker.
    expect(significant(tokenizeYaml("----"))).toEqual([run("string", "----")]);
  });
});

describe("tokenizeYaml block scalars", () => {
  it("emits the | header honestly and the indented body as ONE string run", () => {
    expect(tokenizeYaml("lit: |\n  line one\n  line two\nnext: 1\n")).toEqual([
      run("key", "lit"),
      run("operator", ":"),
      run("default", " "),
      run("operator", "|"),
      run("default", "\n"),
      run("string", "  line one\n  line two\n"),
      run("key", "next"),
      run("operator", ":"),
      run("default", " "),
      run("number", "1"),
      run("default", "\n"),
    ]);
  });

  it("handles a folded > block with a chomping indicator", () => {
    expect(tokenizeYaml("folded: >-\n  a\n  b\ndone: true\n")).toEqual([
      run("key", "folded"),
      run("operator", ":"),
      run("default", " "),
      run("operator", ">-"),
      run("default", "\n"),
      run("string", "  a\n  b\n"),
      run("key", "done"),
      run("operator", ":"),
      run("default", " "),
      run("boolean", "true"),
      run("default", "\n"),
    ]);
  });

  it("ends the body at the first dedented content line, keeping blanks inside", () => {
    const runs = tokenizeYaml("a: |\n  x\n\n  y\nz: 1\n");
    expect(runs).toEqual([
      run("key", "a"),
      run("operator", ":"),
      run("default", " "),
      run("operator", "|"),
      run("default", "\n"),
      run("string", "  x\n\n  y\n"),
      run("key", "z"),
      run("operator", ":"),
      run("default", " "),
      run("number", "1"),
      run("default", "\n"),
    ]);
  });

  it("a block with no deeper lines swallows nothing", () => {
    const runs = tokenizeYaml("key: |\nnotbody: 1\n");
    expect(runs.map((r) => r.text).join("")).toBe("key: |\nnotbody: 1\n");
    expect(significant(runs)).toEqual([
      run("key", "key"),
      run("operator", ":"),
      run("operator", "|"),
      run("key", "notbody"),
      run("operator", ":"),
      run("number", "1"),
    ]);
  });

  it("keeps a trailing comment on the header line a comment", () => {
    expect(significant(tokenizeYaml("k: | # keep me\n  body\n"))).toEqual([
      run("key", "k"),
      run("operator", ":"),
      run("operator", "|"),
      run("comment", "# keep me"),
      run("string", "  body\n"),
    ]);
  });
});

describe("tokenizeYaml losslessness", () => {
  const CORPUS: string[] = [
    "",
    "\n",
    "\n\n\n",
    "   \n \t\n",
    "just text",
    "unterminated 'quote",
    'unterminated "quote',
    "key: 'unclosed\nnext: 2",
    'key: "unclosed\nnext: 2',
    "key: |",
    "key: |\nnotbody",
    "key: |\n\nbody: 1",
    "key: |\n\ttab-indented body\n\tmore\nnext: 1",
    "key: >-\n  folded\n  text\nafter: 1",
    "key: |+2\n    deep",
    "a: 1\r\nb: 2\r\n",
    "\r\n",
    "lone\rbody",
    "url: http://x#frag",
    "key: # has hash",
    "#",
    "#\n#",
    "---\na: 1\n--- !ref\nb: 2\n...\n",
    "m: {a: 1, b: [1, 2]}\ns: [x, 'y', {z: w}]\nbad: [1, 2\ntail: ok",
    "kéy: 値\nrocket: 🚀 # emoji comment",
    "k: " + "v".repeat(50000),
    "----\n...",
    "||\n>-x\n&\n*\n!\n%YAML 1.2",
    ": :\n: v\n- - -\na:: b\n",
    "key\t:\tvalue",
    "\tdeep: tab indent",
    "a: >\n",
    "a: >",
    "-",
    "- \n",
    "{}[]",
    "key: [a] # c",
    'quote " then # hash and more',
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeYaml(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "key:",
      " - ",
      "value",
      "#c\n",
      "\n",
      " ",
      "  ",
      "\t",
      "|",
      ">-",
      "++",
      "---",
      "...",
      "'q'",
      '"d\\"r"',
      "[a, {b: c}]",
      "&anc",
      "*al",
      "!!map",
      "~",
      "true",
      "0x1F",
      "\r\n",
      "🚀",
      "http://a#b",
      ":",
      "-",
      "'",
      '"',
      "\\",
      "{",
      "}",
      "[",
      "]",
      "%",
      "@x",
      "\n\n",
      "  \n",
    ];
    let seed = 7;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeYaml(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("yaml tokenizer wiring (workflow_validate enablement)", () => {
  it("getTokenizer resolves yaml to tokenizeYaml and lights a workflow graph sample", () => {
    expect(getTokenizer("yaml")).toBe(tokenizeYaml);
    const wf = [
      "# demo workflow graph",
      "name: hello",
      "nodes:",
      "  - id: start",
      "    prompt: \"say hi\"",
      "  - id: finish",
      "    needs: [start] # join",
      "",
    ].join("\n");
    const runs = getTokenizer("yaml")!(wf);
    expect(runs.map((r) => r.text).join("")).toBe(wf); // the registry contract, held
    expect(runs.some((r) => r.type === "comment")).toBe(true);
    expect(runs.filter((r) => r.type === "key").map((r) => r.text)).toEqual([
      "name",
      "nodes",
      "id",
      "prompt",
      "id",
      "needs",
    ]);
  });
});
