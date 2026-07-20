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

/** Union of all block-level nodes. */
export type MdBlock =
  | MdHeading
  | MdParagraph
  | MdCodeBlock
  | MdList
  | MdBlockquote
  | MdHorizontalRule
  | MdThematicBreak;

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

    // Default: paragraph
    const paragraph = parseParagraph(lines, i);
    blocks.push(paragraph);
    i = paragraph._nextIndex;
  }

  return { type: "document", children: blocks };
}

// ── Streaming Parser ─────────────────────────────────────────────────────────

/**
 * Incremental/streaming markdown parser.
 *
 * Feed chunks of markdown as they arrive (e.g., from an LLM streaming response),
 * and get the current parse tree at any point. Incomplete elements at the end
 * are buffered and parsed when more data arrives.
 */
export class StreamingMdParser {
  private buffer = "";

  /**
   * Feed a new chunk of markdown text into the parser.
   *
   * @param chunk — A new chunk of markdown text.
   * @returns The current best-effort parse tree.
   */
  feed(chunk: string): MdDocument {
    this.buffer += chunk;
    return parseMarkdown(this.buffer);
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
    }
  }

  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
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
    // Stop if we hit a block-level element
    if (
      trimmed.startsWith("#") ||
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
  node: MdBold | MdItalic;
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

  let node: MdBold | MdItalic;

  if (kind === "bold" || kind === "bold_italic") {
    node = { type: "bold", children: inner };
  } else if (kind === "italic") {
    node = { type: "italic", children: inner };
  } else {
    // strikethrough falls through to bold for now
    node = { type: "bold", children: inner };
  }

  return { node, endIndex: closeIdx + markerLen };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isListLine(trimmed: string): boolean {
  return (
    /^[-*+]\s+/.test(trimmed) ||
    /^\d+[\.\)]\s+/.test(trimmed)
  );
}

function isOrderedListLine(trimmed: string): boolean {
  return /^\d+[\.\)]\s+/.test(trimmed);
}

function getListContent(trimmed: string): string {
  // Remove list marker: "- ", "* ", "+ ", "1. ", "1) "
  return trimmed.replace(/^[-*+]\s+/, "").replace(/^\d+[\.\)]\s+/, "");
}

function isHorizontalRule(trimmed: string): boolean {
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
