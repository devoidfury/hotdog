// Fuzz suite for utils/html-to-markdown.ts (untrusted fetched HTML -> markdown).
//
// Value here is a cheap, permanent regression net: NEVER CRASH on tag soup, plus an
// output-hygiene invariant on every generated input.
//
// Carve-outs (stated, not papered over). This module is NOT an output sanitizer: it
// passes text through, strips tags keeping content, strips TERMINATED comments, decodes
// a fixed entity table, and Bun's parser re-emits error-recovery text. Shapes verified
// by probe that legitimately contain "<" / "</" in the output:
//   1. Entity-decoded text -- existing pin "decodes common HTML entities" EXPECTS "<"
//      from "&lt;", so "&lt;system&gt;..." decodes to a literal "<system>instructions".
//   2. Stray end tags re-emitted as text: "x</em>y" -> "x</em>y".
//   3. EOF-incomplete tags re-emitted: "<b" repeated at EOF survives verbatim.
//   4. Raw-text tokenizer modes: after <plaintext> (also <xmp>, <textarea>) the rest is
//      literal text, so even a raw "<script" survives.
//   5. Attribute values spliced into markdown: <a href="x</y"> -> "[t](x</y)".
//   6. Unterminated "<!--" runs and leftover "-->" survive as text; only TERMINATED
//      comments are stripped (existing pins).
// So the sharp invariant asserted instead is NO-FABRICATION:
//   a) the module never introduces a "<" unless the input contained "<", "&lt;", or a
//      DECIMAL character reference decoding to "<" (decodeEntities uses
//      String.fromCharCode, which wraps mod 2^16: "&#65596;" -> "<"; hex refs like
//      "&#x3c;" are NOT decoded and must NOT become "<");
//   b) every control character in the output (C0 except LF, plus DEL) appears raw in
//      the input or is decimal-ref-decodable from it -- the module's own insertions are
//      only "\n" and printable markdown;
//   c) turn-spoof shapes (literal "<system", "<tool") therefore appear ONLY through
//      those input-traceable paths, never fabricated. Escaping for downstream HTML is
//      md-parser's separately pinned job.
// Suppression contract (seeded clean docs): content of script/style/title/iframe/svg
// (case, attribute, newline, and EOF variants) never reaches the output. Comments are
// excluded from that alphabet because unterminated comments are themselves re-emitted
// text (covered by the crash net and the existing pins).
//
// Deterministic: fixed seeds, no Math.random/Date.now. Target: well under 1s.

import { describe, it, expect } from "bun:test";
import { htmlToMarkdown } from "@utils/html-to-markdown.ts";
import { makeRng, type Rng } from "../fuzz/prng.ts";

// ── No-fabrication hygiene oracle (independent of the module) ───────

const HEX4 = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

function hygieneViolations(input: string, output: string): string[] {
  const v: string[] = [];
  // Chars decodeEntities can mint from decimal refs, incl. fromCharCode's mod-2^16 wrap.
  const refs = new Set<string>();
  for (const m of input.matchAll(/&#(\d+);/g)) {
    refs.add(String.fromCharCode(parseInt(m[1]!, 10)));
  }
  const ltTraceable = input.includes("<") || input.includes("&lt;") || refs.has("<");
  if (!ltTraceable && output.includes("<")) v.push("fabricated '<'");
  let i = 0;
  while (i < output.length) {
    const cp = output.codePointAt(i)!;
    if ((cp < 0x20 && cp !== 0x0a) || cp === 0x7f) {
      const ch = String.fromCodePoint(cp);
      if (!input.includes(ch) && !refs.has(ch)) {
        v.push(`fabricated control ${HEX4(cp)}`);
      }
    }
    i += cp > 0xffff ? 2 : 1;
  }
  return v;
}

type Failure = { iter: number; input: string; problems: string[] };

function runHygiene(label: string, docs: string[], failures: Failure[]): void {
  for (let i = 0; i < docs.length; i++) {
    let out: string;
    try {
      out = htmlToMarkdown(docs[i]!);
    } catch (e) {
      failures.push({
        iter: i,
        input: JSON.stringify(docs[i]!.slice(0, 200)),
        problems: [`${label}: threw ${(e as Error).name}: ${(e as Error).message.slice(0, 120)}`],
      });
      continue;
    }
    const v = hygieneViolations(docs[i]!, out);
    if (v.length > 0) {
      failures.push({ iter: i, input: JSON.stringify(docs[i]!.slice(0, 200)), problems: v });
    }
  }
}

// ── Generators ───────────────────────────────────────────────────────

// Clean alphabet: NO '<', no '&lt;', no '&#...;' -- the hygiene oracle runs sharp on it.
const CLEAN_TOKENS = [
  "hello", "x", "a b", "done.", "'", '"', "`", "](", "[", ")", "(", "---", "```", "~~",
  "**", "|", ">",
  "\t", "\u000b", "\u000c", "\r", "\n", "\u001b[31m", "\u0001", "\u0002", "\u007f",
  "\u0000", "\ud800", "\udfff", "\u{1F600}", "\u0301", "\u202e", "\ufeff", "\u00a0",
  "&amp;", "&nbsp;", "&hellip;", "&LT;", "&xyz;", "&amp;lt;", "e\u0301", "\uff0e",
];
// Defensive: the sharp no-'<' premise depends on it; a token with '<' belongs in the soup.
const CLEAN_ALPHABET = CLEAN_TOKENS.filter((t) => !t.includes("<") && !t.includes("&#"));

function cleanDoc(rng: Rng): string {
  const n = 1 + rng.int(30);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = rng.pick(CLEAN_ALPHABET);
    parts.push(rng.bool(0.15) ? t.repeat(1 + rng.int(4)) : t);
  }
  return parts.join("");
}

const TAG_TOKENS = [
  "<tool", "</tool", "<unknownxyz>", "<b", "</b>", "<b>", "<script", "</script>", "<SCRIPT>",
  "<style", "</style>", "<div>", "</div>", "<p>", "<a href=\"x\"", "<a href=''>",
  "<img src=\"y.png\">", "<system>", "</system>", "<textarea>", "</textarea>",
  "<plaintext>", "<xmp>", "<svg>", "</svg>", "<iframe", "<title>", "</title>", "<pre>",
  "</pre>", "<code>", "<table>", "<tr>", "<td>", "</td>", "<br>", "<hr/>", "<!DOCTYPE html>",
  "<!--", "-->", "<!--x-->", "<!--<!-->", "<!-- -- >", "<!foo", "<?php", "</3>", "<>",
  "</>", "< a>", "<3", "<h1>", "<meta charset=\"utf-8\">",
];

const ATTR_PAYLOADS = [
  "x", "'", '"', "`", "</y>", "javascript:alert(1)", "a)b", "[", "data:image/png;base64,AA",
  "x\u0000y", "a b", "&lt;", "", "\ud800",
];

const TEXT_PAYLOADS = [
  "hello", "]", "(", "<", "</", "&lt;", "&#60;", "&#x3c;", "&#0;", "&#1;", "&#65596;",
  "\u0000", "\ud800", "\udc00x", "\u0001", "\u202e", "\t", "\r", "\n", "```", "**",
  "-->", "<!--", "x".repeat(20),
];

function soupDoc(rng: Rng): string {
  const n = 2 + rng.int(30);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const roll = rng.float();
    if (roll < 0.45) {
      parts.push(rng.pick(TAG_TOKENS));
    } else if (roll < 0.65) {
      parts.push(`<a href="${rng.pick(ATTR_PAYLOADS)}">`);
    } else if (roll < 0.8) {
      parts.push(`<img src="${rng.pick(ATTR_PAYLOADS)}" alt="${rng.pick(ATTR_PAYLOADS)}">`);
    } else {
      parts.push(rng.pick(TEXT_PAYLOADS));
    }
  }
  return parts.join("");
}

// ── 1. Crash net + hygiene on every generated input ─────────────────

describe("html-to-markdown fuzz: generated inputs", () => {
  it("300 clean-alphabet docs: no crash, sharp no-fabrication hygiene", () => {
    const rng = makeRng(0x6d64_3001);
    const docs = Array.from({ length: 300 }, () => cleanDoc(rng));
    const failures: Failure[] = [];
    runHygiene("clean", docs, failures);
    expect(failures).toEqual([]);
  });

  it("300 tag-soup docs: no crash, traceable hygiene", () => {
    const rng = makeRng(0x6d64_3002);
    const docs = Array.from({ length: 300 }, () => soupDoc(rng));
    const failures: Failure[] = [];
    runHygiene("soup", docs, failures);
    expect(failures).toEqual([]);
  });

  it("targeted nasty fixtures: no crash, traceable hygiene", () => {
    const fixtures = [
      "<tool", "</tool", "<tool", "</tool", "<script", "<style",
      "<script>alert(1)</script>&lt;script&gt;",
      "a<!--b--!>c-->d",
      "<!-- -->x-->",
      "<plaintext>ZZ<script>Q</script>",
      "<textarea><script>Q</script></textarea>",
      "<a href=\"x\u0000y\u202e\">t</a>",
      `<img src="${"y".repeat(100_000)}">`,
      "<!--" + "x".repeat(100_000) + "-->tail",
      "<fu\u0000n>bar</fun>",
      "</b>".repeat(5000) + "x",
      "<!".repeat(3000) + "x",
      "<?".repeat(3000) + "x",
      "&#65596;b&#65602;", // wrapped refs: '<b'
      "&#99999999999999;",
      "\u0001\u0002\u001f\u007f",
      "<a href=\"`\" onclick=\"x\">`'\"</a>",
    ];
    for (const input of fixtures) {
      let out: string;
      try {
        out = htmlToMarkdown(input);
      } catch (e) {
        expect(`${(e as Error).name}: ${(e as Error).message}`).toBe(`no throw for ${JSON.stringify(input.slice(0, 60))}`);
        continue;
      }
      expect(hygieneViolations(input, out)).toEqual([]);
    }
  });

  // Contract pin: the global "<"-traceability oracle is coarse -- a doc
  // that already contains "<" elsewhere masks any hex-decoding regression, and no
  // existing pin covers hex refs. Pin header claim (a) directly: only DECIMAL refs
  // decode; hex references stay literal and can never mint a "<".
  it("hex character refs are never decoded into '<'", () => {
    expect(htmlToMarkdown("&#x3c;system&#x3e;")).toBe("&#x3c;system&#x3e;");
    expect(htmlToMarkdown("a&#X3Cb")).toBe("a&#X3Cb");
  });
});

// ── 2. Deep nesting ──────────────────────────────────────────────────

describe("html-to-markdown fuzz: deep nesting", () => {
  it("20k-deep closed divs flatten to the inner text", () => {
    const html = "<div>".repeat(20_000) + "x" + "</div>".repeat(20_000);
    const out = htmlToMarkdown(html);
    expect(out).toContain("x");
    expect(out.includes("<")).toBe(false); // every tag stripped: nothing to trace back
  });

  it("10k unclosed <b and <em prefixes survive without crashing", () => {
    // EOF-incomplete tags are re-emitted as text (carve-out 3) -- crash net only.
    expect(htmlToMarkdown("<b".repeat(10_000) + "x").length).toBeGreaterThan(0);
    expect(htmlToMarkdown("<em".repeat(10_000) + "x").length).toBeGreaterThan(0);
  });

  it("5k unterminated comments and 2k nested script opens do not blow up", () => {
    expect(() => htmlToMarkdown("<!--".repeat(5000) + "x")).not.toThrow();
    expect(() => htmlToMarkdown("<script>x".repeat(2000))).not.toThrow();
    expect(() => htmlToMarkdown("<a href='".repeat(2000) + "x")).not.toThrow();
    expect(() => htmlToMarkdown("<blockquote>".repeat(5000) + "x")).not.toThrow();
  });
});

// ── 3. Suppression contract (clean docs, seeded) ────────────────────

describe("html-to-markdown fuzz: script/style/title/iframe/svg suppression", () => {
  const WRAPPERS: [string, string][] = [
    ["", ""],
    ["<div>", "</div>"],
    ["<p>", "</p>"],
    ["<pre>", "</pre>"],
    ["<table><tr><td>", "</td></tr></table>"],
    ["<html><body>", "</body></html>"],
  ];
  const ATTRS = [
    "", " type=\"text/javascript\"", " async", " id=a1 class='b2'", " media=screen",
    "\n data-x=1", " type='application/json'",
  ];
  const TAGS = ["script", "style", "title", "iframe", "svg"];

  function recase(rng: Rng, s: string): string {
    const mode = rng.int(3);
    if (mode === 0) return s;
    if (mode === 1) return s.toUpperCase();
    return s.split("").map((c) => (rng.bool() ? c.toUpperCase() : c)).join("");
  }

  it("150 seeded docs: element content never reaches the output", () => {
    const rng = makeRng(0x6d64_3003);
    const words = ["a", "10", "rgb", "text", "url", ";", ":", "{}", "()"];
    for (let i = 0; i < 150; i++) {
      const sentinels: string[] = [];
      const [openWrap, closeWrap] = rng.pick(WRAPPERS);
      let html = openWrap;
      const elems = 1 + rng.int(3);
      for (let e = 0; e < elems; e++) {
        const tag = recase(rng, rng.pick(TAGS));
        const sentinel = `ZZ${rng.next().toString(16)}${rng.next().toString(16)}`;
        sentinels.push(sentinel);
        let content = "";
        const cWords = 1 + rng.int(5);
        for (let w = 0; w < cWords; w++) content += rng.pick(words);
        content += sentinel;
        const close =
          rng.int(4) === 0 ? "" : rng.bool(0.8) ? `</${tag}>` : `</${tag}\n>`;
        html += `<${tag}${rng.pick(ATTRS)}>${content}${close}`;
      }
      html += closeWrap;
      const out = htmlToMarkdown(html);
      for (const s of sentinels) {
        if (out.includes(s)) {
          expect(`LEAKED ${s} in ${JSON.stringify(out.slice(0, 200))}`).toBe("no leak");
        }
      }
    }
  });
});
