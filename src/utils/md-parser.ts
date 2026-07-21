/**
 * Markdown Parser — parses markdown text into a structured object tree.
 *
 * Designed for formatting LLM output in different UIs (web, CLI, etc.).
 * Supports streaming/incremental parsing where content arrives in chunks.
 *
 * Zero external dependencies.
 */

// ── Block-level node types ───────────────────────────────────────────────────

export interface MdDocument {
  type: "document";
  children: MdBlock[];
}

export interface MdHeading {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children: MdInline[];
}

export interface MdParagraph {
  type: "paragraph";
  children: MdInline[];
}

export interface MdCodeBlock {
  type: "code_block";
  language?: string;
  content: string;
}

export interface MdList {
  type: "list";
  ordered: boolean;
  items: MdListItem[];
}

export interface MdListItem {
  children: MdInline[];
}

export interface MdBlockquote {
  type: "blockquote";
  children: MdBlock[];
}

export interface MdHorizontalRule {
  type: "horizontal_rule";
}

export interface MdThematicBreak {
  type: "thematic_break";
}

// ── Table types (GFM-style) ─────────────────────────────────────────────────

export interface MdTableCell {
  children: MdInline[];
}

export interface MdTableRow {
  cells: MdTableCell[];
}

export interface MdTable {
  type: "table";
  header: MdTableRow;
  rows: MdTableRow[];
}

/** Union of all block-level nodes. */
export type MdBlock =
  | MdHeading
  | MdParagraph
  | MdCodeBlock
  | MdList
  | MdBlockquote
  | MdHorizontalRule
  | MdThematicBreak
  | MdTable;

// ── Inline-level node types ──────────────────────────────────────────────────

export interface MdText {
  type: "text";
  content: string;
}

export interface MdBold {
  type: "bold";
  children: MdInline[];
}

export interface MdItalic {
  type: "italic";
  children: MdInline[];
}

export interface MdStrikethrough {
  type: "strikethrough";
  children: MdInline[];
}

export interface MdInlineCode {
  type: "inline_code";
  content: string;
}

export interface MdLink {
  type: "link";
  url: string;
  children: MdInline[];
}

export interface MdImage {
  type: "image";
  url: string;
  alt: string;
}

/** Union of all inline-level nodes. */
export type MdInline =
  | MdText
  | MdBold
  | MdItalic
  | MdStrikethrough
  | MdInlineCode
  | MdLink
  | MdImage;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a complete markdown string into an object tree.
 *
 * @param markdown — The full markdown source text.
 * @returns A structured MdDocument tree.
 */
export function parseMarkdown(markdown: string): MdDocument {
  const lines = markdown.split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Empty line — skip
    if (trimmed === "") {
      i++;
      continue;
    }

    // Code block (fenced)
    if (trimmed.startsWith("```")) {
      const codeBlock = parseCodeBlock(lines, i);
      blocks.push(codeBlock);
      i = codeBlock._nextIndex;
      continue;
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1]!.length, 6) as 1 | 2 | 3 | 4 | 5 | 6;
      const children = parseInline(headingMatch[2]!);
      blocks.push({ type: "heading", level, children });
      i++;
      continue;
    }

    // Horizontal rule / thematic break
    if (isHorizontalRule(trimmed)) {
      blocks.push({ type: "horizontal_rule" });
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith(">")) {
      const blockquote = parseBlockquote(lines, i);
      blocks.push(blockquote);
      i = blockquote._nextIndex;
      continue;
    }

    // List (unordered or ordered)
    if (isListLine(trimmed)) {
      const list = parseList(lines, i);
      blocks.push(list);
      i = list._nextIndex;
      continue;
    }

    // Table (GFM-style) — check if this line and the next form a table header + delimiter
    if (isTableHeaderLine(trimmed) && i + 1 < lines.length && isTableDelimiter(lines[i + 1]!.trim())) {
      const table = parseTable(lines, i);
      blocks.push(table);
      i = table._nextIndex;
      continue;
    }

    // Default: paragraph
    const paragraph = parseParagraph(lines, i);
    blocks.push(paragraph);
    i = paragraph._nextIndex;
  }

  return { type: "document", children: blocks };
}

// ── Streaming Parser ─────────────────────────────────────────────────────────

// ── Streaming Parser (incremental with diff) ─────────────────────────────

/**
 * Result of feeding a chunk into a streaming parser.
 * `stableFrom` is the index of the first block that changed since the
 * previous feed — blocks before this index are unchanged and their DOM
 * can be left alone.
 */
export interface FeedResult {
  tree: MdDocument;
  stableFrom: number;
}

/**
 * Deep-compare two inline nodes for structural equality.
 */
function inlinesEqual(a: MdInline, b: MdInline): boolean {
  if (a.type !== b.type) return false;

  switch (a.type) {
    case "text":
      return (a as MdText).content === (b as MdText).content;
    case "bold":
    case "italic":
    case "strikethrough":
      return inlineArraysEqual(
        (a as MdBold | MdItalic).children,
        (b as MdBold | MdItalic).children,
      );
    case "inline_code":
      return (a as MdInlineCode).content === (b as MdInlineCode).content;
    case "link":
      return (
        (a as MdLink).url === (b as MdLink).url &&
        inlineArraysEqual(
          (a as MdLink).children,
          (b as MdLink).children,
        )
      );
    case "image":
      return (
        (a as MdImage).url === (b as MdImage).url &&
        (a as MdImage).alt === (b as MdImage).alt
      );
  }
}

function inlineArraysEqual(a: MdInline[], b: MdInline[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!inlinesEqual(a[i]!, b[i]!)) return false;
  }
  return true;
}

/**
 * Deep-compare two block nodes for structural equality.
 */
function areBlocksEqual(a: MdBlock, b: MdBlock): boolean {
  if (a.type !== b.type) return false;

  switch (a.type) {
    case "heading":
      return (
        (a as MdHeading).level === (b as MdHeading).level &&
        inlineArraysEqual(
          (a as MdHeading).children,
          (b as MdHeading).children,
        )
      );
    case "paragraph":
      return inlineArraysEqual(
        (a as MdParagraph).children,
        (b as MdParagraph).children,
      );
    case "code_block": {
      const ca = a as MdCodeBlock;
      const cb = b as MdCodeBlock;
      return ca.content === cb.content && ca.language === cb.language;
    }
    case "list": {
      const la = a as MdList;
      const lb = b as MdList;
      if (la.ordered !== lb.ordered || la.items.length !== lb.items.length)
        return false;
      for (let i = 0; i < la.items.length; i++) {
        if (
          !inlineArraysEqual(
            la.items[i]!.children,
            lb.items[i]!.children,
          )
        )
          return false;
      }
      return true;
    }
    case "table": {
      const ta = a as MdTable;
      const tb = b as MdTable;
      if (
        ta.header.cells.length !== tb.header.cells.length ||
        ta.rows.length !== tb.rows.length
      )
        return false;
      // Compare header cells
      for (let i = 0; i < ta.header.cells.length; i++) {
        if (
          !inlineArraysEqual(
            ta.header.cells[i]!.children,
            tb.header.cells[i]!.children,
          )
        )
          return false;
      }
      // Compare rows
      for (let r = 0; r < ta.rows.length; r++) {
        const ra = ta.rows[r]!;
        const rb = tb.rows[r]!;
        if (ra.cells.length !== rb.cells.length) return false;
        for (let c = 0; c < ra.cells.length; c++) {
          if (
            !inlineArraysEqual(
              ra.cells[c]!.children,
              rb.cells[c]!.children,
            )
          )
            return false;
        }
      }
      return true;
    }
    case "blockquote": {
      const ba = a as MdBlockquote;
      const bb = b as MdBlockquote;
      if (ba.children.length !== bb.children.length) return false;
      for (let i = 0; i < ba.children.length; i++) {
        if (!areBlocksEqual(ba.children[i]!, bb.children[i]!)) return false;
      }
      return true;
    }
    case "horizontal_rule":
    case "thematic_break":
      return true;
  }
}

/**
 * Given two parse trees (previous and current), find the index of the
 * first block that differs.  Returns `prev.children.length` if the new
 * tree only appended blocks, or `0` if everything changed.
 */
export function getStablePrefix(prev: MdDocument, next: MdDocument): number {
  const len = Math.min(prev.children.length, next.children.length);
  for (let i = 0; i < len; i++) {
    if (!areBlocksEqual(prev.children[i]!, next.children[i]!)) {
      return i;
    }
  }
  return len;
}

/**
 * Incremental/streaming markdown parser.
 *
 * Feed chunks of markdown as they arrive (e.g., from an LLM streaming response).
 * Each call to `feed()` returns the full tree plus a `stableFrom` index so
 * the renderer only re-renders the changed tail of the document.
 */
export class StreamingMdParser {
  private buffer = "";
  private prevTree: MdDocument | null = null;

  /**
   * Feed a new chunk of markdown text into the parser.
   *
   * @param chunk — A new chunk of markdown text.
   * @returns The current parse tree and the index of the first changed block.
   */
  feed(chunk: string): FeedResult {
    this.buffer += chunk;
    const tree = parseMarkdown(this.buffer);

    if (this.prevTree === null) {
      this.prevTree = tree;
      return { tree, stableFrom: 0 };
    }

    const stableFrom = getStablePrefix(this.prevTree, tree);
    this.prevTree = tree;
    return { tree, stableFrom };
  }

  /**
   * Finalize the stream and return the complete parse tree.
   *
   * @returns The final MdDocument tree.
   */
  finalize(): MdDocument {
    return parseMarkdown(this.buffer);
  }

  /**
   * Reset the parser state for reuse.
   */
  reset(): void {
    this.buffer = "";
    this.prevTree = null;
  }

  /**
   * Get the current raw buffer without parsing.
   */
  getBuffer(): string {
    return this.buffer;
  }
}

/**
 * Create a new streaming markdown parser.
 */
export function createStreamingParser(): StreamingMdParser {
  return new StreamingMdParser();
}

// ── Tree Utilities ───────────────────────────────────────────────────────────

/**
 * Flatten a markdown tree back into plain text (no formatting).
 */
export function mdTreeToPlainText(tree: MdDocument): string {
  const parts: string[] = [];

  for (const block of tree.children) {
    switch (block.type) {
      case "heading":
        parts.push(block.children.map(flatInline).join(""));
        parts.push("\n");
        break;
      case "paragraph":
        parts.push(block.children.map(flatInline).join(""));
        parts.push("\n");
        break;
      case "code_block":
        parts.push(block.content);
        parts.push("\n");
        break;
      case "list":
        for (const item of block.items) {
          const prefix = block.ordered ? "- " : "- ";
          parts.push(prefix + item.children.map(flatInline).join(""));
          parts.push("\n");
        }
        break;
      case "blockquote":
        for (const child of block.children) {
          parts.push("> ");
          parts.push(mdTreeToPlainText({ type: "document", children: [child] }));
        }
        break;
      case "horizontal_rule":
        parts.push("---\n");
        break;
      case "thematic_break":
        parts.push("---\n");
        break;
      case "table":
        // Flatten table to pipe-separated text
        const allRows: MdTableRow[] = [block.header, ...block.rows];
        for (const row of allRows) {
          const cellTexts = row.cells.map((cell) =>
            cell.children.map(flatInline).join(""),
          );
          parts.push("| " + cellTexts.join(" | ") + " |\n");
        }
        break;
    }
  }

  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

// ── HTML Renderer ────────────────────────────────────────────────────────────

/**
 * Escape HTML special characters in text content.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render inline nodes to HTML.
 */
function inlineToHtml(node: MdInline): string {
  switch (node.type) {
    case "text":
      return escapeHtml(node.content);
    case "bold":
      return `<strong>${node.children.map(inlineToHtml).join("")}</strong>`;
    case "italic":
      return `<em>${node.children.map(inlineToHtml).join("")}</em>`;
    case "strikethrough":
      return `<del>${node.children.map(inlineToHtml).join("")}</del>`;
    case "inline_code":
      return `<code class="inline-code">${escapeHtml(node.content)}</code>`;
    case "link":
      return `<a href="${escapeHtml(node.url)}" target="_blank" rel="noopener noreferrer">${node.children.map(inlineToHtml).join("")}</a>`;
    case "image":
      return `<img src="${escapeHtml(node.url)}" alt="${escapeHtml(node.alt)}" />`;
  }
}

/**
 * Render a single block node to HTML.
 */
function blockToHtml(block: MdBlock): string {
  switch (block.type) {
    case "heading": {
      const tag = `h${block.level}`;
      return `<${tag}>${block.children.map(inlineToHtml).join("")}</${tag}>`;
    }
    case "paragraph":
      return `<p>${block.children.map(inlineToHtml).join("")}</p>`;
    case "code_block": {
      const classes = block.language ? `code-block lang-${escapeHtml(block.language)}` : "code-block";
      return `<pre class="${classes}"><code>${escapeHtml(block.content)}</code></pre>`;
    }
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items
        .map((item) => `<li>${item.children.map(inlineToHtml).join("")}</li>`)
        .join("");
      return `<${tag}>${items}</${tag}>`;
    }
    case "blockquote":
      return `<blockquote>${block.children.map(blockToHtml).join("")}</blockquote>`;
    case "horizontal_rule":
      return `<hr />`;
    case "thematic_break":
      return `<hr />`;
    case "table": {
      const headerCells = block.header.cells
        .map((cell) => `<th>${cell.children.map(inlineToHtml).join("")}</th>`)
        .join("");
      const bodyRows = block.rows
        .map(
          (row) =>
            `<tr>${row.cells
              .map((cell) => `<td>${cell.children.map(inlineToHtml).join("")}</td>`)
              .join("")}</tr>`,
        )
        .join("");
      return `<table class="md-table"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
    }
  }
}

/**
 * Render a parsed markdown tree to an HTML string.
 *
 * @param tree — The MdDocument tree from parseMarkdown().
 * @returns An HTML string suitable for innerHTML assignment.
 */
export function mdTreeToHtml(tree: MdDocument): string {
  return tree.children.map(blockToHtml).join("\n");
}

/**
 * Render a range of blocks from a tree to an HTML string.
 * Useful for incremental re-rendering during streaming.
 *
 * @param tree — The MdDocument tree from parseMarkdown().
 * @param from — Start index (inclusive, 0-based).
 * @param to — End index (exclusive). Defaults to tree.children.length.
 * @returns An HTML string for the specified block range.
 */
export function renderBlocksToHtml(
  tree: MdDocument,
  from: number,
  to?: number,
): string {
  const end = to ?? tree.children.length;
  return tree.children.slice(from, end).map(blockToHtml).join("\n");
}

/**
 * Convenience function: parse markdown and render to HTML in one step.
 *
 * @param markdown — The markdown source text.
 * @returns An HTML string suitable for innerHTML assignment.
 */
export function markdownToHtml(markdown: string): string {
  const tree = parseMarkdown(markdown);
  return mdTreeToHtml(tree);
}

/**
 * Walk the tree and call a callback for each node.
 */
export function walkTree(
  tree: MdDocument,
  callback: (node: MdBlock | MdInline, parent: MdBlock | MdInline | null) => void,
): void {
  for (const block of tree.children) {
    walkBlock(block, null, callback);
  }
}

function walkBlock(
  block: MdBlock,
  parent: MdBlock | MdInline | null,
  callback: (node: MdBlock | MdInline, parent: MdBlock | MdInline | null) => void,
): void {
  callback(block, parent);

  switch (block.type) {
    case "heading":
    case "paragraph":
      for (const child of block.children) {
        callback(child, block);
      }
      break;
    case "list":
      for (const item of block.items) {
        for (const child of item.children) {
          callback(child, block);
        }
      }
      break;
    case "blockquote":
      for (const child of block.children) {
        walkBlock(child, block, callback);
      }
      break;
    case "table":
      // Walk header cells
      for (const cell of block.header.cells) {
        for (const child of cell.children) {
          callback(child, block);
        }
      }
      // Walk row cells
      for (const row of block.rows) {
        for (const cell of row.cells) {
          for (const child of cell.children) {
            callback(child, block);
          }
        }
      }
      break;
  }
}

// ── Block-level Parsers ──────────────────────────────────────────────────────

function parseCodeBlock(
  lines: string[],
  start: number,
): MdCodeBlock & { _nextIndex: number } {
  const fenceLine = lines[start]!.trim();
  const language = fenceLine.slice(3).trim() || undefined;
  const contentLines: string[] = [];
  let i = start + 1;

  while (i < lines.length) {
    if (lines[i]!.trim().startsWith("```")) {
      i++;
      break;
    }
    contentLines.push(lines[i]!);
    i++;
  }

  return {
    type: "code_block",
    language,
    content: contentLines.join("\n"),
    _nextIndex: i,
  };
}

function parseBlockquote(
  lines: string[],
  start: number,
): MdBlockquote & { _nextIndex: number } {
  const contentLines: string[] = [];
  let i = start;

  while (i < lines.length) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith(">")) {
      // Remove the leading ">" and optional space
      contentLines.push(trimmed.slice(1).trimStart());
      i++;
    } else if (trimmed === "") {
      // Allow blank lines inside blockquotes
      contentLines.push("");
      i++;
    } else {
      break;
    }
  }

  const innerDoc = parseMarkdown(contentLines.join("\n"));
  return {
    type: "blockquote",
    children: innerDoc.children,
    _nextIndex: i,
  };
}

function parseList(
  lines: string[],
  start: number,
): MdList & { _nextIndex: number } {
  const firstLine = lines[start]!.trim();
  const ordered = isOrderedListLine(firstLine);
  const items: MdListItem[] = [];
  let i = start;

  while (i < lines.length) {
    const trimmed = lines[i]!.trim();

    if (isListLine(trimmed)) {
      const content = getListContent(trimmed);
      items.push({ children: parseInline(content) });
      i++;
    } else if (trimmed === "") {
      // Blank line ends the list
      break;
    } else {
      // Continuation of previous list item (indented text)
      if (items.length > 0) {
        const continuation = parseInline(trimmed);
        items[items.length - 1]!.children.push(...continuation);
        i++;
      } else {
        break;
      }
    }
  }

  return { type: "list", ordered, items, _nextIndex: i };
}

function parseTable(
  lines: string[],
  start: number,
): MdTable & { _nextIndex: number } {
  // Line `start` is the header row, line `start+1` is the delimiter row
  const headerLine = lines[start]!.trim();
  const headerCells = parseTableRowCells(headerLine);

  let i = start + 2; // skip header + delimiter
  const rows: MdTableRow[] = [];

  while (i < lines.length) {
    const trimmed = lines[i]!.trim();

    if (trimmed === "") {
      // Blank line ends the table
      break;
    }
    if (!isTableRowLine(trimmed)) {
      break;
    }

    const cells = parseTableRowCells(trimmed);
    rows.push({ cells });
    i++;
  }

  return {
    type: "table",
    header: { cells: headerCells },
    rows,
    _nextIndex: i,
  };
}

function parseTableRowCells(line: string): MdTableCell[] {
  // Strip leading/trailing pipes if present
  const stripped = line.trim();
  const inner =
    stripped.startsWith("|") && stripped.endsWith("|")
      ? stripped.slice(1, -1)
      : stripped;

  // Split on pipes, but handle empty cells correctly
  const rawCells = inner.split("|");
  return rawCells.map((raw) => ({
    children: parseInline(raw.trim()),
  }));
}

// ── Table detection helpers ─────────────────────────────────────────────────

function isTableHeaderLine(line: string): boolean {
  // Must contain at least one pipe and look like a row (not a horizontal rule)
  if (!line.includes("|")) return false;
  const trimmed = line.trim();
  // Reject lines that are pure horizontal rules (e.g., "|---|---|")
  // A header should have actual content, not just dashes/underscores/asterisks
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
  return cells.some(
    (c) => c !== "" && !/^[-:*_]+$/.test(c),
  );
}

function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false;
  const inner = trimmed.slice(1, -1);
  const cells = inner.split("|");
  // Every cell must match: optional spaces, colons, dashes, colons, optional spaces
  const cellPattern = /^\s*:?-+:?\s*$/;
  return cells.length > 0 && cells.every((c) => cellPattern.test(c));
}

function isTableRowLine(line: string): boolean {
  return line.trim().startsWith("|") && line.trim().endsWith("|");
}

function parseParagraph(
  lines: string[],
  start: number,
): MdParagraph & { _nextIndex: number } {
  const contentLines: string[] = [];
  let i = start;

  while (i < lines.length) {
    const trimmed = lines[i]!.trim();

    if (trimmed === "") {
      break;
    }
    // Stop if we hit a block-level element.
    // Use the heading regex (not just startsWith("#")) so that bare "#"
    // or "#no-space" are treated as paragraph text, not as a heading.
    // This prevents an infinite loop when parseParagraph breaks with
    // _nextIndex === start.
    if (
      /^#{1,6}\s+/.test(trimmed) ||
      trimmed.startsWith("```") ||
      trimmed.startsWith(">") ||
      isListLine(trimmed) ||
      isHorizontalRule(trimmed)
    ) {
      break;
    }

    contentLines.push(trimmed);
    i++;
  }

  const children = parseInline(contentLines.join(" "));
  return { type: "paragraph", children, _nextIndex: i };
}

// ── Inline Parser ────────────────────────────────────────────────────────────

function parseInline(text: string): MdInline[] {
  const result: MdInline[] = [];
  let i = 0;

  while (i < text.length) {
    // Inline code
    if (text[i] === "`" && !isTripleBacktick(text, i)) {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        result.push({ type: "inline_code", content: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Image: ![alt](url)
    if (text[i] === "!" && text[i + 1] === "[") {
      const img = parseImageOrLink(text, i, true);
      if (img) {
        result.push(img.node);
        i = img.endIndex;
        continue;
      }
    }

    // Link: [text](url)
    if (text[i] === "[") {
      const link = parseImageOrLink(text, i, false);
      if (link) {
        result.push(link.node);
        i = link.endIndex;
        continue;
      }
    }

    // Bold+Italic: ***text*** or ___text___
    if (text.slice(i, i + 3) === "***") {
      const boldItalic = parseEmphasis(text, i, 3, "bold_italic");
      if (boldItalic) {
        result.push(boldItalic.node);
        i = boldItalic.endIndex;
        continue;
      }
    }

    // Strikethrough: ~~text~~
    if (text.slice(i, i + 2) === "~~") {
      const strike = parseEmphasis(text, i, 2, "strikethrough");
      if (strike) {
        result.push(strike.node);
        i = strike.endIndex;
        continue;
      }
    }

    // Bold: **text** or __text__
    if (text.slice(i, i + 2) === "**") {
      const bold = parseEmphasis(text, i, 2, "bold");
      if (bold) {
        result.push(bold.node);
        i = bold.endIndex;
        continue;
      }
    }

    // Italic: *text* or _text_
    if (text[i] === "*" || text[i] === "_") {
      const delim = text[i];
      const italic = parseEmphasis(text, i, 1, "italic");
      if (italic) {
        result.push(italic.node);
        i = italic.endIndex;
        continue;
      }
    }

    // Plain text — accumulate until next special char
    const specialChars = "`![*~_";
    let nextSpecial = text.length;
    for (const ch of specialChars) {
      const idx = text.indexOf(ch, i);
      if (idx !== -1 && idx < nextSpecial) {
        nextSpecial = idx;
      }
    }

    if (nextSpecial > i) {
      result.push({ type: "text", content: text.slice(i, nextSpecial) });
      i = nextSpecial;
    } else {
      // No special char found ahead, take rest
      result.push({ type: "text", content: text.slice(i) });
      i = text.length;
    }
  }

  return result;
}

function parseImageOrLink(
  text: string,
  start: number,
  isImage: boolean,
): { node: MdImage | MdLink; endIndex: number } | null {
  const prefixLen = isImage ? 2 : 1; // "![" vs "["
  const openBracket = start + prefixLen;

  // Find matching "]"
  let bracketDepth = 1;
  let closeBracket = openBracket;
  while (closeBracket < text.length && bracketDepth > 0) {
    if (text[closeBracket] === "[") bracketDepth++;
    if (text[closeBracket] === "]") bracketDepth--;
    if (bracketDepth > 0) closeBracket++;
  }

  if (bracketDepth !== 0) return null;

  // Expect "(url)" after "]"
  if (text[closeBracket + 1] !== "(") return null;

  const parenStart = closeBracket + 2;
  const closeParen = text.indexOf(")", parenStart);
  if (closeParen === -1) return null;

  const label = text.slice(openBracket, closeBracket);
  const url = text.slice(parenStart, closeParen);

  if (isImage) {
    return {
      node: { type: "image", url, alt: label },
      endIndex: closeParen + 1,
    };
  }

  return {
    node: { type: "link", url, children: parseInline(label) },
    endIndex: closeParen + 1,
  };
}

interface EmphasisResult {
  node: MdBold | MdItalic | MdStrikethrough;
  endIndex: number;
}

function parseEmphasis(
  text: string,
  start: number,
  markerLen: number,
  kind: "bold" | "italic" | "strikethrough" | "bold_italic",
): EmphasisResult | null {
  const openMarker = text.slice(start, start + markerLen);
  const closeMarker = openMarker;

  const openEnd = start + markerLen;
  const closeIdx = text.indexOf(closeMarker, openEnd);

  if (closeIdx === -1) return null;

  const innerText = text.slice(openEnd, closeIdx);
  const inner = parseInline(innerText);

  let node: MdBold | MdItalic | MdStrikethrough;

  if (kind === "bold") {
    node = { type: "bold", children: inner };
  } else if (kind === "bold_italic") {
    // ***text*** → <strong><em>text</em></strong>
    node = { type: "bold", children: [{ type: "italic", children: inner }] };
  } else if (kind === "italic") {
    node = { type: "italic", children: inner };
  } else {
    node = { type: "strikethrough", children: inner };
  }

  return { node, endIndex: closeIdx + markerLen };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isListLine(trimmed: string): boolean {
  // Match standard list items: "- text", "* text", "1. text", etc.
  // Also match bare markers (e.g. "*") which can occur during streaming
  // when the content hasn't arrived yet.
  return (
    /^[-*+]\s+/.test(trimmed) ||
    /^[-*+]$/.test(trimmed) ||
    /^\d+[\.\)]\s+/.test(trimmed) ||
    /^\d+[\.\)]$/.test(trimmed)
  );
}

function isOrderedListLine(trimmed: string): boolean {
  return /^\d+[\.\)]\s+/.test(trimmed) || /^\d+[\.\)]$/.test(trimmed);
}

function getListContent(trimmed: string): string {
  // Remove list marker: "- ", "* ", "+ ", "1. ", "1) ", or bare marker "-" / "*" / "+"
  return trimmed
    .replace(/^[-*+]\s+/, "")
    .replace(/^[-*+]$/, "")
    .replace(/^\d+[\.\)]\s+/, "")
    .replace(/^\d+[\.\)]$/, "");
}

function isHorizontalRule(trimmed: string): boolean {
  // Must be exclusively one character type (+ optional spaces), not mixed
  // with other content.  This prevents "* **bold**" from matching as HR.
  // Valid: "***", "* * *", "---", "- - -", "___", "_ _ _"
  // Invalid: "*** extra", "* **", "---text"

  // Reject if the line looks like a list item (marker followed by non-marker content)
  if (/^[-*+][\s\S]/.test(trimmed) && !/^[-*+][\s*-]*$/.test(trimmed)) {
    return false;
  }
  if (/^_[\s\S]/.test(trimmed) && !/^_[\s_]*$/.test(trimmed)) {
    return false;
  }

  const cleaned = trimmed.replace(/\s/g, "");
  return (
    (cleaned.startsWith("---") && cleaned.length >= 3) ||
    (cleaned.startsWith("___") && cleaned.length >= 3) ||
    (cleaned.startsWith("***") && cleaned.length >= 3)
  );
}

function isTripleBacktick(text: string, pos: number): boolean {
  return text.slice(pos, pos + 3) === "```";
}

function flatInline(node: MdInline): string {
  switch (node.type) {
    case "text":
      return node.content;
    case "bold":
    case "italic":
    case "strikethrough":
      return node.children.map(flatInline).join("");
    case "inline_code":
      return node.content;
    case "link":
      return node.children.map(flatInline).join("");
    case "image":
      return node.alt;
  }
}
