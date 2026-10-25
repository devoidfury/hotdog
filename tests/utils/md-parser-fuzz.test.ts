import { describe, it, expect } from "bun:test";
import {
  mdTreeToHtml,
  markdownToHtml,
  createStreamingParser,
} from "@utils/md-parser.ts";

// Fuzz suite for the markdown renderer (untrusted input: model output, fetched pages).
// The security-critical invariants are audited on EVERY generated document, not just fixtures:
//   1. parse+render never throws (recursion is depth-capped in md-parser)
//   2. the output contains no tag outside the allowlist, with no unexpected attributes
//      and no event handlers
//   3. no stray `<` or `>` survives outside allowlisted tags (escapeHtml has no gaps)
//   4. href/src values, decoded once the way a browser decodes an attribute, pass the
//      scheme policy (http/https/mailto links; http/https + raster data: images)
//   5. chunked streaming parse finalizes to the same HTML as a direct parse

// ── HTML audit ──────────────────────────────────────────────────────

const ALLOWED_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "pre", "code",
  "strong", "em", "del", "a", "img", "ul", "ol", "li",
  "blockquote", "hr", "table", "thead", "tbody", "tr", "th", "td",
]);

const VOID_TAGS = new Set(["img", "hr"]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel"]),
  img: new Set(["src", "alt"]),
  pre: new Set(["class"]),
  code: new Set(["class"]),
  ol: new Set(["start"]),
  table: new Set(["class"]),
};

// Decode exactly one pass, in browser order: `&amp;#106;` must come out as the literal
// text `&#106;`, never re-decoded into a colon. Double-decoding would flag safe output;
// under-decoding would miss an attack.
function decodeEntitiesOnce(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

// Scheme policy stated independently of md-parser's isSafeUrl (test pins intent, not code).
// Browsers ignore C0 controls and whitespace when parsing URLs, so strip them everywhere
// (stricter than browsers: they only strip \t\n\r anywhere -- a superset check).
function schemeViolation(value: string, kind: "href" | "src"): string | null {
  const stripped = decodeEntitiesOnce(value).replace(/[\x00-\x20]/g, "");
  const m = stripped.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!m) return null; // relative or protocol-relative: allowed
  const scheme = m[1]!.toLowerCase();
  if (kind === "href" && (scheme === "http" || scheme === "https" || scheme === "mailto")) return null;
  if (kind === "src" && (scheme === "http" || scheme === "https")) return null;
  // data: images only for script-less rasters on <img>
  if (kind === "src" && scheme === "data" && /^data:image\/(png|jpe?g|gif|webp)(;|$)/i.test(stripped)) return null;
  return `disallowed ${kind} scheme "${scheme}:"`;
}

function auditTag(tag: string): string[] {
  const violations: string[] = [];
  const m = tag.match(/^<(\/?)([a-z0-9]+)((?:\s[^>]*?)?)\/?>$/);
  if (!m) {
    violations.push(`malformed/unexpected tag: ${tag}`);
    return violations;
  }
  const [, slash, name, rawAttrs] = m;
  if (!ALLOWED_TAGS.has(name!)) {
    violations.push(`tag not in allowlist: ${tag}`);
    return violations;
  }
  if (slash && VOID_TAGS.has(name!)) violations.push(`closing tag for void element: ${tag}`);

  const attrs = (rawAttrs ?? "").replace(/\/$/, "").trimEnd();
  if (attrs !== "") {
    // Walk attribute slots sequentially: name slots are only ever at the front
    // of each slot, never inside a quoted value (values may hold words+spaces).
    let rest = attrs;
    let malformed = false;
    while (rest.length > 0) {
      const am = rest.match(/^\s+([a-z]+)(?:="[^"]*")?/);
      if (!am) {
        malformed = true;
        break;
      }
      const attrName = am[1]!;
      const valueMatch = am[0]!.match(/="([^"]*)"$/);
      const value = valueMatch ? valueMatch[1]! : null;
      if (/^on[a-z0-9]*$/i.test(attrName)) {
        violations.push(`event-handler attribute "${attrName}" in: ${tag}`);
      }
      const allowed = ALLOWED_ATTRS[name!] ?? new Set<string>();
      if (!allowed.has(attrName)) {
        violations.push(`attribute "${attrName}" not allowed on <${name}>: ${tag}`);
      }
      if (value !== null) {
        if (name === "a" && attrName === "href") {
          const v = schemeViolation(value, "href");
          if (v) violations.push(`${v} in: ${tag}`);
        }
        if (name === "img" && attrName === "src") {
          const v = schemeViolation(value, "src");
          if (v) violations.push(`${v} in: ${tag}`);
        }
      }
      rest = rest.slice(am[0]!.length);
    }
    if (malformed) violations.push(`attribute junk in: ${tag}`);
  }
  return violations;
}

function auditHtml(html: string): string[] {
  const violations: string[] = [];
  for (const tag of html.match(/<[^>]*>/g) ?? []) {
    violations.push(...auditTag(tag));
  }
  const text = html.replace(/<[^>]*>/g, "");
  if (text.includes("<")) violations.push("stray '<' outside allowlisted tags");
  if (text.includes(">")) violations.push("stray '>' outside allowlisted tags");
  return violations;
}

// ── Seeded generator ────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

const STRUCTURAL = [
  "```", "```js", "#", "## x", "> ", ">-", "- ", "* ", "1. ", "1) ",
  "|", "|---|", "| a | b |", "**", "__", "*", "_", "~~", "***",
  "[", "]", "(", ")", "![", "[x](", "](", "![y](", "\\", "\\[", "\\!",
  "\n", " ", " ", "\t", "x", "hello", "a.b", ":", "&", "<", ">", "\"", "'",
  "~~~", "    ", "> > ", "12345678901234567890. ",
] as const;

// Payload pieces aimed at the escape, scheme, and attribute layers.
const PAYLOADS = [
  "<script>alert(1)</script>", "</a>", "<a href=", "<svg/onload=alert(1)>",
  "<img src=x onerror=alert(1)>", "</textarea><script>", "<!--c-->", "<?php echo 1; ?>",
  "javascript:alert(1)", "JaVaScRiPt:location=1", "java\tscript:location=1",
  "java\nscript:location=1", "\x01javascript:location=1", "\x00javascript:location=1",
  "vbscript:msgbox", "file:///etc/passwd", "FILE:///c:/windows/win.ini",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "data:image/svg+xml,<svg onload=1>", "data:image/png;base64,iVBORw0KGgo=",
  "http://ok.example/a?x=1", "https://ok.example/#frag", "mailto:hi@example.com",
  "//evil.example/x", "#anchor", "?q=1",
  `x"onmouseover="alert(1)`, "y'onerror='alert(1)", "z autofocus href=x",
  "&colon;location=1", "&#106;avascript:location=1", "&#x6a;avascript:location=1",
  "javascript&#58;location=1", "ｊａｖａscript:location=1", "\u{1d4b3}avascript:location=1",
  "%6a%61vascript:location=1", "  javascript:location=1",
  "\u202eabc", "\u200b", "\ufeff", "\u001b[31m", "\ud800", "\udfff",
] as const;

const URL_TOKENS = [
  "http://ok.example/a", "https://ok.example/b", "mailto:a@b.c", "//p.example/x",
  "#frag", "/rel/path", "javascript:alert(1)", "JaVa\tScRiPt:alert(1)",
  "\x01javascript:alert(1)", "data:text/html,<script>1</script>",
  "data:image/svg+xml,<svg/>", "data:image/png;base64,AAA", "vbscript:x",
  "file:///etc/passwd", `http://ok.example/"onmouseover="x`, "&#106;avascript:alert(1)",
] as const;

function genDoc(rng: () => number): string {
  const lineCount = 1 + Math.floor(rng() * 10);
  const lines: string[] = [];
  for (let l = 0; l < lineCount; l++) {
    const parts: string[] = [];
    const tokenCount = 1 + Math.floor(rng() * 6);
    for (let t = 0; t < tokenCount; t++) {
      const roll = rng();
      if (roll < 0.45) {
        parts.push(pick(rng, STRUCTURAL));
      } else if (roll < 0.8) {
        parts.push(pick(rng, PAYLOADS));
      } else if (roll < 0.9) {
        // link/image wrappers put payloads into url and label positions
        const label = pick(rng, PAYLOADS);
        const url = pick(rng, URL_TOKENS);
        parts.push(rng() < 0.5 ? `[${label}](${url})` : `![${label}](${url})`);
      } else {
        // runs of raw structural chars: nesting and scan-window stress
        parts.push(pick(rng, ["[", "]", "(", ")", "*", "_", ">", "#", "`", "|"]).repeat(2 + Math.floor(rng() * 8)));
      }
    }
    lines.push(parts.join(""));
  }
  return lines.join("\n");
}

// ── Randomized fuzz ─────────────────────────────────────────────────

describe("md-parser fuzz", () => {
  // Deterministic by default; for deep sweeps run:
  //   HOTDOG_MD_FUZZ_SEED=$RANDOM HOTDOG_MD_FUZZ_ITERS=25000 bun test tests/utils/md-parser-fuzz.test.ts
  const SEED = Number(process.env.HOTDOG_MD_FUZZ_SEED ?? 0x686f7464); // "hotd"
  const ITERS = Number(process.env.HOTDOG_MD_FUZZ_ITERS ?? 1500);

  it("generated documents render without throwing, only audited output", () => {
    const rng = mulberry32(SEED);
    const ITERATIONS = ITERS;
    const failures: { iter: number; input: string; problems: string[] }[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const doc = genDoc(rng);
      try {
        const html = markdownToHtml(doc);
        const violations = auditHtml(html);
        if (violations.length > 0) {
          failures.push({ iter: i, input: doc, problems: violations.slice(0, 5) });
        }
      } catch (e) {
        failures.push({
          iter: i,
          input: doc,
          problems: [`${(e as Error).constructor.name}: ${(e as Error).message}`],
        });
      }
      if (failures.length >= 3) break;
    }

    // JSON.stringify keeps control chars visible for reproduction.
    expect(failures).toEqual([]);
  });

  it("streamed chunked parse finalizes identical to a direct parse", () => {
    const rng = mulberry32(0x64676f68); // "gdoh"
    const ITERATIONS = 400;
    const mismatches: { iter: number; input: string }[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const doc = genDoc(rng);
      const parser = createStreamingParser();
      let pos = 0;
      while (pos < doc.length) {
        const size = 1 + Math.floor(rng() * 40);
        parser.feed(doc.slice(pos, pos + size));
        pos += size;
      }
      const streamed = mdTreeToHtml(parser.finalize());
      if (streamed !== markdownToHtml(doc)) {
        mismatches.push({ iter: i, input: doc });
      }
      if (mismatches.length >= 3) break;
    }

    expect(mismatches).toEqual([]);
  });
});

// ── Deep-nesting regressions (stack-overflow probes) ────────────────
// Pre-cap, a 20k-deep `[](u)` chain and a 20k `>` prefix line RangeError'd mid-render.
// The cap must hold with headroom and the innermost text must still survive as text.

describe("md-parser nesting caps", () => {
  it("deep nested links render instead of overflowing the stack", () => {
    let deep = "x";
    for (let i = 0; i < 20000; i++) deep = `[${deep}](u)`;
    const html = markdownToHtml(deep);
    const anchors = (html.match(/<a /g) ?? []).length;
    expect(anchors).toBeLessThanOrEqual(200); // capped at 100; slack for future tuning
    expect(html).toContain("x");
    expect(auditHtml(html)).toEqual([]);
  });

  it("a deep '>' prefix line renders instead of overflowing the stack", () => {
    const html = markdownToHtml(">".repeat(20000) + "x");
    const quotes = (html.match(/<blockquote>/g) ?? []).length;
    expect(quotes).toBeLessThanOrEqual(200);
    expect(html).toContain("&gt;x"); // overflow nesting survives as literal text
    expect(auditHtml(html)).toEqual([]);
  });

  it("deep emphasis runs render", () => {
    const n = 20000;
    const html = markdownToHtml("**".repeat(n) + "x" + "**".repeat(n));
    expect(auditHtml(html)).toEqual([]);
  });
});

// ── Quadratic-scan regressions ──────────────────────────────────────
// Runs of unmatched `[` / `![` / `](` used to trigger per-position forward scans:
// 100KB of `[` took ~8s, `![` ~10s (a fetched page could wedge the webui renderer).
// buildInlineScanIndex made parsing linear. Budget is ~50x the measured cost on dev
// hardware -- generous enough to survive slow CI, tight enough to catch the quadratic
// behavior returning (it would blow past it by two orders of magnitude).

describe("md-parser scan performance", () => {
  const BUDGET_MS = 2000;

  const pathological: [string, () => string][] = [
    ["unmatched brackets", () => "[".repeat(100000)],
    ["bang-brackets", () => "![".repeat(50000)],
    ["links with no closing paren", () => "[a](".repeat(25000)],
    ["mixed unmatched", () => "[] ]( [[ ![".repeat(20000)],
  ];

  for (const [label, make] of pathological) {
    it(`renders 100KB of ${label} linearly`, () => {
      const input = make();
      const t0 = performance.now();
      markdownToHtml(input);
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }
});

// ── Targeted fixtures for the scheme/escape layer ───────────────────

describe("md-parser XSS fixtures", () => {
  const audited = (md: string): string => {
    const html = markdownToHtml(md);
    const violations = auditHtml(html);
    expect(violations).toEqual([]);
    return html;
  };

  it("javascript: links render as plain text, no anchor", () => {
    const html = audited("[click](javascript:location=1)");
    expect(html).not.toContain("<a");
    expect(html).toContain("click");
  });

  it("case-mangled and control-char-mangled javascript: variants are blocked", () => {
    for (const url of [
      "JaVaScRiPt:location=1",
      "java\tscript:location=1",
      "java\nscript:location=1",
      "\x01javascript:location=1",
      "\x00javascript:location=1",
      "vbscript:msgbox",
      "FILE:///etc/passwd",
    ]) {
      const html = audited(`[x](${url})`);
      expect(html).not.toContain("<a");
    }
  });

  it("script-bearing data: URLs are blocked, raster data: images allowed", () => {
    expect(audited("![x](data:text/html;base64,PHNjcmlwdD4=)")).not.toContain("<img");
    expect(audited("![x](data:image/svg+xml,<svg/onload=1>)")).not.toContain("<img");
    expect(audited("![x](data:image/png;base64,iVBORw0KGgo=)")).toContain("<img");
  });

  it("safe schemes and relative URLs pass through", () => {
    expect(audited("[a](http://ok.example/x)")).toContain("<a href=");
    expect(audited("[b](mailto:hi@example.com)")).toContain("<a href=");
    const rel = audited("[d](/rel/path)");
    expect(rel).toContain("<a href=");
  });

  it("raw HTML is escaped in text, headings, code blocks, and tables", () => {
    const evil = "<script>alert(1)</script>";
    expect(audited(evil)).toContain("&lt;script&gt;");
    expect(audited(`# ${evil}`)).not.toContain("<script");
    expect(audited("```\n" + evil + "\n```")).not.toContain("<script");
    expect(audited(`| a |\n|---|\n| ${evil} |`)).not.toContain("<script");
    expect(audited(`> ${evil}`)).not.toContain("<script");
    expect(audited(`- ${evil}`)).not.toContain("<script");
  });

  it("quote-breaking attempts in urls and labels stay inert", () => {
    expect(audited(`[x]("onmouseover="alert(1) href="y)]`)).not.toMatch(/onmouseover="/i);
    expect(audited('[y](http://ok.example/"><script>alert(1)</script>)')).not.toContain("<script");
    // `&#106;avascript:` is a relative path (single-decoded), never a scheme
    const html = audited("[z](&#106;avascript:location=1)");
    expect(html).toContain("&amp;#106;avascript:");
  });

  it("spoof code points in urls become visible tokens, never raw bytes", () => {
    const html = audited("[x](http://exa\u200bmple.com/\u202e)");
    expect(html).toContain("[U+200B]");
    expect(html).toContain("[U+202E]");
    expect(html).not.toContain("\u200b");
  });
});
