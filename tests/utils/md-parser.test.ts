import { describe, it, expect } from "bun:test";
import {
  parseMarkdown,
  createStreamingParser,
  mdTreeToPlainText,
  walkTree,
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

    const chunk1 = parser.feed("# Hello");
    expect(chunk1.children[0]?.type).toBe("heading");

    const chunk2 = parser.feed("\n\nThis is a ");
    expect(chunk2.children.length).toBeGreaterThanOrEqual(1);

    const chunk3 = parser.feed("paragraph.");
    expect(chunk3.children.length).toBeGreaterThanOrEqual(1);
  });

  it("handles code blocks split across chunks", () => {
    const parser = createStreamingParser();

    parser.feed("```\n");
    parser.feed("const x = 1;\n");
    const final = parser.feed("```");

    expect(final.children[0]?.type).toBe("code_block");
    const code = final.children[0] as { type: "code_block"; content: string };
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

    const afterReset = parser.feed("# New content");
    expect(afterReset.children[0]?.type).toBe("heading");
    // Should only have the new content
    const heading = afterReset.children[0] as { type: "heading"; children: MdInline[] };
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
