import { describe, it, expect } from "bun:test";
import { htmlToMarkdown } from "../../src/utils/html-to-markdown.ts";

describe("htmlToMarkdown", () => {
  // ── Edge cases ────────────────────────────────────────────────────

  it("returns empty string for empty input", () => {
    expect(htmlToMarkdown("")).toBe("");
  });

  it("returns empty string for null input", () => {
    expect(htmlToMarkdown(null)).toBe("");
  });

  it("returns empty string for undefined input", () => {
    expect(htmlToMarkdown(undefined)).toBe("");
  });

  it("passes through plain text without tags", () => {
    expect(htmlToMarkdown("just plain text")).toBe("just plain text");
  });

  // ── Block elements ────────────────────────────────────────────────

  it("converts paragraphs", () => {
    const result = htmlToMarkdown("<p>Hello world</p>");
    expect(result).toBe("Hello world");
  });

  it("converts headings h1-h6", () => {
    expect(htmlToMarkdown("<h1>One</h1>")).toContain("# One");
    expect(htmlToMarkdown("<h2>Two</h2>")).toContain("## Two");
    expect(htmlToMarkdown("<h3>Three</h3>")).toContain("### Three");
    expect(htmlToMarkdown("<h4>Four</h4>")).toContain("#### Four");
    expect(htmlToMarkdown("<h5>Five</h5>")).toContain("##### Five");
    expect(htmlToMarkdown("<h6>Six</h6>")).toContain("###### Six");
  });

  it("converts unordered lists", () => {
    const result = htmlToMarkdown("<ul><li>one</li><li>two</li><li>three</li></ul>");
    expect(result).toContain("- one");
    expect(result).toContain("- two");
    expect(result).toContain("- three");
  });

  it("converts ordered lists with numbering", () => {
    const result = htmlToMarkdown("<ol><li>first</li><li>second</li><li>third</li></ol>");
    expect(result).toContain("1. first");
    expect(result).toContain("2. second");
    expect(result).toContain("3. third");
  });

  it("converts blockquotes", () => {
    const result = htmlToMarkdown("<blockquote><p>quoted text</p></blockquote>");
    expect(result).toContain(">");
    expect(result).toContain("quoted text");
  });

  it("converts horizontal rules", () => {
    const result = htmlToMarkdown("<p>before</p><hr><p>after</p>");
    expect(result).toContain("---");
  });

  it("converts code blocks without inner backticks", () => {
    const result = htmlToMarkdown("<pre><code>const x = 1;</code></pre>");
    expect(result).toContain("```");
    expect(result).toContain("const x = 1;");
    // Should NOT have extra backticks from <code> inside <pre>
    expect(result).not.toContain("````");
    expect(result).not.toContain("`const");
  });

  it("converts tables with headers and body", () => {
    const html =
      "<table>" +
      "<thead><tr><th>Name</th><th>Age</th></tr></thead>" +
      "<tbody><tr><td>Alice</td><td>30</td></tr></tbody>" +
      "</table>";
    const result = htmlToMarkdown(html);
    expect(result).toContain("| Name");
    expect(result).toContain("| Age");
    expect(result).toContain("| Alice");
    expect(result).toContain("| 30");
  });

  // ── Inline elements ───────────────────────────────────────────────

  it("converts bold with <strong>", () => {
    expect(htmlToMarkdown("<strong>bold</strong>")).toBe("**bold**");
  });

  it("converts bold with <b>", () => {
    expect(htmlToMarkdown("<b>bold</b>")).toBe("**bold**");
  });

  it("converts italic with <em>", () => {
    expect(htmlToMarkdown("<em>italic</em>")).toBe("*italic*");
  });

  it("converts italic with <i>", () => {
    expect(htmlToMarkdown("<i>italic</i>")).toBe("*italic*");
  });

  it("converts strikethrough with <del>", () => {
    expect(htmlToMarkdown("<del>old</del>")).toBe("~~old~~");
  });

  it("converts strikethrough with <s>", () => {
    expect(htmlToMarkdown("<s>old</s>")).toBe("~~old~~");
  });

  it("converts inline code", () => {
    expect(htmlToMarkdown("Use <code>foo()</code> here")).toBe(
      "Use `foo()` here",
    );
  });

  it("converts links", () => {
    const result = htmlToMarkdown(
      '<a href="https://example.com">click here</a>',
    );
    expect(result).toBe("[click here](https://example.com)");
  });

  it("converts images", () => {
    const result = htmlToMarkdown('<img src="photo.jpg" alt="A photo">');
    expect(result).toBe("![A photo](photo.jpg)");
  });

  it("converts line breaks", () => {
    const result = htmlToMarkdown("<p>line1<br>line2</p>");
    expect(result).toContain("line1");
    expect(result).toContain("line2");
  });

  // ── Nested formatting ─────────────────────────────────────────────

  it("handles nested bold and italic", () => {
    const result = htmlToMarkdown(
      "<strong>hello <em>world</em> there</strong>",
    );
    expect(result).toBe("**hello *world* there**");
  });

  it("handles deeply nested formatting", () => {
    const result = htmlToMarkdown(
      "<strong>bold <em>italic <code>code</code></em> still bold</strong>",
    );
    expect(result).toBe("**bold *italic `code`* still bold**");
  });

  it("handles bold and italic separately", () => {
    const result = htmlToMarkdown(
      "<p><strong>bold</strong> and <em>italic</em></p>",
    );
    expect(result).toBe("**bold** and *italic*");
  });

  // ── Skip elements ─────────────────────────────────────────────────

  it("strips <head> content", () => {
    const result = htmlToMarkdown(
      "<html><head><title>Title</title><meta charset='utf-8'></head><body><p>Content</p></body></html>",
    );
    expect(result).not.toContain("Title");
    expect(result).not.toContain("meta");
    expect(result).toContain("Content");
  });

  it("strips DOCTYPE declaration", () => {
    const result = htmlToMarkdown(
      "<!DOCTYPE html>\n<html><body><p>Content</p></body></html>",
    );
    expect(result).not.toContain("<!DOCTYPE");
    expect(result).not.toContain("DOCTYPE");
    expect(result).toContain("Content");
  });

  it("strips DOCTYPE with system identifier", () => {
    const result = htmlToMarkdown(
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">\n<p>Content</p>',
    );
    expect(result).not.toContain("<!DOCTYPE");
    expect(result).toContain("Content");
  });

  it("strips HTML comments", () => {
    const result = htmlToMarkdown(
      "<!-- this is a comment --><p>Content</p><!-- another comment -->",
    );
    expect(result).not.toContain("<!--");
    expect(result).not.toContain("-->");
    expect(result).not.toContain("comment");
    expect(result).toContain("Content");
  });

  it("strips multiline HTML comments", () => {
    const result = htmlToMarkdown(
      `<!--
      multiline
      comment with
      special chars: <script>alert('xss')</script>
      -->
      <p>Content</p>`,
    );
    expect(result).not.toContain("<!--");
    expect(result).not.toContain("multiline");
    expect(result).not.toContain("alert");
    expect(result).toContain("Content");
  });

  it("strips <script> tags", () => {
    const result = htmlToMarkdown(
      "<p>Before</p><script>alert('xss')</script><p>After</p>",
    );
    expect(result).not.toContain("alert");
    expect(result).not.toContain("xss");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  it("strips <style> tags", () => {
    const result = htmlToMarkdown(
      "<style>body { color: red; }</style><p>Content</p>",
    );
    expect(result).not.toContain("color");
    expect(result).toContain("Content");
  });

  it("keeps content from structural elements (nav, header, footer, aside)", () => {
    const result = htmlToMarkdown(
      "<nav><a href='/'>Home</a></nav><main><p>Content</p></main>",
    );
    expect(result).toContain("[Home](/)");
    expect(result).toContain("Content");
  });

  // ── Full page conversion ──────────────────────────────────────────

  it("converts a realistic HTML page", () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Example Page</title>
          <script>console.log('skip me');</script>
          <style>body { margin: 0; }</style>
        </head>
        <body>
          <header><nav><a href="/">Skip</a></nav></header>
          <main>
            <h1>Main Title</h1>
            <p>This is a <strong>bold</strong> paragraph with <a href="/link">a link</a>.</p>
            <h2>Subsection</h2>
            <ul>
              <li>Item one</li>
              <li>Item two</li>
            </ul>
            <blockquote><p>A quote</p></blockquote>
            <pre><code>function hello() { return "world"; }</code></pre>
          </main>
          <footer><p>Footer text</p></footer>
        </body>
      </html>
    `;
    const result = htmlToMarkdown(html);

    // Content should be present
    expect(result).toContain("# Main Title");
    expect(result).toContain("## Subsection");
    expect(result).toContain("**bold**");
    expect(result).toContain("[a link](/link)");
    expect(result).toContain("- Item one");
    expect(result).toContain("- Item two");
    expect(result).toContain(">");
    expect(result).toContain("function hello()");
    expect(result).toContain("```");

    // Skipped content should be absent
    expect(result).not.toContain("Example Page");
    expect(result).not.toContain("console.log");
    expect(result).not.toContain("margin");
    // Structural elements keep their content
    expect(result).toContain("[Skip](/)");
    expect(result).toContain("Footer text");
  });

  // ── HTML entity handling ──────────────────────────────────────────

  it("decodes common HTML entities", () => {
    const result = htmlToMarkdown("<p>5 &gt; 3 &amp; 2 &lt; 4</p>");
    expect(result).toContain(">");
    expect(result).toContain("&");
    expect(result).toContain("<");
  });

  // ── Multiple ordered lists ────────────────────────────────────────

  it("resets numbering for separate ordered lists", () => {
    const result = htmlToMarkdown(
      "<ol><li>first a</li><li>second a</li></ol><ol><li>first b</li><li>second b</li></ol>",
    );
    expect(result).toContain("1. first a");
    expect(result).toContain("2. second a");
    // Second list should restart numbering
    expect(result).toContain("1. first b");
    expect(result).toContain("2. second b");
  });
});
