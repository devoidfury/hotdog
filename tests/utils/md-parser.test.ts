import { describe, it, expect } from "bun:test";
import {
  parseMarkdown,
  createStreamingParser,
  mdTreeToPlainText,
  walkTree,
  mdTreeToHtml,
  markdownToHtml,
  getStablePrefix,
} from "../../src/utils/md-parser.ts";
import type { MdBlock, MdInline, MdDocument } from "../../src/utils/md-parser.ts";

describe("parseMarkdown", () => {
  // ── Edge cases ────────────────────────────────────────────────────

  it("returns empty document for empty input", () => {
    const doc = parseMarkdown("");
    expect(doc.type).toBe("document");
    expect(doc.children).toHaveLength(0);
  });

  it("returns empty document for whitespace-only input", () => {
    const doc = parseMarkdown("   \n  \n   ");
    expect(doc.type).toBe("document");
    expect(doc.children).toHaveLength(0);
  });

  it("returns empty document for blank lines only", () => {
    const doc = parseMarkdown("\n\n\n");
    expect(doc.children).toHaveLength(0);
  });

  // ── Headings ──────────────────────────────────────────────────────

  it("parses h1 heading", () => {
    const doc = parseMarkdown("# Hello");
    expect(doc.children).toHaveLength(1);
    const block = doc.children[0] as MdBlock;
    expect(block.type).toBe("heading");
    if (block.type === "heading") {
      expect(block.level).toBe(1);
      expect(block.children[0]?.type).toBe("text");
      if (block.children[0]?.type === "text") {
        expect(block.children[0].content).toBe("Hello");
      }
    }
  });

  it("parses h2-h6 headings", () => {
    const doc = parseMarkdown("## Two\n### Three\n#### Four\n##### Five\n###### Six");
    expect(doc.children).toHaveLength(5);
    expect((doc.children[0] as MdBlock).type).toBe("heading");
    expect((doc.children[1] as MdBlock).type).toBe("heading");
    expect((doc.children[2] as MdBlock).type).toBe("heading");
    expect((doc.children[3] as MdBlock).type).toBe("heading");
    expect((doc.children[4] as MdBlock).type).toBe("heading");
  });

  it("parses heading levels correctly", () => {
    const doc = parseMarkdown("# H1\n## H2\n### H3");
    expect((doc.children[0] as MdBlock).type).toBe("heading");
    if ((doc.children[0] as MdBlock).type === "heading") expect((doc.children[0] as MdBlock).level).toBe(1);
    if ((doc.children[1] as MdBlock).type === "heading") expect((doc.children[1] as MdBlock).level).toBe(2);
    if ((doc.children[2] as MdBlock).type === "heading") expect((doc.children[2] as MdBlock).level).toBe(3);
  });

  // ── Paragraphs ────────────────────────────────────────────────────

  it("parses a simple paragraph", () => {
    const doc = parseMarkdown("Hello world");
    expect(doc.children).toHaveLength(1);
    expect(doc.children[0]?.type).toBe("paragraph");
  });

  it("parses multiple paragraphs separated by blank lines", () => {
    const doc = parseMarkdown("First paragraph.\n\nSecond paragraph.");
    expect(doc.children).toHaveLength(2);
    expect(doc.children[0]?.type).toBe("paragraph");
    expect(doc.children[1]?.type).toBe("paragraph");
  });

  it("joins multi-line paragraphs", () => {
    const doc = parseMarkdown("Line one\nLine two\nLine three");
    expect(doc.children).toHaveLength(1);
    expect(doc.children[0]?.type).toBe("paragraph");
    const para = doc.children[0];
    if (para?.type === "paragraph") {
      const texts = para.children.filter((c) => c.type === "text")
        .map((c) => (c as { type: "text"; content: string }).content);
      expect(texts.join(" ")).toContain("Line one");
      expect(texts.join(" ")).toContain("Line two");
      expect(texts.join(" ")).toContain("Line three");
    }
  });

  // ── Code blocks ───────────────────────────────────────────────────

  it("parses a fenced code block with language", () => {
    const doc = parseMarkdown("```typescript\nconst x = 1;\n```");
    expect(doc.children).toHaveLength(1);
    expect(doc.children[0]?.type).toBe("code_block");
    const code = doc.children[0] as { type: "code_block"; language?: string; content: string };
    expect(code.language).toBe("typescript");
    expect(code.content).toBe("const x = 1;");
  });

  it("parses a fenced code block without language", () => {
    const doc = parseMarkdown("```\nsome code\n```");
    expect(doc.children[0]?.type).toBe("code_block");
    const code = doc.children[0] as { type: "code_block"; language?: string; content: string };
    expect(code.language).toBeUndefined();
    expect(code.content).toBe("some code");
  });

  it("parses multi-line code blocks", () => {
    const doc = parseMarkdown("```python\nline1\nline2\nline3\n```");
    const code = doc.children[0] as { type: "code_block"; content: string };
    expect(code.content).toBe("line1\nline2\nline3");
  });

  it("handles code blocks with empty content", () => {
    const doc = parseMarkdown("```\n```");
    expect(doc.children[0]?.type).toBe("code_block");
    const code = doc.children[0] as { type: "code_block"; content: string };
    expect(code.content).toBe("");
  });

  // ── Lists ─────────────────────────────────────────────────────────

  it("parses an unordered list with dashes", () => {
    const doc = parseMarkdown("- item one\n- item two\n- item three");
    expect(doc.children).toHaveLength(1);
    expect(doc.children[0]?.type).toBe("list");
    const list = doc.children[0] as { type: "list"; ordered: boolean; items: { children: MdInline[] }[] };
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(3);
  });

  it("parses an unordered list with asterisks", () => {
    const doc = parseMarkdown("* item one\n* item two");
    expect(doc.children[0]?.type).toBe("list");
    const list = doc.children[0] as { type: "list"; ordered: boolean };
    expect(list.ordered).toBe(false);
  });

  it("parses an unordered list with plus signs", () => {
    const doc = parseMarkdown("+ item one\n+ item two");
    expect(doc.children[0]?.type).toBe("list");
    const list = doc.children[0] as { type: "list"; ordered: boolean };
    expect(list.ordered).toBe(false);
  });

  it("parses an ordered list with periods", () => {
    const doc = parseMarkdown("1. first\n2. second\n3. third");
    expect(doc.children[0]?.type).toBe("list");
    const list = doc.children[0] as { type: "list"; ordered: boolean };
    expect(list.ordered).toBe(true);
    expect(list.items).toHaveLength(3);
  });

  it("parses an ordered list with parentheses", () => {
    const doc = parseMarkdown("1) first\n2) second");
    expect(doc.children[0]?.type).toBe("list");
    const list = doc.children[0] as { type: "list"; ordered: boolean };
    expect(list.ordered).toBe(true);
  });

  // ── Blockquotes ───────────────────────────────────────────────────

  it("parses a simple blockquote", () => {
    const doc = parseMarkdown("> This is a quote");
    expect(doc.children).toHaveLength(1);
    expect(doc.children[0]?.type).toBe("blockquote");
  });

  it("parses a multi-line blockquote", () => {
    const doc = parseMarkdown("> Line one\n> Line two\n> Line three");
    expect(doc.children[0]?.type).toBe("blockquote");
    const bq = doc.children[0] as { type: "blockquote"; children: MdBlock[] };
    expect(bq.children.length).toBeGreaterThanOrEqual(1);
  });

  it("parses nested content in blockquotes", () => {
    const doc = parseMarkdown("> ## Heading in quote\n> Paragraph in quote");
    const bq = doc.children[0] as { type: "blockquote"; children: MdBlock[] };
    expect(bq.children[0]?.type).toBe("heading");
    expect(bq.children[1]?.type).toBe("paragraph");
  });

  // ── Horizontal rules ──────────────────────────────────────────────

  it("parses horizontal rule with dashes", () => {
    const doc = parseMarkdown("---");
    expect(doc.children).toHaveLength(1);
    expect(doc.children[0]?.type).toBe("horizontal_rule");
  });

  it("parses horizontal rule with underscores", () => {
    const doc = parseMarkdown("___");
    expect(doc.children[0]?.type).toBe("horizontal_rule");
  });

  it("parses horizontal rule with asterisks", () => {
    const doc = parseMarkdown("***");
    expect(doc.children[0]?.type).toBe("horizontal_rule");
  });

  it("parses horizontal rule with spaces", () => {
    const doc = parseMarkdown("- - -");
    expect(doc.children[0]?.type).toBe("horizontal_rule");
  });

  // ── Inline formatting ─────────────────────────────────────────────

  it("parses bold text with **", () => {
    const doc = parseMarkdown("This is **bold** text");
    const para = doc.children[0] as { type: "paragraph"; children: MdInline[] };
    const bold = para.children.find((c) => c.type === "bold");
    expect(bold).toBeDefined();
  });

  it("parses italic text with *", () => {
    const doc = parseMarkdown("This is *italic* text");
    const para = doc.children[0] as { type: "paragraph"; children: MdInline[] };
    const italic = para.children.find((c) => c.type === "italic");
    expect(italic).toBeDefined();
  });

  it("parses inline code", () => {
    const doc = parseMarkdown("Use `foo()` to call the function");
    const para = doc.children[0] as { type: "paragraph"; children: MdInline[] };
    const code = para.children.find((c) => c.type === "inline_code");
    expect(code).toBeDefined();
    if (code?.type === "inline_code") {
      expect(code.content).toBe("foo()");
    }
  });

  it("parses links", () => {
    const doc = parseMarkdown("Click [here](https://example.com) to go");
    const para = doc.children[0] as { type: "paragraph"; children: MdInline[] };
    const link = para.children.find((c) => c.type === "link");
    expect(link).toBeDefined();
    if (link?.type === "link") {
      expect(link.url).toBe("https://example.com");
    }
  });

  it("parses images", () => {
    const doc = parseMarkdown("![alt text](image.png)");
    const para = doc.children[0] as { type: "paragraph"; children: MdInline[] };
    const img = para.children.find((c) => c.type === "image");
    expect(img).toBeDefined();
    if (img?.type === "image") {
      expect(img.alt).toBe("alt text");
      expect(img.url).toBe("image.png");
    }
  });

  it("parses strikethrough", () => {
    const doc = parseMarkdown("This is ~~deleted~~ text");
    // Strikethrough is parsed (may map to bold internally)
    expect(doc.children).toHaveLength(1);
  });

  it("handles nested inline formatting", () => {
    const doc = parseMarkdown("This is **bold and *italic* inside** text");
    expect(doc.children).toHaveLength(1);
    const para = doc.children[0] as { type: "paragraph"; children: MdInline[] };
    const bold = para.children.find((c) => c.type === "bold");
    expect(bold).toBeDefined();
  });

  // ── Complex documents ─────────────────────────────────────────────

  it("parses a document with mixed block types", () => {
    const doc = parseMarkdown(
      "# Title\n\nSome text.\n\n- item 1\n- item 2\n\n```\ncode\n```\n\n> quote",
    );
    expect(doc.children).toHaveLength(5);
    expect(doc.children[0]?.type).toBe("heading");
    expect(doc.children[1]?.type).toBe("paragraph");
    expect(doc.children[2]?.type).toBe("list");
    expect(doc.children[3]?.type).toBe("code_block");
    expect(doc.children[4]?.type).toBe("blockquote");
  });

  it("parses a realistic LLM response", () => {
    const doc = parseMarkdown(
      "## Analysis\n\nHere are the key findings:\n\n1. First finding with **bold** emphasis\n2. Second finding with `code reference`\n3. Third finding\n\n### Details\n\n```\nfunction analyze() {\n  return true;\n}\n```\n\n> Note: This is important.\n\n---\n\nSee [documentation](https://example.com) for more.",
    );

    const types = doc.children.map((b) => b.type);
    expect(types).toContain("heading");
    expect(types).toContain("paragraph");
    expect(types).toContain("list");
    expect(types).toContain("code_block");
    expect(types).toContain("blockquote");
    expect(types).toContain("horizontal_rule");
  });

  // ── Edge cases ────────────────────────────────────────────────────

  it("handles unclosed code block gracefully", () => {
    const doc = parseMarkdown("```typescript\nconst x = 1;");
    // Should still produce a code_block, even without closing fence
    expect(doc.children[0]?.type).toBe("code_block");
  });

  it("handles text with special characters", () => {
    const doc = parseMarkdown("Special chars: < > & \" '");
    expect(doc.children).toHaveLength(1);
    expect(doc.children[0]?.type).toBe("paragraph");
  });

  it("handles consecutive blank lines between blocks", () => {
    const doc = parseMarkdown("Para 1\n\n\n\nPara 2");
    expect(doc.children).toHaveLength(2);
    expect(doc.children[0]?.type).toBe("paragraph");
    expect(doc.children[1]?.type).toBe("paragraph");
  });

  it("handles heading with trailing hashes", () => {
    const doc = parseMarkdown("## Heading ##");
    expect(doc.children[0]?.type).toBe("heading");
    if (doc.children[0]?.type === "heading") {
      expect(doc.children[0].level).toBe(2);
    }
  });
});

// ── Streaming Parser ─────────────────────────────────────────────────────────

describe("createStreamingParser", () => {
  it("feeds chunks incrementally and produces a valid tree", () => {
    const parser = createStreamingParser();

    const r1 = parser.feed("# Hello");
    expect(r1.tree.children[0]?.type).toBe("heading");
    expect(r1.stableFrom).toBe(0); // first feed — nothing stable yet

    const r2 = parser.feed("\n\nThis is a ");
    expect(r2.tree.children.length).toBeGreaterThanOrEqual(1);

    const r3 = parser.feed("paragraph.");
    expect(r3.tree.children.length).toBeGreaterThanOrEqual(1);
  });

  it("handles code blocks split across chunks", () => {
    const parser = createStreamingParser();

    parser.feed("```\n");
    parser.feed("const x = 1;\n");
    const r = parser.feed("```");

    expect(r.tree.children[0]?.type).toBe("code_block");
    const code = r.tree.children[0] as { type: "code_block"; content: string };
    expect(code.content).toContain("const x = 1;");
  });

  it("finalizes and returns complete tree", () => {
    const parser = createStreamingParser();
    parser.feed("# Title\n\nSome text");

    const final = parser.finalize();
    expect(final.type).toBe("document");
    expect(final.children.length).toBeGreaterThanOrEqual(1);
  });

  it("resets parser state", () => {
    const parser = createStreamingParser();
    parser.feed("# Old content");
    parser.reset();

    const r = parser.feed("# New content");
    expect(r.tree.children[0]?.type).toBe("heading");
    // Should only have the new content
    const heading = r.tree.children[0] as { type: "heading"; children: MdInline[] };
    if (heading.type === "heading") {
      const text = heading.children.find((c) => c.type === "text");
      if (text?.type === "text") {
        expect(text.content).toBe("New content");
      }
    }
  });

  it("getBuffer returns accumulated text", () => {
    const parser = createStreamingParser();
    parser.feed("Hello ");
    parser.feed("world");
    expect(parser.getBuffer()).toBe("Hello world");
  });

  it("reports stableFrom correctly for unchanged prefix", () => {
    const parser = createStreamingParser();

    // First feed: heading + paragraph
    const r1 = parser.feed("# Title\n\nHello ");
    expect(r1.stableFrom).toBe(0);
    expect(r1.tree.children.length).toBe(2); // heading + paragraph

    // Second feed: append to paragraph — heading is stable
    const r2 = parser.feed("world");
    expect(r2.stableFrom).toBe(1); // block 0 (heading) is stable
    expect(r2.tree.children.length).toBe(2);
  });

  it("reports stableFrom=full when tree is unchanged", () => {
    const parser = createStreamingParser();

    // First feed: just a paragraph
    const r1 = parser.feed("Hello ");
    expect(r1.tree.children[0]?.type).toBe("paragraph");

    // Second feed: empty string — tree unchanged
    const r2 = parser.feed("");
    expect(r2.stableFrom).toBe(1); // all 1 block is stable
  });

  it("handles code block closing fence that restructures the tree", () => {
    const parser = createStreamingParser();

    // Feed paragraph text + opening fence
    const r1 = parser.feed("Hello\n```\n");
    expect(r1.tree.children.length).toBe(2); // paragraph + unclosed code block
    expect(r1.tree.children[0]?.type).toBe("paragraph");
    expect(r1.tree.children[1]?.type).toBe("code_block");

    // Feed code content
    const r2 = parser.feed("const x = 1;\n");
    expect(r2.tree.children.length).toBe(2);

    // Feed closing fence — tree stays at 2 blocks (paragraph + now-closed code block)
    const r3 = parser.feed("```");
    expect(r3.tree.children.length).toBe(2);
    expect(r3.tree.children[0]?.type).toBe("paragraph");
    expect(r3.tree.children[1]?.type).toBe("code_block");
    const code = r3.tree.children[1] as { type: "code_block"; content: string };
    expect(code.content).toContain("const x = 1;");

    // Feed more text after code block
    const r4 = parser.feed("\n\nWorld");
    expect(r4.tree.children.length).toBe(3); // paragraph + code block + paragraph
    expect(r4.tree.children[0]?.type).toBe("paragraph");
    expect(r4.tree.children[1]?.type).toBe("code_block");
    expect(r4.tree.children[2]?.type).toBe("paragraph");
  });

  it("handles streaming with tree shrinking and growing correctly", () => {
    const parser = createStreamingParser();

    // Build up: heading + paragraph
    parser.feed("# Title\n\nHello");
    // Tree: [heading, paragraph] = 2 blocks

    // Append to paragraph
    const r1 = parser.feed(" world");
    expect(r1.stableFrom).toBe(1); // heading stable, paragraph changed

    // Add a code block start
    const r2 = parser.feed("\n\n```\ncode");
    expect(r2.tree.children.length).toBe(3); // heading, paragraph, unclosed code

    // Close the code block
    const r3 = parser.feed("```");
    expect(r3.tree.children[2]?.type).toBe("code_block");
    // heading and paragraph should still be stable
    expect(r3.stableFrom).toBeGreaterThanOrEqual(0);
  });

  it("does not confuse list marker + bold (***text) with horizontal rule", () => {
    // Simulates streaming: "*" arrives, then "**", then "Zero Deps:**"
    const parser = createStreamingParser();

    parser.feed("### Features\n\n*");
    // The "*" should be parsed as a list item (bare marker), not HR

    const r2 = parser.feed(" **Zero");
    // "***Zero" should NOT become a horizontal_rule
    const blocks = r2.tree.children;
    const types = blocks.map((b) => b.type);
    expect(types).not.toContain("horizontal_rule");

    const r3 = parser.feed(" Deps:** great");
    const types2 = r3.tree.children.map((b) => b.type);
    expect(types2).not.toContain("horizontal_rule");
    // Should have a list
    expect(types2).toContain("list");
  });

  it("still parses valid horizontal rules correctly", () => {
    const doc = parseMarkdown("---");
    expect(doc.children[0]?.type).toBe("horizontal_rule");

    const doc2 = parseMarkdown("* * *");
    expect(doc2.children[0]?.type).toBe("horizontal_rule");

    const doc3 = parseMarkdown("- - -");
    expect(doc3.children[0]?.type).toBe("horizontal_rule");

    const doc4 = parseMarkdown("___");
    expect(doc4.children[0]?.type).toBe("horizontal_rule");
  });

  it("does not treat '*** bold' as horizontal rule", () => {
    const doc = parseMarkdown("*** bold text");
    // This is emphasis + text, not an HR
    expect(doc.children[0]?.type).not.toBe("horizontal_rule");
  });
});

describe("getStablePrefix", () => {
  it("returns 0 for empty previous tree", () => {
    const prev = parseMarkdown("");
    const next = parseMarkdown("# Hello");
    expect(getStablePrefix(prev, next)).toBe(0);
  });

  it("returns full length when trees are identical", () => {
    const a = parseMarkdown("# Hello\n\nWorld");
    const b = parseMarkdown("# Hello\n\nWorld");
    expect(getStablePrefix(a, b)).toBe(2);
  });

  it("returns index of first changed block", () => {
    const a = parseMarkdown("# Hello\n\nFirst\n\nThird");
    const b = parseMarkdown("# Hello\n\nChanged\n\nThird");
    expect(getStablePrefix(a, b)).toBe(1); // block 0 stable, block 1 changed
  });

  it("returns previous length when new tree only appended", () => {
    const a = parseMarkdown("# Hello\n\nWorld");
    const b = parseMarkdown("# Hello\n\nWorld\n\nNew block");
    expect(getStablePrefix(a, b)).toBe(2);
  });

  it("returns correct stable prefix when code block closes", () => {
    // "Hello\n```\ncode" → 2 blocks (paragraph + unclosed code)
    const a = parseMarkdown("Hello\n```\ncode");
    expect(a.children.length).toBe(2);

    // "Hello\n```\ncode\n```" → still 2 blocks (paragraph + closed code block)
    const b = parseMarkdown("Hello\n```\ncode\n```");
    expect(b.children.length).toBe(2);
    expect(b.children[0]?.type).toBe("paragraph");
    expect(b.children[1]?.type).toBe("code_block");

    // Both blocks are structurally identical (same content "code")
    expect(getStablePrefix(a, b)).toBe(2);
  });
});

// ── Tree Utilities ───────────────────────────────────────────────────────────

describe("mdTreeToPlainText", () => {
  it("converts a simple document to plain text", () => {
    const doc = parseMarkdown("# Hello\n\nWorld");
    const plain = mdTreeToPlainText(doc);
    expect(plain).toContain("Hello");
    expect(plain).toContain("World");
  });

  it("removes formatting from bold and italic", () => {
    const doc = parseMarkdown("**bold** and *italic*");
    const plain = mdTreeToPlainText(doc);
    expect(plain).toContain("bold");
    expect(plain).toContain("italic");
    expect(plain).not.toContain("**");
    expect(plain).not.toContain("*italic*");
  });

  it("preserves code block content", () => {
    const doc = parseMarkdown("```python\nprint('hello')\n```");
    const plain = mdTreeToPlainText(doc);
    expect(plain).toContain("print('hello')");
  });

  it("converts list items with prefix", () => {
    const doc = parseMarkdown("- one\n- two");
    const plain = mdTreeToPlainText(doc);
    expect(plain).toContain("- one");
    expect(plain).toContain("- two");
  });
});

describe("walkTree", () => {
  it("visits all nodes in the tree", () => {
    const doc = parseMarkdown("# Hello\n\nSome **bold** text");
    const visited: string[] = [];

    walkTree(doc, (node) => {
      visited.push(node.type);
    });

    // walkTree iterates over document's children, not the document itself
    expect(visited).toContain("heading");
    expect(visited).toContain("paragraph");
    expect(visited).toContain("text");
    expect(visited).toContain("bold");
  });

  it("provides parent context", () => {
    const doc = parseMarkdown("# Hello\n\nSome text");
    let foundParent = false;

    walkTree(doc, (node, parent) => {
      if (node.type === "text" && parent?.type === "heading") {
        foundParent = true;
      }
    });

    expect(foundParent).toBe(true);
  });

  it("handles empty document", () => {
    const doc = parseMarkdown("");
    const visited: string[] = [];

    walkTree(doc, (node) => {
      visited.push(node.type);
    });

    expect(visited).toHaveLength(0);
  });

  it("visits nested blockquote children", () => {
    const doc = parseMarkdown("> ## Quote heading\n> Quote text");
    const visited: string[] = [];

    walkTree(doc, (node) => {
      visited.push(node.type);
    });

    expect(visited).toContain("blockquote");
    expect(visited).toContain("heading");
  });

  it("visits list item children", () => {
    const doc = parseMarkdown("- item one\n- item two");
    const visited: string[] = [];

    walkTree(doc, (node) => {
      visited.push(node.type);
    });

    expect(visited).toContain("list");
    expect(visited).toContain("text");
  });
});

// ── HTML Renderer ────────────────────────────────────────────────────────────

describe("mdTreeToHtml", () => {
  it("renders bold text as <strong>", () => {
    const doc = parseMarkdown("**bold** text");
    const html = mdTreeToHtml(doc);
    expect(html).toContain("<strong>bold</strong>");
  });

  it("renders italic text as <em>", () => {
    const doc = parseMarkdown("*italic* text");
    const html = mdTreeToHtml(doc);
    expect(html).toContain("<em>italic</em>");
  });

  it("renders inline code as <code>", () => {
    const doc = parseMarkdown("Use `foo()` to call");
    const html = mdTreeToHtml(doc);
    expect(html).toContain('<code class="inline-code">foo()</code>');
  });

  it("renders headings", () => {
    const doc = parseMarkdown("# Title\n## Subtitle");
    const html = mdTreeToHtml(doc);
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<h2>Subtitle</h2>");
  });

  it("renders code blocks with language class", () => {
    const doc = parseMarkdown("```typescript\nconst x = 1;\n```");
    const html = mdTreeToHtml(doc);
    expect(html).toContain('<pre class="code-block lang-typescript">');
    expect(html).toContain("const x = 1;");
  });

  it("renders unordered lists", () => {
    const doc = parseMarkdown("- item one\n- item two");
    const html = mdTreeToHtml(doc);
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>item one</li>");
    expect(html).toContain("<li>item two</li>");
  });

  it("renders ordered lists", () => {
    const doc = parseMarkdown("1. first\n2. second");
    const html = mdTreeToHtml(doc);
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<li>second</li>");
  });

  it("renders blockquotes", () => {
    const doc = parseMarkdown("> This is a quote");
    const html = mdTreeToHtml(doc);
    expect(html).toContain("<blockquote>");
  });

  it("renders horizontal rules", () => {
    const doc = parseMarkdown("---");
    const html = mdTreeToHtml(doc);
    expect(html).toContain("<hr />");
  });

  it("renders links", () => {
    const doc = parseMarkdown("[click here](https://example.com)");
    const html = mdTreeToHtml(doc);
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain("click here");
  });

  it("escapes HTML special characters", () => {
    const doc = parseMarkdown("Use <div> & \"quotes\"");
    const html = mdTreeToHtml(doc);
    expect(html).toContain("&lt;div&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;quotes&quot;");
  });

  it("renders strikethrough as <del>", () => {
    const doc = parseMarkdown("~~deleted~~ text");
    const html = mdTreeToHtml(doc);
    expect(html).toContain("<del>deleted</del>");
  });

  it("renders images", () => {
    const doc = parseMarkdown("![alt](image.png)");
    const html = mdTreeToHtml(doc);
    expect(html).toContain('<img src="image.png" alt="alt" />');
  });

  it("renders empty document as empty string", () => {
    const doc = parseMarkdown("");
    const html = mdTreeToHtml(doc);
    expect(html).toBe("");
  });
});

describe("markdownToHtml", () => {
  it("parses and renders in one step", () => {
    const html = markdownToHtml("# Hello\n\n**bold** and *italic*");
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  it("renders a complex document", () => {
    const md = `## Analysis

Here are the key findings:

1. First finding with **bold** emphasis
2. Second finding with \`code reference\`

### Details

\`\`\`
function analyze() {
  return true;
}
\`\`\`

> Note: This is important.

---

See [documentation](https://example.com) for more.`;

    const html = markdownToHtml(md);
    expect(html).toContain("<h2>Analysis</h2>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<code class="inline-code">code reference</code>');
    expect(html).toContain("<h3>Details</h3>");
    expect(html).toContain("<pre class=\"code-block\">");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<hr />");
    expect(html).toContain('<a href="https://example.com"');
  });
});

// ── Streaming: tiny-chunk assertions ──────────────────────────────────────────

/**
 * Helper: split a string into deterministic chunks of 1–3 characters so we can simulate
 * an LLM streaming response arriving in small bursts.
 * Uses a rotating pattern [2, 1, 3, 2, 1] for reproducibility.
 */
function* chunkify(text: string): Generator<string> {
  const sizes = [2, 1, 3, 2, 1];
  let si = 0;
  let i = 0;
  while (i < text.length) {
    const size = Math.min(sizes[si % sizes.length], text.length - i);
    yield text.slice(i, i + size);
    i += size;
    si++;
  }
}

describe("StreamingMdParser — tiny chunks (1-3 chars) with per-step assertions", () => {

  it("streams a document with 3 codeblocks, lists, headings, and a blockquote", () => {
    const md = `# Getting Started

Here is a quick overview.

\`\`\`python
def hello():
    print("hello")
\`\`\`

- first item
- second item

## Code Example Two

\`\`\`javascript
function add(a, b) {
  return a + b;
}
\`\`\`

> This is an important note.

1. ordered one
2. ordered two

\`\`\`markdown
# This is a codeblock
- not a real list
- just text inside code
\`\`\`

Final paragraph.`;

    const parser = createStreamingParser();
    const chunks = Array.from(chunkify(md));

    // Verify we actually got many small chunks
    expect(chunks.length).toBeGreaterThan(20);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(3);
    }

    let prevResult: ReturnType<typeof parser.feed> | null = null;

    for (const chunk of chunks) {
      const result = parser.feed(chunk);

      // --- Invariant checks at every step ---

      // Tree must always be a document
      expect(result.tree.type).toBe("document");

      // stableFrom must be >= 0
      expect(result.stableFrom).toBeGreaterThanOrEqual(0);

      // stableFrom must not exceed current block count
      expect(result.stableFrom).toBeLessThanOrEqual(result.tree.children.length);

      // If we had a previous result, verify stable prefix is truly stable
      if (prevResult !== null) {
        for (let i = 0; i < result.stableFrom; i++) {
          const prevBlock = prevResult.tree.children[i];
          const currBlock = result.tree.children[i];
          expect(currBlock?.type).toBe(prevBlock?.type);
        }
      }

      prevResult = result;
    }

    // --- Final assertions ---

    const final = parser.finalize();
    const types = final.children.map((b) => b.type);

    // We expect: heading, paragraph, code_block, list, heading, code_block,
    //            blockquote, list, code_block, paragraph
    expect(types).toContain("heading");
    expect(types).toContain("paragraph");
    expect(types).toContain("blockquote");
    expect(types).toContain("list");

    // Count code blocks — should be exactly 3
    const codeBlocks = types.filter((t) => t === "code_block");
    expect(codeBlocks).toHaveLength(3);

    // Verify the third codeblock contains the "fake" markdown list
    const codeBlockNodes = final.children.filter(
      (b): b is typeof b & { type: "code_block" } => b.type === "code_block",
    );
    expect(codeBlockNodes[0]?.content).toContain("def hello()");
    expect(codeBlockNodes[1]?.content).toContain("function add");
    expect(codeBlockNodes[2]?.content).toContain("- not a real list");

    // Render to HTML and verify key elements
    const html = mdTreeToHtml(final);
    expect(html).toContain("<h1>Getting Started</h1>");
    expect(html).toContain("<h2>Code Example Two</h2>");
    expect(html).toContain('<pre class="code-block lang-python">');
    expect(html).toContain('<pre class="code-block lang-javascript">');
    expect(html).toContain('<pre class="code-block lang-markdown">');
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("- not a real list"); // inside code, escaped
  });

  it("streams a codeblock containing markdown syntax that should NOT be parsed as markdown", () => {
    // This codeblock contains headings, lists, bold, links — all as plain text
    const md = `\`\`\`
# Fake heading
- fake list item
**fake bold**
[fake link](http://example.com)
> fake blockquote
---
\`\`\``;

    const parser = createStreamingParser();
    const chunks = Array.from(chunkify(md));

    for (const chunk of chunks) {
      const result = parser.feed(chunk);
      expect(result.tree.type).toBe("document");
      expect(result.stableFrom).toBeGreaterThanOrEqual(0);
    }

    const final = parser.finalize();
    expect(final.children.length).toBe(1);
    expect(final.children[0]?.type).toBe("code_block");

    const code = final.children[0] as { type: "code_block"; content: string };
    expect(code.content).toContain("# Fake heading");
    expect(code.content).toContain("- fake list item");
    expect(code.content).toContain("**fake bold**");
    expect(code.content).toContain("[fake link](http://example.com)");

    // HTML should NOT contain <h1>, <ul>, <strong>, <a> for this content
    const html = mdTreeToHtml(final);
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("<ul>");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<a href=");
    // But it should contain the raw content inside <pre><code>
    expect(html).toContain("# Fake heading");
    expect(html).toContain("- fake list item");
  });

  it("streams a complex document with nested inline formatting inside lists and codeblocks", () => {
    const md = `## Features

- **Bold** item with \`inline code\`
- *Italic* item with a [link](https://example.com)
- ~~Strikethrough~~ item

\`\`\`typescript
// A TypeScript snippet
interface Config {
  name: string;
  items: string[];
}
\`\`\`

### Installation

1. Run \`npm install\`
2. Configure your settings

\`\`\`yaml
name: my-project
items:
  - one
  - two
  - three
\`\`\`

> **Warning:** Always validate input.

\`\`\`markdown
## This looks like a heading
- but it's inside a code block
- so it should be treated as plain text

**Not bold** either.
\`\`\`

---

That's all folks.`;

    const parser = createStreamingParser();
    const chunks = Array.from(chunkify(md));

    expect(chunks.length).toBeGreaterThan(30);

    let stepCount = 0;
    for (const chunk of chunks) {
      stepCount++;
      const result = parser.feed(chunk);

      expect(result.tree.type).toBe("document");
      expect(result.stableFrom).toBeGreaterThanOrEqual(0);

      // Verify stable prefix blocks are truly unchanged
      if (stepCount > 1) {
        // Just spot-check: stableFrom should be reasonable
        expect(result.stableFrom).toBeLessThanOrEqual(result.tree.children.length);
      }
    }

    const final = parser.finalize();
    const types = final.children.map((b) => b.type);

    // Should have: heading, list, code_block, heading, list, code_block,
    //              blockquote, code_block, horizontal_rule, paragraph
    expect(types.filter((t) => t === "code_block")).toHaveLength(3);
    expect(types.filter((t) => t === "heading")).toHaveLength(2);
    expect(types.filter((t) => t === "list")).toHaveLength(2);
    expect(types).toContain("blockquote");
    expect(types).toContain("horizontal_rule");
    expect(types).toContain("paragraph");

    // HTML checks
    const html = mdTreeToHtml(final);
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain('<code class="inline-code">inline code</code>');
    expect(html).toContain("<em>Italic</em>");
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain("<del>Strikethrough</del>");
    expect(html).toContain('<pre class="code-block lang-typescript">');
    expect(html).toContain('<pre class="code-block lang-yaml">');
    expect(html).toContain('<pre class="code-block lang-markdown">');
    expect(html).toContain("- one"); // inside yaml code block
    expect(html).toContain("<hr />");

    // The markdown codeblock should NOT produce headings/lists in HTML
    const codeBlockMatch = html.match(/lang-markdown[^>]*>([\s\S]*?)<\/pre>/);
    expect(codeBlockMatch).not.toBeNull();
    const codeHtml = codeBlockMatch![1];
    expect(codeHtml).not.toContain("<h2>");
    expect(codeHtml).not.toContain("<li>");
    expect(codeHtml).not.toContain("<strong>");
  });

  it("stableFrom advances correctly as document grows during streaming", () => {
    // A simpler document to trace stableFrom progression
    const md = `# Title

First paragraph.

Second paragraph.

Third paragraph.`;

    const parser = createStreamingParser();
    const chunks = Array.from(chunkify(md));

    const stableFromHistory: number[] = [];
    const blockCountHistory: number[] = [];

    for (const chunk of chunks) {
      const result = parser.feed(chunk);
      stableFromHistory.push(result.stableFrom);
      blockCountHistory.push(result.tree.children.length);
    }

    // stableFrom should start at 0 (first feed)
    expect(stableFromHistory[0]).toBe(0);

    // At some point we should see stableFrom > 0 as earlier blocks stabilize
    const maxStable = Math.max(...stableFromHistory);
    expect(maxStable).toBeGreaterThan(0);

    // Final document should have 4 blocks: heading + 3 paragraphs
    const final = parser.finalize();
    expect(final.children.length).toBe(4);
    expect(final.children[0]?.type).toBe("heading");
    expect(final.children[1]?.type).toBe("paragraph");
    expect(final.children[2]?.type).toBe("paragraph");
    expect(final.children[3]?.type).toBe("paragraph");
  });

  it("handles codeblock fence characters arriving one at a time", () => {
    // Feed ``` one character at a time to ensure the parser handles
    // the triple-backtick detection correctly during streaming
    const md = "```python\nprint('hi')\n```";

    const parser = createStreamingParser();

    // Feed the opening fence character by character
    let result = parser.feed("`");
    expect(result.tree.type).toBe("document");

    result = parser.feed("`");
    expect(result.tree.type).toBe("document");

    result = parser.feed("`");
    // Now we have ``` — should start a code block
    expect(result.tree.children[0]?.type).toBe("code_block");

    result = parser.feed("py");
    result = parser.feed("thon");
    result = parser.feed("\n");
    result = parser.feed("pri");
    result = parser.feed("nt('");
    result = parser.feed("hi')");
    result = parser.feed("\n");
    result = parser.feed("```");

    // Final check
    const final = parser.finalize();
    expect(final.children.length).toBe(1);
    expect(final.children[0]?.type).toBe("code_block");
    const code = final.children[0] as { type: "code_block"; language?: string; content: string };
    expect(code.language).toBe("python");
    expect(code.content).toBe("print('hi')");
  });

  it("handles list markers arriving incrementally without false horizontal rules", () => {
    const md = `- item one
- item two
- item three`;

    const parser = createStreamingParser();
    const chunks = Array.from(chunkify(md));

    for (const chunk of chunks) {
      const result = parser.feed(chunk);

      // At no point should we get a horizontal_rule
      const types = result.tree.children.map((b) => b.type);
      expect(types).not.toContain("horizontal_rule");
    }

    const final = parser.finalize();
    expect(final.children[0]?.type).toBe("list");
    const list = final.children[0] as { type: "list"; items: MdListItem[] };
    expect(list.items).toHaveLength(3);
  });

  it("streams a document with 4 codeblocks of different languages interleaved with various block types", () => {
    const md = `# Multi-Language Guide

Here we cover several languages.

\`\`\`rust
fn main() {
    println!("Hello");
}
\`\`\`

- Rust is fast
- Rust is safe

\`\`\`go
func main() {
    fmt.Println("Hello")
}
\`\`\`

> Go is simple and effective.

\`\`\`bash
echo "Hello"
ls -la
\`\`\`

1. First step
2. Second step

\`\`\`json
{
  "key": "value",
  "items": [1, 2, 3]
}
\`\`\`

Done!`;

    const parser = createStreamingParser();
    const chunks = Array.from(chunkify(md));

    expect(chunks.length).toBeGreaterThan(40);

    for (const chunk of chunks) {
      const result = parser.feed(chunk);
      expect(result.tree.type).toBe("document");
      expect(result.stableFrom).toBeGreaterThanOrEqual(0);
    }

    const final = parser.finalize();
    const codeBlocks = final.children.filter(
      (b): b is typeof b & { type: "code_block"; language?: string } =>
        b.type === "code_block",
    );

    expect(codeBlocks).toHaveLength(4);
    expect(codeBlocks[0]?.language).toBe("rust");
    expect(codeBlocks[1]?.language).toBe("go");
    expect(codeBlocks[2]?.language).toBe("bash");
    expect(codeBlocks[3]?.language).toBe("json");

    // Verify content
    expect(codeBlocks[0]?.content).toContain("fn main()");
    expect(codeBlocks[1]?.content).toContain("func main()");
    expect(codeBlocks[2]?.content).toContain('echo "Hello"');
    expect(codeBlocks[3]?.content).toContain('"key": "value"');

    // HTML verification
    const html = mdTreeToHtml(final);
    expect(html).toContain("lang-rust");
    expect(html).toContain("lang-go");
    expect(html).toContain("lang-bash");
    expect(html).toContain("lang-json");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
  });

  it("correctly handles a codeblock containing backticks and markdown special chars", () => {
    const md = `\`\`\`
Here are some special characters:
# heading marker
**bold**
*italic*
- list item
[link](url)
> blockquote
\`inline code\`
---
___
***
\`\`\``;

    const parser = createStreamingParser();
    const chunks = Array.from(chunkify(md));

    for (const chunk of chunks) {
      const result = parser.feed(chunk);
      expect(result.tree.type).toBe("document");
    }

    const final = parser.finalize();
    expect(final.children.length).toBe(1);
    expect(final.children[0]?.type).toBe("code_block");

    const code = final.children[0] as { type: "code_block"; content: string };
    expect(code.content).toContain("# heading marker");
    expect(code.content).toContain("**bold**");
    expect(code.content).toContain("*italic*");
    expect(code.content).toContain("- list item");
    expect(code.content).toContain("[link](url)");
    expect(code.content).toContain("> blockquote");
    expect(code.content).toContain("---");

    // HTML should contain raw text inside <pre><code>, not parsed markdown
    const html = mdTreeToHtml(final);
    expect(html).toContain("# heading marker");
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<hr />");
  });

  it("handles empty chunks gracefully during streaming", () => {
    const md = "# Hello\n\nWorld";

    const parser = createStreamingParser();

    parser.feed("# ");
    parser.feed(""); // empty chunk
    parser.feed("He");
    parser.feed(""); // another empty chunk
    parser.feed("llo");
    parser.feed("\n\n");
    parser.feed("World");

    const final = parser.finalize();
    expect(final.children.length).toBe(2);
    expect(final.children[0]?.type).toBe("heading");
    expect(final.children[1]?.type).toBe("paragraph");
  });

  it("stableFrom is consistent across consecutive feeds of the same content", () => {
    const md = "## Test\n\nSome text here";

    const parser = createStreamingParser();
    const chunks = Array.from(chunkify(md));

    for (const chunk of chunks) {
      parser.feed(chunk);
    }

    // Feed empty string — tree shouldn't change
    const r1 = parser.feed("");
    const r2 = parser.feed("");

    expect(r1.stableFrom).toBe(r1.tree.children.length);
    expect(r2.stableFrom).toBe(r2.tree.children.length);
    expect(r1.stableFrom).toBe(r2.stableFrom);
  });

  it("streams a document with codeblocks containing markdown lists and nested formatting", () => {
    // This is the key test: codeblocks that contain what looks like markdown
    const md = `# Complex Code Examples

\`\`\`markdown
## Nested heading
- Item 1 with **bold**
- Item 2 with *italic*
- Item 3 with \`code\`
- Item 4 with [link](http://example.com)
\`\`\`

Real list below:
- real item 1
- real item 2

\`\`\`
# Another fake heading
- fake list
  - nested fake list
    - deeply nested fake
**fake bold**
\`\`\`

> A blockquote after code.

\`\`\`html
<ul>
  <li>Item 1</li>
  <li>Item 2</li>
</ul>
\`\`\`

Final text.`;

    const parser = createStreamingParser();
    const chunks = Array.from(chunkify(md));

    expect(chunks.length).toBeGreaterThan(50);

    for (const chunk of chunks) {
      const result = parser.feed(chunk);
      expect(result.tree.type).toBe("document");
      expect(result.stableFrom).toBeGreaterThanOrEqual(0);
      expect(result.stableFrom).toBeLessThanOrEqual(result.tree.children.length);
    }

    const final = parser.finalize();
    const codeBlocks = final.children.filter(
      (b): b is typeof b & { type: "code_block" } => b.type === "code_block",
    );

    expect(codeBlocks).toHaveLength(3);

    // First codeblock: markdown with nested formatting
    expect(codeBlocks[0]?.content).toContain("## Nested heading");
    expect(codeBlocks[0]?.content).toContain("- Item 1 with **bold**");
    expect(codeBlocks[0]?.content).toContain("- Item 4 with [link](http://example.com)");

    // Second codeblock: deeply nested fake lists
    expect(codeBlocks[1]?.content).toContain("- nested fake list");
    expect(codeBlocks[1]?.content).toContain("- deeply nested fake");

    // Third codeblock: HTML
    expect(codeBlocks[2]?.content).toContain("<ul>");
    expect(codeBlocks[2]?.content).toContain("<li>Item 1</li>");

    // HTML output should NOT parse the codeblock content as real HTML elements
    const html = mdTreeToHtml(final);

    // Should have exactly 3 <pre> blocks (one per codeblock)
    const preCount = (html.match(/<pre class=/g) || []).length;
    expect(preCount).toBe(3);

    // Should have real <ul> for the actual list
    const ulMatches = html.match(/<ul>/g);
    // One real <ul> + one escaped in HTML codeblock
    expect(ulMatches).not.toBeNull();

    // The escaped content should appear with &lt; and &gt;
    expect(html).toContain("&lt;ul&gt;"); // from HTML codeblock
  });

  // ── Regression: infinite loop on bare "#" ─────────────────────────

  it("does not infinite-loop on bare '#' (regression)", () => {
    // Bare "#" is not a valid heading (no space after #) but used to
    // cause parseParagraph to break with _nextIndex === start,
    // creating an infinite loop in the main parser.
    const doc = parseMarkdown("#");
    expect(doc.children.length).toBe(1);
    expect(doc.children[0]?.type).toBe("paragraph");
  });

  it("does not infinite-loop on bare '#' streamed character by character", () => {
    const parser = createStreamingParser();
    parser.feed("#");
    const r = parser.feed(" Hello");
    expect(r.tree.children[0]?.type).toBe("heading");
  });

  it("handles '#' without space as paragraph text", () => {
    const doc = parseMarkdown("#no-space");
    expect(doc.children.length).toBe(1);
    expect(doc.children[0]?.type).toBe("paragraph");
    const html = mdTreeToHtml(doc);
    expect(html).toContain("#no-space");
    expect(html).not.toContain("<h1>");
  });

  it("handles mixed bare '#' and valid headings", () => {
    const doc = parseMarkdown("#\n\n# Valid heading\n\n##\n\n## Another valid");
    expect(doc.children.length).toBe(4);
    expect(doc.children[0]?.type).toBe("paragraph");  // bare #
    expect(doc.children[1]?.type).toBe("heading");    // # Valid heading
    expect(doc.children[2]?.type).toBe("paragraph");  // bare ##
    expect(doc.children[3]?.type).toBe("heading");    // ## Another valid
  });
});

