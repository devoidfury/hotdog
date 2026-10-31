/// <reference lib="dom" />
// Per-session message list: renders OUTPUT_EVENTs, incl. streaming markdown.

import { sanitize, resolveQuestionAnswer, formatTokenCount } from "./utils.ts";
import {
  parseMarkdown,
  mdTreeToHtml,
  renderBlocksToHtml,
  createStreamingParser,
  type StreamingMdParser,
  type FeedResult,
  type MdDocument,
} from "@utils/md-parser.ts";
import { toolContentText, wrapperContentText, splitFileIncludes } from "@utils/tool-content.ts";
import { ToolBlockController } from "./tool-block.tsx";
import type { DomNode } from "@utils/jsx";

// Debug instrumentation, enabled with ?debug=1 in the URL.
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

// Image payload on the wire (see wireImages in @extensions/websocket/
// protocol.ts): base64 without data: prefix; oversized images arrive as
// { skipped, note } with no data.
export interface UiImage {
  mimeType: string;
  data?: string;
  skipped?: boolean;
  note?: string;
}

interface UserMessage { content: string; images?: UiImage[]; files?: Array<{ path: string; content: string }>; }
interface AssistantMessage { content: string; }
interface StreamingChunk { content: string; }
interface ThinkingMessage { content: string; }
interface ToolCallMessage { name: string; args: string; argsSummary?: string; toolCallId?: string; }
interface ToolResultMessage { name: string; output?: string; error?: string; images?: UiImage[]; toolCallId?: string; }
interface CompactingMessage { message: string; }
interface CommandResultMessage { content: string; }

// Log entry as returned by the server's logViewed message.
// `content` may be raw content parts (harness messages); flatten via wrapperContentText().
interface LogEntry {
  source: string;
  content: string | Array<Record<string, unknown>>;
  images?: UiImage[];
  reasoning_content?: string | null;
  tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }> | null;
  tool_call_id?: string | null;
}

interface QuestionOption {
  key?: string;
  message?: string;
  prompt?: string;
  options?: string[];
  default?: string;
  required?: boolean;
  allowOther?: boolean;
}
interface QuestionMessage { questions: QuestionOption[]; }
interface QuestionAnsweredMessage {
  sessionId?: string;
  answers: Record<string, string>;
}
/** Question fields after normalizing aliases and defaults. */
interface NormalizedQuestion {
  key: string;
  prompt: string;
  options: string[];
  default?: string;
  required?: boolean;
  allowOther?: boolean;
}

interface TaskProgressMessage { taskId: string; status: string; message?: string; }

interface TokenUsageMessage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow?: number;
}

interface CompactionResultMessage { summary?: string; messagesCompacted: number; }
interface SessionStateMessage { key: string; value: string | string[] | boolean | number; }
interface ErrorMessage { message: string; }

interface MessageListOptions {
  hideThinking?: boolean;
  /** When set, question messages render as an interactive form. */
  onQuestionAnswer?: (answers: Record<string, string>) => void;
}

export interface MessageListManager {
  handleUserMessage: (data: UserMessage) => void;
  handleAssistantMessage: (data: AssistantMessage) => void;
  handleStreamingChunk: (data: StreamingChunk) => void;
  handleStreamingReasoningChunk: (data: StreamingChunk) => void;
  /** Mid-stream provider-failure retry: drop the in-flight text/thinking
   * accumulators so the retry's deltas render into fresh renderers. */
  handleStreamReset: () => void;
  handleThinking: (data: ThinkingMessage) => void;
  handleToolCall: (data: ToolCallMessage) => void;
  handleToolResult: (data: ToolResultMessage) => void;
  handleCompacting: (data: CompactingMessage) => void;
  handleCommandResult: (data: CommandResultMessage) => void;
  handleQuestion: (data: QuestionMessage) => void;
  handleQuestionAnswered: (data: QuestionAnsweredMessage) => void;
  handleTaskProgress: (data: TaskProgressMessage) => void;
  handleTokenUsage: (data: TokenUsageMessage) => void;
  handleCompactionResult: (data: CompactionResultMessage) => void;
  handleSessionState: (data: SessionStateMessage) => void;
  handleError: (data: ErrorMessage) => void;
  finalizeAssistant: () => void;
  clear: () => void;
  /** Append a system notice (e.g. profile switched). Input must be a trusted display name. */
  addSystemMessage: (text: string) => void;
  /** Render a server system message (profile switched, tool-call repair notices, ...). */
  handleSystemMessage: (data: { content?: string; files?: Array<{ path: string; content: string }> }) => void;
  /** Detach the container's scroll listener. The #message-list div outlives the chat across logins, so the owner must call this before dropping the manager. */
  destroy: () => void;
  /** Render a batch of session log entries (for viewing cold session logs). */
  renderLogEntries: (entries: LogEntry[]) => void;
}

export function createMessageList(
  container: HTMLElement,
  { hideThinking = false, onQuestionAnswer }: MessageListOptions = {},
): MessageListManager {
  let currentAssistantEl: HTMLDivElement | null = null;
  let currentThinkingEl: HTMLDivElement | null = null;
  // Tool-call/result pairing: by tool-call id when the wire carries one,
  // else the oldest unresolved call with the same name (id-less log replay).
  const toolBlocksById = new Map<string, ToolBlockController>();
  const pendingToolCallsByName = new Map<string, ToolBlockController[]>();
  let hasToolCallsSinceLastAssistant = false;
  let hideThinkingValue = hideThinking;

  let streamingParser: StreamingMdParser | null = null;
  let thinkingParser: StreamingMdParser | null = null;
  let streamingBlockCount = 0;
  let thinkingBlockCount = 0;

  function ensureAssistantEl(): HTMLDivElement {
    if (!currentAssistantEl) {
      currentAssistantEl = document.createElement("div");
      currentAssistantEl.className = "message assistant streaming";

      const bubble = document.createElement("div");
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

    let removed = 0;
    for (let i = effectiveStable; i < blockCountRef.count; i++) {
      const el = contentDiv.querySelector(`[data-block-index="${i}"]`);
      if (el) { el.remove(); removed++; }
    }

    let rendered = 0;
    if (effectiveStable < totalBlocks) {
      const html = renderBlocksToHtml(tree, effectiveStable);
      const fragment = document.createDocumentFragment();
      const wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      while (wrapper.firstChild) {
        fragment.appendChild(wrapper.firstChild);
      }

      // Index each block so future diffs can target it.
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

  // ── Images ────────────────────────────────────────────────────────────────
  /**
   * Append image payloads to a message block as data-URL thumbnails (click
   * toggles full size). Built with createElement + setAttribute, never
   * innerHTML, so no markup ever comes from the wire; mimeTypes that are not
   * images are rejected outright (a data: URL is still a URL).
   */
  function appendImages(parent: HTMLElement, images?: UiImage[]): void {
    if (!images || images.length === 0) return;
    const wrap = document.createElement("div");
    wrap.className = "message-images";
    for (const img of images) {
      if (img.skipped || !img.data) {
        const note = document.createElement("div");
        note.className = "image-skipped";
        note.textContent = img.note || "image not displayed";
        wrap.appendChild(note);
        continue;
      }
      if (!img.mimeType.startsWith("image/")) {
        const note = document.createElement("div");
        note.className = "image-skipped";
        note.textContent = `unsupported image type: ${img.mimeType}`;
        wrap.appendChild(note);
        continue;
      }
      const el = document.createElement("img");
      el.className = "message-image";
      el.setAttribute("src", `data:${img.mimeType};base64,${img.data}`);
      el.setAttribute("loading", "lazy");
      el.addEventListener("click", () => el.classList.toggle("fullsize"));
      wrap.appendChild(el);
    }
    parent.appendChild(wrap);
  }

  // ── Message Handlers ──────────────────────────────────────────────────────
  function handleUserMessage({ content, images, files }: UserMessage): void {
    // Close any in-flight assistant/thinking element first in case an interruption occurred;
    // without this the next turn's streaming chunks resume the stale element above this message.
    finalizeAssistant();

    const el = document.createElement("div");
    el.className = "message user";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const contentEl = document.createElement("div");
    contentEl.className = "content";
    contentEl.textContent = content;
    bubble.appendChild(contentEl);
    appendImages(bubble, images);
    appendAttachments(bubble, files);
    el.appendChild(bubble);

    container.appendChild(el);
    scrollBottom();
  }

  /** One collapsible box per attached file: path as summary, escaped content inside. */
  function appendAttachments(bubble: HTMLElement, files?: Array<{ path: string; content: string }>): void {
    if (!files || files.length === 0) return;
    for (const f of files) {
      const box = document.createElement("details");
      box.className = "attachment-box";
      box.innerHTML =
        `<summary>${sanitize(f.path)}</summary>` +
        `<pre class="attachment-content">${sanitize(f.content)}</pre>`;
      bubble.appendChild(box);
    }
  }

  function handleAssistantMessage({ content }: AssistantMessage): void {
    if (!content?.trim()) return; // skip empty messages (e.g. tool-only turns during replay)
    finalizeAssistant();
    const el = document.createElement("div");
    el.className = "message assistant";

    const bubble = document.createElement("div");
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

    if (!streamingParser) {
      streamingParser = createStreamingParser();
    }

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

  /**
   * The transport re-issued a request after a mid-stream failure: everything
   * the failed attempt streamed (assistant text AND thinking, plus any
   * hasToolCallsSinceLastAssistant flag from its tool-call phase) is dead --
   * the retry re-streams from scratch and the assembled message will contain
   * none of it. Drop both in-flight renderers outright (NOT
   * finalizeAssistant: dead text must not be committed as a kept message).
   * Sanitizer path untouched: the retry's chunks still flow through
   * StreamingMdParser + renderBlocksToHtml exactly as before; nothing here
   * writes markup. Tool blocks are untouched (a reset precedes tool results).
   */
  function handleStreamReset(): void {
    dbg("handleStreamReset", {
      hadAssistant: !!currentAssistantEl,
      hadThinking: !!currentThinkingEl,
      streamingBlockCount,
      thinkingBlockCount,
    });
    if (currentAssistantEl) currentAssistantEl.remove();
    currentAssistantEl = null;
    if (currentThinkingEl) currentThinkingEl.remove();
    currentThinkingEl = null;
    hasToolCallsSinceLastAssistant = false;
    streamingParser = null;
    thinkingParser = null;
    streamingBlockCount = 0;
    thinkingBlockCount = 0;
  }

  function handleThinking({ content }: ThinkingMessage): void {
    const el = ensureThinkingEl();
    const tree = parseMarkdown(content);
    el.innerHTML = mdTreeToHtml(tree);
  }

  function handleToolCall({ name, args, argsSummary, toolCallId }: ToolCallMessage): void {
    // Finalize the current assistant message so tool calls appear as
    // separate blocks after the user message, not nested inside the assistant.
    finalizeAssistant();

    const host = document.createElement("div");
    container.appendChild(host);
    const block = new ToolBlockController(host as unknown as DomNode, { name, args, argsSummary });
    if (toolCallId) toolBlocksById.set(toolCallId, block);
    const queue = pendingToolCallsByName.get(name);
    if (queue) queue.push(block);
    else pendingToolCallsByName.set(name, [block]);

    hasToolCallsSinceLastAssistant = true;
    scrollBottom();
  }

  function handleToolResult({ name, output, error, images, toolCallId }: ToolResultMessage): void {
    // Pair by tool-call id first; without one (old logs), fall back to the
    // oldest unresolved call of the same name.
    let block = toolCallId ? toolBlocksById.get(toolCallId) : undefined;
    if (block && toolCallId) {
      toolBlocksById.delete(toolCallId);
      const queue = pendingToolCallsByName.get(name);
      if (queue) {
        const at = queue.indexOf(block);
        if (at !== -1) queue.splice(at, 1);
      }
    }
    if (!block) {
      const queue = pendingToolCallsByName.get(name);
      block = queue && queue.length > 0 ? queue.shift() : undefined;
    }
    if (!block) return; // orphan result: no matching call to attach to

    block.setResult({
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(images ? { images } : {}),
    });
    scrollBottom();
  }

  function handleCompacting({ message }: CompactingMessage): void {
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

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const contentEl = document.createElement("div");
    contentEl.className = "content";

    const normalized = questions.map((q, i) => ({
      key: q.key || `question_${i}`,
      prompt: q.message || q.prompt || "",
      options: q.options || [],
      default: q.default,
      required: q.required,
      allowOther: q.allowOther,
    }));

    // Without an answer callback (e.g. cold log replay) render read-only.
    if (!onQuestionAnswer) {
      contentEl.innerHTML = `<strong>Question:</strong><br>`;
      for (const q of normalized) {
        contentEl.innerHTML += `${sanitize(q.prompt)}<br>`;
        for (const opt of q.options) {
          contentEl.innerHTML += `  • ${sanitize(opt)}<br>`;
        }
      }
      bubble.appendChild(contentEl);
      el.appendChild(bubble);
      container.appendChild(el);
      scrollBottom();
      return;
    }

    buildQuestionCard(contentEl, normalized);
    bubble.appendChild(contentEl);
    el.appendChild(bubble);
    container.appendChild(el);
    scrollBottom();
  }

  /**
   * Build an interactive question form into contentEl; on submit calls
   * onQuestionAnswer(answers) and marks the card answered.
   */
  function buildQuestionCard(
    contentEl: HTMLElement,
    normalized: NormalizedQuestion[],
  ): void {
    const card = document.createElement("div");
    card.className = "question-card";

    const selections = new Map<
      string,
      { text: string; selectedOption: string | null }
    >();
    const items: Array<{
      q: NormalizedQuestion;
      textEl: HTMLInputElement | null;
      optEls: HTMLButtonElement[];
      errEl: HTMLDivElement;
    }> = [];

    for (const q of normalized) {
      const item = document.createElement("div");
      item.className = "q-item";

      const promptEl = document.createElement("div");
      promptEl.className = "q-prompt";
      promptEl.textContent = q.prompt + (q.required !== false ? " *" : " (optional)");
      item.appendChild(promptEl);

      const sel = {
        text: "",
        selectedOption:
          q.default && q.options.includes(q.default) ? q.default : null,
      };
      selections.set(q.key, sel);

      const optWrap = document.createElement("div");
      optWrap.className = "q-options";

      const optEls: HTMLButtonElement[] = [];
      for (const opt of q.options) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "q-option";
        if (sel.selectedOption === opt) btn.classList.add("selected");
        btn.textContent = opt;
        btn.addEventListener("click", () => {
          sel.selectedOption = opt;
          sel.text = "";
          if (textEl) textEl.value = "";
          for (const b of optEls) b.classList.toggle("selected", b === btn);
        });
        optWrap.appendChild(btn);
        optEls.push(btn);
      }

      let textEl: HTMLInputElement | null = null;
      if (q.allowOther !== false) {
        textEl = document.createElement("input");
        textEl.type = "text";
        textEl.className = "q-text";
        textEl.placeholder = q.default ? `default: ${q.default}` : "Your answer…";
        textEl.addEventListener("input", () => {
          sel.text = textEl!.value;
          if (sel.text.trim()) {
            sel.selectedOption = null;
            for (const b of optEls) b.classList.remove("selected");
          }
        });
        optWrap.appendChild(textEl);
      }

      item.appendChild(optWrap);

      const errEl = document.createElement("div");
      errEl.className = "q-error";
      item.appendChild(errEl);

      card.appendChild(item);
      items.push({ q, textEl, optEls, errEl });
    }

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "q-submit";
    submitBtn.textContent = "Submit answers";
    submitBtn.addEventListener("click", () => {
      const answers: Record<string, string> = {};
      let ok = true;
      for (const ref of items) {
        const { value, error } = resolveQuestionAnswer(ref.q, {
          text: ref.textEl?.value ?? "",
          selectedOption: selections.get(ref.q.key)?.selectedOption ?? null,
        });
        ref.errEl.textContent = error || "";
        if (error) {
          ok = false;
        } else {
          answers[ref.q.key] = value;
        }
      }
      if (!ok) return;
      onQuestionAnswer!(answers);
      markQuestionAnswered(card, answers);
    });
    card.appendChild(submitBtn);
    contentEl.appendChild(card);
  }

  /** Disable all controls on a card and show the submitted answers. */
  function markQuestionAnswered(
    card: HTMLElement,
    answers: Record<string, string>,
  ): void {
    if (card.classList.contains("answered")) return;
    card.classList.add("answered");
    Array.from(
      card.querySelectorAll<HTMLButtonElement>("button"),
    ).forEach((btn) => {
      btn.disabled = true;
    });
    Array.from(card.querySelectorAll<HTMLInputElement>("input")).forEach(
      (input) => {
        input.disabled = true;
      },
    );
    const summary = document.createElement("div");
    summary.className = "q-answers";
    // textContent is injection-safe; no HTML escaping needed (or wanted).
    const parts = Object.entries(answers).map(
      ([k, v]) => `${k}: ${v || "(empty)"}`,
    );
    summary.textContent = `Answered — ${parts.join("; ")}`;
    card.appendChild(summary);
  }

  function handleQuestionAnswered({ answers }: QuestionAnsweredMessage): void {
    // Resolve pending forms in this session's list (multi-tab case).
    container
      .querySelectorAll<HTMLElement>(".question-card:not(.answered)")
      .forEach((card) => {
        markQuestionAnswered(card, answers);
      });
  }

  function handleTaskProgress({ taskId, status, message }: TaskProgressMessage): void {
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
    promptTokens,
    cachedTokens,
    completionTokens,
    totalTokens,
    contextWindow,
  }: TokenUsageMessage): void {
    const el = document.createElement("div");
    el.className = "message token-usage";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const denom = typeof contextWindow === "number" && Number.isFinite(contextWindow)
      ? "/" + formatTokenCount(contextWindow)
      : "";
    bubble.textContent = `(tokens cached: ${formatTokenCount(cachedTokens)} prompt:${formatTokenCount(promptTokens)} completion:${formatTokenCount(completionTokens)} total:${formatTokenCount(totalTokens)}${denom})`;
    el.appendChild(bubble);
    container.appendChild(el);
    scrollBottom();
  }

  function handleCompactionResult({ summary, messagesCompacted }: CompactionResultMessage): void {
    const el = document.createElement("div");
    el.className = "message compaction-result";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    // Strategies without a summary (pass-the-baton, drop, trim) omit the
    // field; never render "Summary: null".
    bubble.textContent = summary
      ? `Compacted ${messagesCompacted} messages. Summary: ${summary}`
      : `Compacted ${messagesCompacted} messages.`;
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

  function finalizeAssistant(): void {
    dbg("finalizeAssistant", { hadAssistant: !!currentAssistantEl, streamingBlockCount, thinkingBlockCount });
    if (currentAssistantEl) {
      // Drop empty assistant elements (e.g. tool-only turns).
      const contentDiv = currentAssistantEl.querySelector(".content") as HTMLDivElement;
      const hasContent = contentDiv && contentDiv.textContent?.trim().length > 0;
      if (!hasContent) {
        currentAssistantEl.remove();
      } else {
        currentAssistantEl.classList.remove("streaming");
      }
      currentAssistantEl = null;
    }
    if (currentThinkingEl && !currentThinkingEl.textContent?.trim()) {
      currentThinkingEl.remove();
    }
    currentThinkingEl = null;
    hasToolCallsSinceLastAssistant = false;
    streamingParser = null;
    thinkingParser = null;
    streamingBlockCount = 0;
    thinkingBlockCount = 0;
  }

  // Auto-scroll follow state: the view stays pinned to the bottom unless the
  // user has scrolled up (within 150px of the bottom counts as "at bottom").
  // Checking distance after append would block follow whenever a single
  // message is taller than the threshold — e.g. a long history replay on
  // load, which would otherwise leave the view stuck at the top.
  let followBottom = true;
  const onScroll = () => {
    const distFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    followBottom = distFromBottom <= 150;
  };
  container.addEventListener("scroll", onScroll);

  function scrollBottom(): void {
    if (followBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }

  /** Tear down every live tool-block mount (the DOM is dropped by the caller). */
  function destroyToolBlocks(): void {
    for (const block of toolBlocksById.values()) block.destroy();
    for (const queue of pendingToolCallsByName.values()) {
      for (const block of queue) block.destroy();
    }
    toolBlocksById.clear();
    pendingToolCallsByName.clear();
  }

  function clear(): void {
    container.innerHTML = "";
    followBottom = true;
    currentAssistantEl = null;
    currentThinkingEl = null;
    destroyToolBlocks();
    hasToolCallsSinceLastAssistant = false;
    streamingParser = null;
    thinkingParser = null;
    streamingBlockCount = 0;
    thinkingBlockCount = 0;
  }

  /** Best-effort tool name from a tool_result entry: stored part, then JSON "name", then "tool: ..." prefix. */
  function extractToolNameFromEntry(entry: LogEntry | string): string {
    // A stored tool-result part names its own tool.
    if (typeof entry !== "string" && Array.isArray(entry.content)) {
      for (const part of entry.content) {
        if (part && typeof part === "object" && (part as Record<string, unknown>).type === "tool-result") {
          const tool = (part as Record<string, unknown>).tool;
          if (typeof tool === "string" && tool) return tool;
        }
      }
    }
    const content = typeof entry === "string" ? entry : toolContentText(entry.content);
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && "name" in parsed) {
        return String(parsed.name);
      }
    } catch {
      // Not JSON.
    }
    const match = content.match(/^(\w+):\s/);
    if (match) return match[1] ?? "tool";
    return "tool";
  }

  /**
   * Render a batch of session log entries into the message list.
   * Used for viewing cold session logs in read-only mode.
   */
  function renderLogEntries(entries: LogEntry[]): void {
    for (const entry of entries) {
      // content may be raw parts (harness messages); flatten once per entry.
      const isTool = entry.source === "tool_result";
      const content =
        entry.content == null
          ? ""
          : typeof entry.content === "string"
            ? entry.content
            : isTool
              ? toolContentText(entry.content)
              : wrapperContentText(entry.content);
      switch (entry.source) {
        case "input":
        case "prompt": {
          // Attachments render inline: split the file-include parts out of
          // the text so the bubble gets prose + collapsible boxes, not JSON.
          const split = Array.isArray(entry.content) ? splitFileIncludes(entry.content) : null;
          handleUserMessage({
            content: split ? split.text : content,
            images: entry.images,
            ...(split && split.files.length > 0 ? { files: split.files } : {}),
          });
          break;
        }
        case "llm": {
          if (entry.reasoning_content?.trim()) {
            handleThinking({ content: entry.reasoning_content });
          }
          if (entry.tool_calls && Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
            for (const tc of entry.tool_calls) {
              const toolCall = tc as { name?: string; arguments?: string | object; args?: string | object };
              const name = toolCall.name || "unknown";
              const args = typeof toolCall.arguments === "string"
                ? toolCall.arguments
                : typeof toolCall.args === "string"
                  ? toolCall.args
                  : JSON.stringify(toolCall.arguments ?? toolCall.args ?? {}, null, 2);
              handleToolCall({ name, args, toolCallId: tc.id || undefined });
            }
          }
          if (content.trim()) {
            handleAssistantMessage({ content });
          }
          break;
        }
        case "tool_result":
          handleToolResult({
            name:
              (entry as { tool_name?: string | null }).tool_name || extractToolNameFromEntry(entry),
            output: content,
            images: entry.images,
            toolCallId: (entry as { tool_call_id?: string | null }).tool_call_id || undefined,
          });
          break;
        case "compaction":
          handleCompacting({ message: content });
          break;
      }
    }
    scrollBottom();
  }

  /** Append a system notice bubble (used for profile-switch confirmations). */
  function addSystemMessage(text: string): void {
    handleSystemMessage({ content: `Switched to profile: ${text}` });
  }

  /** Append a system notice bubble from a server system message. */
  function handleSystemMessage(data: { content?: string }): void {
    const el = document.createElement("div");
    el.className = "message system-message";
    el.innerHTML = `<span class="message-role system-label">System</span><div class="message-content"><p>${sanitize(data.content ?? "")}</p></div>`;
    container.appendChild(el);
    scrollBottom();
  }

  /** Detach the container's scroll listener; the container itself is left untouched. */
  function destroy(): void {
    container.removeEventListener("scroll", onScroll);
    // The manager is dropped after this: no tool block may outlive it with
    // a live mount still waiting for a result.
    destroyToolBlocks();
  }

  return {
    handleUserMessage,
    handleAssistantMessage,
    handleStreamingChunk,
    handleStreamingReasoningChunk,
    handleStreamReset,
    handleThinking,
    handleToolCall,
    handleToolResult,
    handleCompacting,
    handleCommandResult,
    handleQuestion,
    handleQuestionAnswered,
    handleTaskProgress,
    handleTokenUsage,
    handleCompactionResult,
    handleSessionState,
    handleError,
    finalizeAssistant,
    clear,
    addSystemMessage,
    handleSystemMessage,
    destroy,
    renderLogEntries,
  };
}
