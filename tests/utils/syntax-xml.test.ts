// Unit tests for the XML tokenizer (src/utils/syntax/xml.ts): the html
// markup scanner over the XML dialect -- typed runs with exact classes and
// spans over targeted fixtures (namespaced tag names, CDATA, processing
// instructions), pins for the documented html/xml cross-reading, a
// losslessness sweep over a nasty fixture corpus plus a deterministic
// fragment generator, and the registry wiring pins.

import { describe, it, expect } from "bun:test";
import { getTokenizer } from "@utils/syntax/index.ts";
import { tokenizeXml } from "@utils/syntax/xml.ts";
import { tokenizeHtml } from "@utils/syntax/html.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

/** The tokenizer's declared class vocabulary (rides the html set). */
const TYPES = new Set(["name", "attribute", "string", "comment", "entity", "doctype", "operator", "default"]);

/** Drop the whitespace/text passthrough to assert the interesting runs. */
const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeXml markup", () => {
  it("classifies a document prolog and a namespaced element", () => {
    expect(significant(tokenizeXml('<?xml version="1.0"?>\n<soap:Envelope a="1">hi</soap:Envelope>'))).toEqual([
      run("doctype", '<?xml version="1.0"?>'), // PIs ride the doctype family
      run("operator", "<"),
      run("name", "soap:Envelope"), // the xml name charset: colons included
      run("attribute", "a"),
      run("operator", "="),
      run("string", '"1"'),
      run("operator", ">"),
      run("default", "hi"),
      run("operator", "</"),
      run("name", "soap:Envelope"),
      run("operator", ">"),
    ]);
  });

  it("digit and dash name parts read fully (html leaves them behind)", () => {
    expect(significant(tokenizeXml("<h1>text</h1>"))).toEqual([
      run("operator", "<"),
      run("name", "h1"),
      run("operator", ">"),
      run("default", "text"),
      run("operator", "</"),
      run("name", "h1"),
      run("operator", ">"),
    ]);
    // html's narrower charset keeps h1 split (its documented shape):
    expect(significant(tokenizeHtml("<h1>x</h1>"))).toContainEqual(run("name", "h"));
  });

  it("CDATA is one string run through the closer or end of input", () => {
    expect(tokenizeXml("a<![CDATA[ raw <x> ]]>b")).toEqual([
      run("default", "a"),
      run("string", "<![CDATA[ raw <x> ]]>"),
      run("default", "b"),
    ]);
    expect(tokenizeXml("<![CDATA[ unterm")).toEqual([run("string", "<![CDATA[ unterm")]);
    // html has no CDATA branch: the same bytes ride default decl junk there.
    expect(tokenizeHtml("<![CDATA[ raw ]]>")).toEqual([run("default", "<![CDATA[ raw ]]>")]);
  });

  it("doctype, comments and entities read as in html", () => {
    expect(significant(tokenizeXml('<!DOCTYPE note SYSTEM "n.dtd"><!-- c -->&amp;&nbsp;text'))).toEqual([
      run("doctype", '<!DOCTYPE note SYSTEM "n.dtd">'),
      run("comment", "<!-- c -->"),
      run("entity", "&amp;"),
      run("entity", "&nbsp;"),
      run("default", "text"),
    ]);
  });

  it("a stray < stays text", () => {
    expect(tokenizeXml("5 < 6")).toEqual([run("default", "5 "), run("default", "<"), run("default", " 6")]);
  });
});

describe("tokenizeXml dialect deltas pinned (the documented tolerances)", () => {
  it("bare attribute values still scan (xml requires quotes; we stay tolerant)", () => {
    expect(significant(tokenizeXml("<a href=x>"))).toEqual([
      run("operator", "<"),
      run("name", "a"),
      run("attribute", "href"),
      run("operator", "="),
      run("string", "x"),
      run("operator", ">"),
    ]);
  });

  it("the doctype test stays case-insensitive across both dialects", () => {
    expect(tokenizeXml("<!doctype html>")).toEqual([run("doctype", "<!doctype html>")]);
  });

  it("a PI cuts at the first > (not ?>)", () => {
    expect(tokenizeXml("<?php if ($a > $b) {} ?>")).toEqual([run("doctype", "<?php if ($a >"), run("default", " $b) {} ?>")]);
  });
});

describe("tokenizeXml line-wise (the file view tokenizes per line)", () => {
  it("unterminated markup runs to end of input, never garbles", () => {
    expect(significant(tokenizeXml("<div class=x"))).toEqual([
      run("operator", "<"),
      run("name", "div"),
      run("attribute", "class"),
      run("operator", "="),
      run("string", "x"),
    ]);
    expect(tokenizeXml("<!-- open")).toEqual([run("comment", "<!-- open")]);
    expect(tokenizeXml("<?xml")).toEqual([run("doctype", "<?xml")]);
  });
});

describe("tokenizeXml losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "x".repeat(50000),
    "<",
    ">",
    "<>",
    "</>",
    "<![CDATA[",
    "<![CDATA[]]]]",
    "<![CDATA[]>",
    "]]>",
    "]]>",
    "<?",
    "?>",
    "<!-->",
    "<!-- -- -->",
    "<a:",
    "<a:b/>",
    "<a:b c:d='e'>",
    "<a b=\"c",
    "<a b='c>",
    "&amp;&;&#;&amp",
    "&#;",
    "text\r\n<a/>\r\n",
    "🚀 <h1>ünï</h1>",
    "<soap:Envelope>\n<soap:Body/>",
    "x" + ":".repeat(300),
    "<" + "a:".repeat(300),
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeXml(input);
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
      "<a/>",
      "<a",
      "</a>",
      "<!--",
      "-->",
      "<!",
      "<![CDATA[",
      "]]>",
      "<?",
      "?>",
      "<?xml?>",
      'href="x"',
      "=",
      "'",
      '"',
      " ",
      "\n",
      "\t",
      "text",
      "&amp;",
      "&",
      ";",
      "ns:name",
      ":",
      "/",
      "\\",
      "🚀",
      "\r\n",
      "\n\n",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeXml(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("xml tokenizer wiring", () => {
  it("getTokenizer resolves xml to tokenizeXml and colors a pom-style sample", () => {
    expect(getTokenizer("xml")).toBe(tokenizeXml);
    const doc = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<project name="demo">',
      "  <!-- modules -->",
      "  <desc>&amp; more</desc>",
      "  <raw><![CDATA[ a < b ]]></raw>",
      "</project>",
    ].join("\n");
    const runs = getTokenizer("xml")!(doc);
    expect(runs.map((r) => r.text).join("")).toBe(doc); // the registry contract, held
    expect(runs.filter((r) => r.type === "doctype").map((r) => r.text)).toEqual([
      '<?xml version="1.0" encoding="UTF-8"?>',
    ]);
    expect(runs.filter((r) => r.type === "name").map((r) => r.text)).toEqual([
      "project",
      "desc",
      "desc",
      "raw",
      "raw",
      "project",
    ]);
    expect(significant(runs)).toContainEqual(run("comment", "<!-- modules -->"));
    expect(significant(runs)).toContainEqual(run("entity", "&amp;"));
    expect(significant(runs)).toContainEqual(run("string", "<![CDATA[ a < b ]]>"));
  });
});
