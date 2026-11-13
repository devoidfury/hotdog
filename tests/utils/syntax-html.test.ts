// Unit tests for the HTML tokenizer (src/utils/syntax/html.ts): typed runs
// with exact classes and spans over targeted fixtures, prose/entity
// handling, unterminated-markup behavior for the file view, a losslessness
// sweep over a nasty fixture corpus plus a deterministic fragment
// generator, and the registry wiring pin.

import { describe, it, expect } from "bun:test";
import { getTokenizer, type SyntaxRun } from "@utils/syntax/index.ts";
import { tokenizeHtml } from "@utils/syntax/html.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

/** The tokenizer's declared class vocabulary (every run must live here). */
const TYPES = new Set(["name", "attribute", "string", "comment", "entity", "doctype", "operator", "default"]);

/** Drop the whitespace/text passthrough to assert the interesting runs. */
const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeHtml tags", () => {
  it("classifies a full open/close pair", () => {
    expect(significant(tokenizeHtml('<div class="wrap">hi</div>'))).toEqual([
      run("operator", "<"),
      run("name", "div"),
      run("attribute", "class"),
      run("operator", "="),
      run("string", '"wrap"'),
      run("operator", ">"),
      run("default", "hi"),
      run("operator", "</"),
      run("name", "div"),
      run("operator", ">"),
    ]);
  });

  it("reads self-closing, boolean and bare-value attributes", () => {
    expect(significant(tokenizeHtml('<img src=x.png alt hidden/>'))).toEqual([
      run("operator", "<"),
      run("name", "img"),
      run("attribute", "src"),
      run("operator", "="),
      run("string", "x.png"),
      run("attribute", "alt"),
      run("attribute", "hidden"),
      run("operator", "/"),
      run("operator", ">"),
    ]);
  });

  it("keeps quotes and > inside quoted attribute values", () => {
    expect(significant(tokenizeHtml('<a title="a > b &quot; x" href=y>z</a>'))).toContainEqual(
      run("string", '"a > b &quot; x"'),
    );
  });

  it("keeps tag markup inert inside comments", () => {
    expect(tokenizeHtml("<!-- <div> nope -->")).toEqual([run("comment", "<!-- <div> nope -->")]);
  });

  it("classifies the doctype whole, any case", () => {
    expect(tokenizeHtml("<!DOCTYPE html>")).toEqual([run("doctype", "<!DOCTYPE html>")]);
    expect(tokenizeHtml("<!doctype HTML>")).toEqual([run("doctype", "<!doctype HTML>")]);
  });

  it("splits entities out of prose, numeric forms included", () => {
    const runs = tokenizeHtml("a &amp; b &#65; &#x41; &nope notile");
    expect(runs.filter((r) => r.type === "entity").map((r) => r.text)).toEqual(["&amp;", "&#65;", "&#x41;"]);
    expect(runs.map((r) => r.text).join("")).toBe("a &amp; b &#65; &#x41; &nope notile");
  });
});

describe("tokenizeHtml stray markup", () => {
  it("keeps a lone < as prose", () => {
    expect(tokenizeHtml("5 < 6")).toEqual([run("default", "5 "), run("default", "<"), run("default", " 6")]);
    expect(tokenizeHtml("<3")).toEqual([run("default", "<"), run("default", "3")]);
  });

  it("runs an unterminated tag to the end of input", () => {
    expect(significant(tokenizeHtml("<div class=x"))).toEqual([
      run("operator", "<"),
      run("name", "div"),
      run("attribute", "class"),
      run("operator", "="),
      run("string", "x"),
    ]);
  });

  it("runs an unterminated comment to the end of input", () => {
    expect(tokenizeHtml("<!-- forever")).toEqual([run("comment", "<!-- forever")]);
  });

  it("treats other <! and <? declarations as plain text to the closer", () => {
    expect(tokenizeHtml("<![CDATA[ raw ]]>")).toEqual([run("default", "<![CDATA[ raw ]]>")]);
    expect(tokenizeHtml("<?xml version='1.0'?>")).toEqual([run("default", "<?xml version='1.0'?>")]);
  });
});

describe("tokenizeHtml line-wise (the file view tokenizes per line)", () => {
  it("degrades gracefully when a tag or comment spans lines", () => {
    expect(significant(tokenizeHtml("<div"))).toEqual([
      run("operator", "<"),
      run("name", "div"),
    ]);
    expect(significant(tokenizeHtml("<!-- open"))).toEqual([run("comment", "<!-- open")]);
    // An attribute-continuation line carries no `<`; it honestly reads as
    // prose (a sink's line-wise render shows it unstyled, never garbled).
    expect(tokenizeHtml("attr=1 >")).toEqual([run("default", "attr=1 >")]);
  });
});

describe("tokenizeHtml losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "<",
    ">",
    "<>",
    "</>",
    "<<>>",
    "<!-->",
    "<!--->",
    "<!-- -- -->",
    "<!>",
    "<!DOCTYPE>",
    "<!doctype",
    "<?",
    "</3",
    "<a>",
    "<a >",
    '<a b="c',
    "<a b='c>",
    "<a b=c>",
    "<a b=>",
    "<a =>",
    '<a b="x"="y">',
    "&amp;&;&#;&amp",
    "&#;",
    "<div\nclass=x>",
    "text\r\n<div>\r\n",
    "🚀 <h1>ünï</h1>",
    "x".repeat(50000),
    "<script>if (a<b && c>d) {}</script>",
    "<br/><hr />",
    "</div></div>>>",
    'a<b c="/" d="\\">',
    "<" + "a".repeat(300),
    "\u0000\u001b",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeHtml(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "<",
      ">",
      "</",
      "/>",
      "<div>",
      "<a",
      "/div>",
      "<!--",
      "-->",
      "<!",
      "<!DOCTYPE html>",
      "<?",
      'href="x"',
      "=",
      "'",
      '"',
      " ",
      "\n",
      "\t",
      "text",
      "&amp;",
      "&#65;",
      "&",
      ";",
      "class",
      "/",
      "\\",
      "🚀",
      "\r\n",
      "\n\n",
    ];
    let seed = 23;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeHtml(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("html tokenizer wiring", () => {
  it("getTokenizer resolves html to tokenizeHtml and colors a page sample", () => {
    expect(getTokenizer("html")).toBe(tokenizeHtml);
    const page = [
      "<!DOCTYPE html>",
      '<html lang="en">',
      "  <body><!-- nav -->",
      "    <a href='/'>Home &amp; more</a>",
      "  </body>",
      "</html>",
    ].join("\n");
    const runs = getTokenizer("html")!(page);
    expect(runs.map((r) => r.text).join("")).toBe(page); // the registry contract, held
    expect(runs.filter((r) => r.type === "name").map((r) => r.text)).toEqual([
      "html",
      "body",
      "a",
      "a",
      "body",
      "html",
    ]);
    expect(significant(runs)).toContainEqual(run("comment", "<!-- nav -->"));
    expect(significant(runs)).toContainEqual(run("entity", "&amp;"));
  });
});
