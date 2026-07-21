/// <reference lib="dom" />
// Message rendering — displays all OUTPUT_EVENT types in the chat view.
// Manages a message list per session, with streaming, tool calls, and thinking.

import { sanitize } from "./utils.ts";
import {
  parseMarkdown,
  mdTreeToHtml,
  renderBlocksToHtml,
  createStreamingParser,
  type StreamingMdParser,
  type FeedResult,
  type MdDocument,
} from "../../../utils/md-parser.ts";

// ── Debug instrumentation ───────────────────────────────────────────────────
// Enable via: ?debug=1  in the URL
const DEBUG = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");
let _debugSeq = 0;

function dbg(label: string, data: Record<string, unknown>): void {
  if (!DEBUG) return;
  console.log(`[streaming #${_debugSeq++}] ${label}`, data);
}

function dbgTree(label: string, tree: MdDocument): void {
  if (!DEBUG) return;
  const summary = tree.children.map((b, i) => {
    if (b.type === "code_block") {
      const cb = b as { type: "code_block"; content: string };
      return `[${i}] ${b.type}(${cb.content.slice(0, 30).replace(/\n/g, "\\n")})`;
    }
    if (b.type === "paragraph") {
      const p = b as { type: "paragraph"; children: { type: string; content?: string }[] };
      const text = p.children
        .filter((c) => c.type === "text")
        .map((c) => (c as { content: string }).content)
        .join(" ")
        .slice(0, 40);
      return `[${i}] ${b.type}(${text})`;
    }
    return `[${i}] ${b.type}`;
  }).join(" | ");
  console.log(`[streaming #${_debugSeq++}] ${label}  blocks=${tree.children.length}  ${summary}`);
}

// ── Message event types ─────────────────────────────────────────────────────

interface UserMessage { content: string; }
interface AssistantMessage { content: string; }
interface StreamingChunk { content: string; }
interface ThinkingMessage { content: string; }
interface ToolCallMessage { name: string; args: string; }
interface ToolResultMessage { name: string; output?: string; error?: string; }
interface CompactingMessage { message: string; }
interface CommandResultMessage { content: string; }

interface QuestionOption {
  message?: string;
  prompt?: string;
  options?: string[];
}
interface QuestionMessage { questions: QuestionOption[]; }

interface TaskProgressMessage { taskId: string; status: string; message?: string; }

interface TokenUsageMessage {
  lastCachedTokens: number;
  lastPromptTokens: number;
  lastCompletionTokens: number;
  lastTotalTokens: number;
}

interface CompactionResultMessage { summary: string; messagesCompacted: number; }
interface SessionStateMessage { key: string; value: unknown; }
interface ErrorMessage { message: string; }

// ── Options ─────────────────────────────────────────────────────────────────

interface MessageListOptions {
  hideThinking?: boolean;
}

// ── Return type ─────────────────────────────────────────────────────────────

export interface MessageListManager {
  handleUserMessage: (data: UserMessage) => void;
  handleAssistantMessage: (data: AssistantMessage) => void;
  handleStreamingChunk: (data: StreamingChunk) => void;
  handleStreamingReasoningChunk: (data: StreamingChunk) => void;
  handleThinking: (data: ThinkingMessage) => void;
  handleToolCall: (data: ToolCallMessage) => void;
  handleToolResult: (data: ToolResultMessage) => void;
  handleCompacting: (data: CompactingMessage) => void;
  handleCommandResult: (data: CommandResultMessage) => void;
  handleQuestion: (data: QuestionMessage) => void;
  handleTaskProgress: (data: TaskProgressMessage) => void;
  handleTokenUsage: (data: TokenUsageMessage) => void;
  handleCompactionResult: (data: CompactionResultMessage) => void;
  handleSessionState: (data: SessionStateMessage) => void;
  handleError: (data: ErrorMessage) => void;
  finalizeAssistant: () => void;
  clear: () => void;
}

/**
 * Create a message list manager for a single session.
 * @param sessionId - The session identifier
 * @param options - Display options
 * @returns Message list manager with handlers for each message type
 */
export function createMessageList(
  _sessionId: string,
  { hideThinking = false }: MessageListOptions = {},
): MessageListManager {
  const container = document.getElementById("message-list") as HTMLDivElement;
  let currentAssistantEl: HTMLDivElement | null = null;
  let currentThinkingEl: HTMLDivElement | null = null;
  let currentToolCalls: HTMLDivElement[] = [];
  let hasToolCallsSinceLastAssistant = false;
  let hideThinkingValue = hideThinking;

  // Streaming markdown parsers — one for assistant content, one for thinking
  let streamingParser: StreamingMdParser | null = null;
  let thinkingParser: StreamingMdParser | null = null;
  // Track how many blocks have been rendered in each content div
  let streamingBlockCount = 0;
  let thinkingBlockCount = 0;

  function ensureAssistantEl(): HTMLDivElement {
    if (!currentAssistantEl) {
      currentAssistantEl = document.createElement("div");
      currentAssistantEl.className = "message assistant streaming";

      // Avatar
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = "🤖";
      currentAssistantEl.appendChild(avatar);

      // Bubble
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      const contentEl = document.createElement("div");
      contentEl.className = "content md-content";
      bubble.appendChild(contentEl);
      currentAssistantEl.appendChild(bubble);

      container.appendChild(currentAssistantEl);
    }
    return currentAssistantEl;
  }

  function ensureThinkingEl(): HTMLDivElement {
    if (!currentThinkingEl) {
      currentThinkingEl = document.createElement("div");
      currentThinkingEl.className = "thinking-block md-content";
      if (hideThinkingValue) currentThinkingEl.classList.add("hidden");
      container.appendChild(currentThinkingEl);
    }
    return currentThinkingEl;
  }

  /** Show/hide thinking blocks. */
  function setHideThinking(v: boolean): void {
    hideThinkingValue = v;
    if (currentThinkingEl) {
      currentThinkingEl.classList.toggle("hidden", v);
    }
  }

  /**
   * Incrementally update a content div's DOM from a streaming feed result.
   * Only re-renders blocks from `stableFrom` onward, leaving the stable
   * prefix untouched so the browser doesn't reflow the entire message.
   *
   * @param contentDiv — The target .content div
   * @param result — The FeedResult from StreamingMdParser.feed()
   * @param blockCountRef — Mutable ref tracking current rendered block count
   */
  function updateMdDom(
    contentDiv: HTMLDivElement,
    result: FeedResult,
    blockCountRef: { count: number },
  ): void {
    const { tree, stableFrom } = result;
    const totalBlocks = tree.children.length;

    // Clamp stableFrom to what we've actually rendered
    const effectiveStable = Math.min(stableFrom, blockCountRef.count);

    dbg("updateMdDom", {
      stableFrom,
      prevBlockCount: blockCountRef.count,
      totalBlocks,
      effectiveStable,
      willRemove: blockCountRef.count - effectiveStable,
      willRender: Math.max(0, totalBlocks - effectiveStable),
    });
    dbgTree("updateMdDom tree", tree);

    // Remove DOM nodes for blocks from effectiveStable onward
    let removed = 0;
    for (let i = effectiveStable; i < blockCountRef.count; i++) {
      const el = contentDiv.querySelector(`[data-block-index="${i}"]`);
      if (el) { el.remove(); removed++; }
    }

    // Render and append new/changed blocks
    let rendered = 0;
    if (effectiveStable < totalBlocks) {
      const html = renderBlocksToHtml(tree, effectiveStable);
      const fragment = document.createDocumentFragment();
      const wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      while (wrapper.firstChild) {
        fragment.appendChild(wrapper.firstChild);
      }

      // Tag each child with its block index for future diffs
      const newStart = effectiveStable;
      const children = Array.from(fragment.children);
      for (let i = 0; i < children.length; i++) {
        (children[i] as HTMLElement).dataset.blockIndex = String(newStart + i);
      }

      contentDiv.appendChild(fragment);
      rendered = children.length;
      blockCountRef.count = newStart + children.length;
    }
    // Always sync the count to the actual tree size so that when the
    // tree shrinks (e.g. paragraph + unclosed code block → single code
    // block on closing fence), subsequent diffs use the correct baseline.
    blockCountRef.count = totalBlocks;

    dbg("updateMdDom done", { removed, rendered, finalBlockCount: totalBlocks });
  }

  // ── Message Handlers ──────────────────────────────────────────────────────

  function handleUserMessage({ content }: UserMessage): void {
    finalizeAssistant();
    const el = document.createElement("div");
    el.className = "message user";

    // Avatar
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "👤";
    el.appendChild(avatar);

    // Bubble
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const contentEl = document.createElement("div");
    contentEl.className = "content";
    contentEl.textContent = content;
    bubble.appendChild(contentEl);
    el.appendChild(bubble);

    container.appendChild(el);
    scrollBottom();
  }

  function handleAssistantMessage({ content }: AssistantMessage): void {
    if (!content?.trim()) return; // skip empty messages (e.g. tool-only turns during replay)
    finalizeAssistant();
    const el = document.createElement("div");
    el.className = "message assistant";

    // Avatar
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "🤖";
    el.appendChild(avatar);

    // Bubble
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const contentEl = document.createElement("div");
    contentEl.className = "content md-content";
    const tree = parseMarkdown(content);
    contentEl.innerHTML = mdTreeToHtml(tree);
    bubble.appendChild(contentEl);
    el.appendChild(bubble);

    container.appendChild(el);
    scrollBottom();
  }

  function handleStreamingChunk({ content }: StreamingChunk): void {
    // If we've had tool calls since the last assistant message, start a new
    // assistant element so tool calls appear sequentially before the final text.
    if (hasToolCallsSinceLastAssistant) {
      finalizeAssistant();
      hasToolCallsSinceLastAssistant = false;
    }
    const el = ensureAssistantEl();
    const contentDiv = el.querySelector(".content") as HTMLDivElement;

    // Initialize streaming parser on first chunk
    if (!streamingParser) {
      streamingParser = createStreamingParser();
    }

    // Feed the chunk — get tree + stable prefix index
    dbg("handleStreamingChunk", { chunkLen: content.length, chunkPreview: content.slice(0, 60).replace(/\n/g, "\\n"), prevBlockCount: streamingBlockCount });
    const result = streamingParser.feed(content);
    dbg("handleStreamingChunk after feed", { stableFrom: result.stableFrom, treeBlocks: result.tree.children.length });
    updateMdDom(contentDiv, result, { count: streamingBlockCount });
    streamingBlockCount = result.tree.children.length;
    scrollBottom();
  }

  function handleStreamingReasoningChunk({ content }: StreamingChunk): void {
    const el = ensureThinkingEl();

    if (!thinkingParser) {
      thinkingParser = createStreamingParser();
    }

    dbg("handleStreamingReasoningChunk", { chunkLen: content.length, chunkPreview: content.slice(0, 60).replace(/\n/g, "\\n"), prevBlockCount: thinkingBlockCount });
    const result = thinkingParser.feed(content);
    dbg("handleStreamingReasoningChunk after feed", { stableFrom: result.stableFrom, treeBlocks: result.tree.children.length });
    updateMdDom(el, result, { count: thinkingBlockCount });
    thinkingBlockCount = result.tree.children.length;
    scrollBottom();
  }

  function handleThinking({ content }: ThinkingMessage): void {
    // Final thinking block (non-streaming)
    const el = ensureThinkingEl();
    const tree = parseMarkdown(content);
    el.innerHTML = mdTreeToHtml(tree);
  }

  function handleToolCall({ name, args }: ToolCallMessage): void {
    // Finalize the current assistant message so tool calls appear as
    // separate blocks after the user message, not nested inside the assistant.
    finalizeAssistant();

    const block = document.createElement("div");
    block.className = "tool-call-block";

    const header = document.createElement("div");
    header.className = "tool-call-header";
    header.innerHTML = `<span>🛠 ${sanitize(name)}</span><span>${sanitize(args)}</span>`;

    const body = document.createElement("div");
    body.className = "tool-call-body hidden";
    body.textContent = args;

    header.addEventListener("click", () => {
      // When expanding, show the full tool output (not truncated preview)
      const isHidden = body.classList.contains("hidden");
      if (isHidden && body.dataset.fullOutput) {
        body.textContent = body.dataset.fullOutput;
      }
      body.classList.toggle("hidden");
    });

    block.appendChild(header);
    block.appendChild(body);
    container.appendChild(block);

    currentToolCalls.push(block);
    hasToolCallsSinceLastAssistant = true;
    scrollBottom();
  }

  function handleToolResult({ name, output, error }: ToolResultMessage): void {
    // Find the last tool call block for this tool and add result
    const blocks = container.querySelectorAll<HTMLDivElement>(".tool-call-block");
    let target: HTMLDivElement | null = null;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const hdr = blocks[i]!.querySelector(".tool-call-header span");
      if (hdr && hdr.textContent?.includes(name)) {
        target = blocks[i]!;
        break;
      }
    }
    if (!target) return;

    const body = target.querySelector<HTMLDivElement>(".tool-call-body");
    if (body) {
      // Store the full output on the body element for toggling
      const fullOutput = output || error || "";
      body.dataset.fullOutput = fullOutput;
      body.dataset.truncated = "true";

      // Show truncated preview in the body, but keep it hidden until clicked
      if (output)
        body.textContent =
          output.slice(0, 2000) + "\n\n<click to show full response>";
      else if (error) body.textContent = `Error: ${error}`;
      // Don't auto-show the body — let the user click to expand
    }
    scrollBottom();
  }

  function handleCompacting({ message }: CompactingMessage): void {
    // Show compacting notice
    const el = document.createElement("div");
    el.className = "message compacting";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = `⚡ ${message}`;
    el.appendChild(bubble);
    container.appendChild(el);
    scrollBottom();
  }

  function handleCommandResult({ content }: CommandResultMessage): void {
    const el = document.createElement("div");
    el.className = "message command-result";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const contentEl = document.createElement("div");
    contentEl.className = "content";
    contentEl.textContent = content;
    bubble.appendChild(contentEl);
    el.appendChild(bubble);
    container.appendChild(el);
    scrollBottom();
  }

  function handleQuestion({ questions }: QuestionMessage): void {
    finalizeAssistant();
    const el = document.createElement("div");
    el.className = "message question";

    // Avatar
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "🤖";
    el.appendChild(avatar);

    // Bubble
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const contentEl = document.createElement("div");
    contentEl.className = "content";
    contentEl.innerHTML = `<strong>Question:</strong><br>`;
    for (const q of questions) {
      contentEl.innerHTML += `${sanitize(q.message || q.prompt)}<br>`;
      if (q.options) {
        for (const opt of q.options) {
          contentEl.innerHTML += `  • ${sanitize(opt)}<br>`;
        }
      }
    }
    bubble.appendChild(contentEl);
    el.appendChild(bubble);
    container.appendChild(el);
    scrollBottom();
  }

  function handleTaskProgress({ taskId, status, message }: TaskProgressMessage): void {
    // Task progress — subtle indicator
    let el = container.querySelector<HTMLDivElement>(
      `.task-progress[data-task-id="${sanitize(taskId)}"]`,
    );
    if (!el) {
      el = document.createElement("div");
      el.className = "message task-progress";
      el.dataset.taskId = taskId;
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = `⚡ ${status}${message ? ": " + message : ""}`;
      el.appendChild(bubble);
      container.appendChild(el);
    } else {
      const bubble = el.querySelector<HTMLDivElement>(".bubble");
      if (bubble) {
        bubble.textContent = `⚡ ${status}${message ? ": " + message : ""}`;
      }
    }
    scrollBottom();
  }

  function handleTokenUsage({
    lastCachedTokens,
    lastPromptTokens,
    lastCompletionTokens,
    lastTotalTokens,
  }: TokenUsageMessage): void {
    const el = document.createElement("div");
    el.className = "message token-usage";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = `(tokens cached: ${lastCachedTokens} prompt:${lastPromptTokens} completion:${lastCompletionTokens} total:${lastTotalTokens})`;
    el.appendChild(bubble);
    container.appendChild(el);
    scrollBottom();
  }

  function handleCompactionResult({ summary, messagesCompacted }: CompactionResultMessage): void {
    const el = document.createElement("div");
    el.className = "message compaction-result";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = `Compacted ${messagesCompacted} messages. Summary: ${summary}`;
    el.appendChild(bubble);
    container.appendChild(el);
    scrollBottom();
  }

  function handleSessionState({ key, value }: SessionStateMessage): void {
    if (key === "hideThinking") {
      setHideThinking(Boolean(value));
    }
  }

  function handleError({ message }: ErrorMessage): void {
    finalizeAssistant();
    const el = document.createElement("div");
    el.className = "message error";

    // Avatar
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "⚠️";
    el.appendChild(avatar);

    // Bubble
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const contentEl = document.createElement("div");
    contentEl.className = "content";
    contentEl.textContent = `Error: ${sanitize(message)}`;
    bubble.appendChild(contentEl);
    el.appendChild(bubble);

    container.appendChild(el);
    scrollBottom();
  }

  /** Finalize the current streaming assistant message. */
  function finalizeAssistant(): void {
    dbg("finalizeAssistant", { hadAssistant: !!currentAssistantEl, streamingBlockCount, thinkingBlockCount });
    if (currentAssistantEl) {
      currentAssistantEl.classList.remove("streaming");
      currentAssistantEl = null;
    }
    currentThinkingEl = null;
    currentToolCalls = [];
    hasToolCallsSinceLastAssistant = false;
    streamingParser = null;
    thinkingParser = null;
    streamingBlockCount = 0;
    thinkingBlockCount = 0;
  }

  function scrollBottom(): void {
    // Only auto-scroll if the user is within 150px of the bottom,
    // so they can scroll up to view history without being yanked down.
    const threshold = 150;
    const distFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distFromBottom <= threshold) {
      container.scrollTop = container.scrollHeight;
    }
  }

  function clear(): void {
    container.innerHTML = "";
    currentAssistantEl = null;
    currentThinkingEl = null;
    currentToolCalls = [];
    hasToolCallsSinceLastAssistant = false;
    streamingParser = null;
    thinkingParser = null;
    streamingBlockCount = 0;
    thinkingBlockCount = 0;
  }

  return {
    handleUserMessage,
    handleAssistantMessage,
    handleStreamingChunk,
    handleStreamingReasoningChunk,
    handleThinking,
    handleToolCall,
    handleToolResult,
    handleCompacting,
    handleCommandResult,
    handleQuestion,
    handleTaskProgress,
    handleTokenUsage,
    handleCompactionResult,
    handleSessionState,
    handleError,
    finalizeAssistant,
    clear,
  };
}
