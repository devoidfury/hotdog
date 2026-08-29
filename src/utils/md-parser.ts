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

export type MdBlock =
  | MdHeading
  | MdParagraph
  | MdCodeBlock
  | MdList
  | MdBlockquote
  | MdHorizontalRule
  | MdTable;

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

export type MdInline =
  | MdText
  | MdBold
  | MdItalic
  | MdStrikethrough
  | MdInlineCode
  | MdLink
  | MdImage;

export function parseMarkdown(markdown: string): MdDocument {
  const lines = markdown.split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === "") {
      i++;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const codeBlock = parseCodeBlock(lines, i);
      blocks.push(codeBlock);
      i = codeBlock._nextIndex;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1]!.length, 6) as
        1 | 2 | 3 | 4 | 5 | 6;
      const children = parseInline(headingMatch[2]!);
      blocks.push({ type: "heading", level, children });
      i++;
      continue;
    }

    if (isHorizontalRule(trimmed)) {
      blocks.push({ type: "horizontal_rule" });
      i++;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const blockquote = parseBlockquote(lines, i);
      blocks.push(blockquote);
      i = blockquote._nextIndex;
      continue;
    }

    if (isListLine(trimmed)) {
      const list = parseList(lines, i);
      blocks.push(list);
      i = list._nextIndex;
      continue;
    }

    if (
      isTableHeaderLine(trimmed) &&
      i + 1 < lines.length &&
      isTableDelimiter(lines[i + 1]!.trim())
    ) {
      const table = parseTable(lines, i);
      blocks.push(table);
      i = table._nextIndex;
      continue;
    }

    const paragraph = parseParagraph(lines, i);
    blocks.push(paragraph);
    i = paragraph._nextIndex;
  }

  return { type: "document", children: blocks };
}

export interface FeedResult {
  tree: MdDocument;
  /** First block changed since the previous feed; earlier blocks' DOM can be left alone. */
  stableFrom: number;
}

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
        inlineArraysEqual((a as MdLink).children, (b as MdLink).children)
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

function areBlocksEqual(a: MdBlock, b: MdBlock): boolean {
  if (a.type !== b.type) return false;

  switch (a.type) {
    case "heading":
      return (
        (a as MdHeading).level === (b as MdHeading).level &&
        inlineArraysEqual((a as MdHeading).children, (b as MdHeading).children)
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
        if (!inlineArraysEqual(la.items[i]!.children, lb.items[i]!.children))
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
      for (let i = 0; i < ta.header.cells.length; i++) {
        if (
          !inlineArraysEqual(
            ta.header.cells[i]!.children,
            tb.header.cells[i]!.children,
          )
        )
          return false;
      }
      for (let r = 0; r < ta.rows.length; r++) {
        const ra = ta.rows[r]!;
        const rb = tb.rows[r]!;
        if (ra.cells.length !== rb.cells.length) return false;
        for (let c = 0; c < ra.cells.length; c++) {
          if (!inlineArraysEqual(ra.cells[c]!.children, rb.cells[c]!.children))
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
      return true;
  }
}

export function getStablePrefix(prev: MdDocument, next: MdDocument): number {
  const len = Math.min(prev.children.length, next.children.length);
  for (let i = 0; i < len; i++) {
    if (!areBlocksEqual(prev.children[i]!, next.children[i]!)) {
      return i;
    }
  }
  return len;
}

export class StreamingMdParser {
  private buffer = "";
  private prevTree: MdDocument | null = null;

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

  finalize(): MdDocument {
    return parseMarkdown(this.buffer);
  }

  reset(): void {
    this.buffer = "";
    this.prevTree = null;
  }

  getBuffer(): string {
    return this.buffer;
  }
}

export function createStreamingParser(): StreamingMdParser {
  return new StreamingMdParser();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SAFE_LINK_SCHEMES = new Set(["http", "https", "mailto"]);
const SAFE_IMAGE_SCHEMES = new Set(["http", "https"]);
// data: URLs are only safe for script-less raster image types (svg can carry scripts)
const SAFE_DATA_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp)(;|$)/i;

// Blocks script-capable schemes (javascript:, vbscript:, data:text/html).
// Browsers ignore C0 controls/whitespace when parsing URLs (e.g. `java\tscript:`),
// so strip them before checking the scheme; no valid URL contains raw C0 controls.
// Schemeless (relative, protocol-relative) URLs are allowed.
function isSafeUrl(url: string, allowedSchemes: Set<string>, allowImageData: boolean): boolean {
  const normalized = url.replace(/[\x00-\x20]/g, "");
  if (allowImageData && SAFE_DATA_IMAGE_RE.test(normalized)) return true;
  const m = normalized.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!m) return true;
  return allowedSchemes.has(m[1]!.toLowerCase());
}

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
    case "link": {
      if (!isSafeUrl(node.url, SAFE_LINK_SCHEMES, false)) {
        // Unsafe scheme (javascript:, etc.) -- render the link text as plain text.
        return node.children.map(inlineToHtml).join("");
      }
      return `<a href="${escapeHtml(node.url)}" target="_blank" rel="noopener noreferrer">${node.children.map(inlineToHtml).join("")}</a>`;
    }
    case "image":
      if (!isSafeUrl(node.url, SAFE_IMAGE_SCHEMES, true)) return "";
      return `<img src="${escapeHtml(node.url)}" alt="${escapeHtml(node.alt)}" />`;
  }
}

function blockToHtml(block: MdBlock): string {
  switch (block.type) {
    case "heading": {
      const tag = `h${block.level}`;
      return `<${tag}>${block.children.map(inlineToHtml).join("")}</${tag}>`;
    }
    case "paragraph":
      return `<p>${block.children.map(inlineToHtml).join("")}</p>`;
    case "code_block": {
      const classes = block.language
        ? `code-block lang-${escapeHtml(block.language)}`
        : "code-block";
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
    case "table": {
      const headerCells = block.header.cells
        .map((cell) => `<th>${cell.children.map(inlineToHtml).join("")}</th>`)
        .join("");
      const bodyRows = block.rows
        .map(
          (row) =>
            `<tr>${row.cells
              .map(
                (cell) =>
                  `<td>${cell.children.map(inlineToHtml).join("")}</td>`,
              )
              .join("")}</tr>`,
        )
        .join("");
      return `<table class="md-table"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
    }
  }
}

export function mdTreeToHtml(tree: MdDocument): string {
  return tree.children.map(blockToHtml).join("\n");
}

export function renderBlocksToHtml(
  tree: MdDocument,
  from: number,
  to?: number,
): string {
  const end = to ?? tree.children.length;
  return tree.children.slice(from, end).map(blockToHtml).join("\n");
}

export function markdownToHtml(markdown: string): string {
  const tree = parseMarkdown(markdown);
  return mdTreeToHtml(tree);
}

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
      contentLines.push(trimmed.slice(1).trimStart());
      i++;
    } else if (trimmed === "") {
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
      break;
    } else if (items.length > 0) {
      // Non-list line inside a list: treat it as a continuation of the last item.
      const continuation = parseInline(trimmed);
      items[items.length - 1]!.children.push(...continuation);
      i++;
    } else {
      break;
    }
  }

  return { type: "list", ordered, items, _nextIndex: i };
}

function parseTable(
  lines: string[],
  start: number,
): MdTable & { _nextIndex: number } {
  const headerLine = lines[start]!.trim();
  const headerCells = parseTableRowCells(headerLine);

  let i = start + 2; // skip header + delimiter
  const rows: MdTableRow[] = [];

  while (i < lines.length) {
    const trimmed = lines[i]!.trim();

    if (trimmed === "") break;
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
  const stripped = line.trim();
  const inner =
    stripped.startsWith("|") && stripped.endsWith("|")
      ? stripped.slice(1, -1)
      : stripped;

  const rawCells = inner.split("|");
  return rawCells.map((raw) => ({
    children: parseInline(raw.trim()),
  }));
}

function isTableHeaderLine(line: string): boolean {
  if (!line.includes("|")) return false;
  const trimmed = line.trim();
  // Reject pure-dash rows like "|---|---|" -- a header needs real content.
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
  return cells.some((c) => c !== "" && !/^[-:*_]+$/.test(c));
}

function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false;
  const inner = trimmed.slice(1, -1);
  const cells = inner.split("|");
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
    // Stop at block-level elements. The heading regex (not startsWith("#"))
    // keeps bare "#" / "#no-space" as paragraph text; without it, the loop
    // would never advance and infinite-loop.
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

const ESCAPEABLE_CHARS = "\\`*_{}[]()#+-.!|~";

function processInlineEscapes(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (
      text[i] === "\\" &&
      i + 1 < text.length &&
      ESCAPEABLE_CHARS.includes(text[i + 1]!)
    ) {
      result += text[i + 1]!;
      i += 2;
    } else {
      result += text[i]!;
      i++;
    }
  }
  return result;
}

// Underscores adjacent to word chars must not act as emphasis markers.
function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return /[a-zA-Z0-9_]/.test(ch);
}

function findClosingUnderscore(
  text: string,
  marker: string,
  start: number,
): number {
  let idx = text.indexOf(marker, start);
  while (idx !== -1) {
    const after = text[idx + marker.length];
    if (!isWordChar(after)) {
      return idx;
    }
    idx = text.indexOf(marker, idx + 1);
  }
  return -1;
}

function parseInline(text: string): MdInline[] {
  const result: MdInline[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === "\\") {
      const next = text[i + 1];
      if (!next) break; // streaming safety: wait for next chunk
      if (ESCAPEABLE_CHARS.includes(next)) {
        result.push({ type: "text", content: next });
        i += 2;
        continue;
      }
      result.push({ type: "text", content: "\\" });
      i++;
      continue;
    }

    if (text[i] === "`" && !isTripleBacktick(text, i)) {
      // Cap the search window so malformed input can't cause a long scan.
      let end = -1;
      for (let j = i + 1; j < text.length && j < i + 200; j++) {
        if (text[j] === "`") {
          end = j;
          break;
        }
        if (text[j] === "\\" && j + 1 < text.length && text[j + 1] === "`") {
          j++; // skip escaped backtick
        }
      }
      if (end !== -1 && end > i + 1) {
        const rawContent = text.slice(i + 1, end);
        const content = processInlineEscapes(rawContent);
        result.push({ type: "inline_code", content });
        i = end + 1;
        continue;
      }
    }

    if (text[i] === "!" && text[i + 1] === "[") {
      const img = parseImageOrLink(text, i, true);
      if (img) {
        result.push(img.node);
        i = img.endIndex;
        continue;
      }
    }

    if (text[i] === "[") {
      const link = parseImageOrLink(text, i, false);
      if (link) {
        result.push(link.node);
        i = link.endIndex;
        continue;
      }
    }

    if (text.slice(i, i + 3) === "***") {
      const boldItalic = parseEmphasis(text, i, 3, "bold_italic");
      if (boldItalic) {
        result.push(boldItalic.node);
        i = boldItalic.endIndex;
        continue;
      }
    }

    if (text.slice(i, i + 2) === "~~") {
      const strike = parseEmphasis(text, i, 2, "strikethrough");
      if (strike) {
        result.push(strike.node);
        i = strike.endIndex;
        continue;
      }
    }

    if (text.slice(i, i + 2) === "**") {
      const bold = parseEmphasis(text, i, 2, "bold");
      if (bold) {
        result.push(bold.node);
        i = bold.endIndex;
        continue;
      }
    }

    // Word-boundary check keeps "load_skill" from becoming italic.
    if (text[i] === "*" || text[i] === "_") {
      if (text[i] === "_" && isWordChar(text[i - 1])) {
        result.push({ type: "text", content: text[i]! });
        i++;
        continue;
      }
      const italic = parseEmphasis(text, i, 1, "italic");
      if (italic) {
        result.push(italic.node);
        i = italic.endIndex;
        continue;
      }
    }

    const specialChars = "`![*~_\\";
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
    } else if (nextSpecial === i) {
      result.push({ type: "text", content: text[i]! });
      i++;
    } else {
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

  let bracketDepth = 1;
  let closeBracket = openBracket;
  while (closeBracket < text.length && bracketDepth > 0) {
    if (text[closeBracket] === "[") bracketDepth++;
    if (text[closeBracket] === "]") bracketDepth--;
    if (bracketDepth > 0) closeBracket++;
  }

  if (bracketDepth !== 0) return null;

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

  let closeIdx: number;
  if (openMarker === "_" || openMarker === "__") {
    closeIdx = findClosingUnderscore(text, openMarker, openEnd);
  } else {
    closeIdx = text.indexOf(closeMarker, openEnd);
  }

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

function isListLine(trimmed: string): boolean {
  // Bare markers ("*", "-") can appear mid-stream before their text arrives.
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
  return trimmed
    .replace(/^[-*+]\s+/, "")
    .replace(/^[-*+]$/, "")
    .replace(/^\d+[\.\)]\s+/, "")
    .replace(/^\d+[\.\)]$/, "");
}

function isHorizontalRule(trimmed: string): boolean {
  // Must be one character type only, so "* **bold**" or "---text" don't match.
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
