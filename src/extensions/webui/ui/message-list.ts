/// <reference lib="dom" />
// Per-session message list: renders OUTPUT_EVENTs, incl. streaming markdown.

import { sanitize, resolveQuestionAnswer } from "./utils.ts";
import {
  parseMarkdown,
  mdTreeToHtml,
  renderBlocksToHtml,
  createStreamingParser,
  type StreamingMdParser,
  type FeedResult,
  type MdDocument,
} from "../../../utils/md-parser.ts";

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

interface UserMessage { content: string; }
interface AssistantMessage { content: string; }
interface StreamingChunk { content: string; }
interface ThinkingMessage { content: string; }
interface ToolCallMessage { name: string; args: string; }
interface ToolResultMessage { name: string; output?: string; error?: string; }
interface CompactingMessage { message: string; }
interface CommandResultMessage { content: string; }

// Log entry as returned by the server's logViewed message.
interface LogEntry {
  source: string;
  content: string;
  images?: Array<{ url: string }>;
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
}

interface CompactionResultMessage { summary: string; messagesCompacted: number; }
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
  /** Render a batch of session log entries (for viewing cold session logs). */
  renderLogEntries: (entries: LogEntry[]) => void;
}

export function createMessageList(
  _sessionId: string,
  { hideThinking = false, onQuestionAnswer }: MessageListOptions = {},
): MessageListManager {
  const container = document.getElementById("message-list") as HTMLDivElement;
  let currentAssistantEl: HTMLDivElement | null = null;
  let currentThinkingEl: HTMLDivElement | null = null;
  let currentToolCalls: HTMLDivElement[] = [];
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

      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = "🤖";
      currentAssistantEl.appendChild(avatar);

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

  // ── Message Handlers ──────────────────────────────────────────────────────
  function handleUserMessage({ content }: UserMessage): void {
    const el = document.createElement("div");
    el.className = "message user";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "👤";
    el.appendChild(avatar);

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

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "🤖";
    el.appendChild(avatar);

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

  function handleThinking({ content }: ThinkingMessage): void {
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
      // Swap in the full output when expanding.
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
    // Attach the result to the most recent matching tool call block.
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
      // Keep the full output for expansion; show a truncated preview.
      const fullOutput = output || error || "";
      body.dataset.fullOutput = fullOutput;
      body.dataset.truncated = "true";

      if (output)
        body.textContent =
          output.slice(0, 2000) + "\n\n<click to show full response>";
      else if (error) body.textContent = `Error: ${error}`;
    }
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

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "🤖";
    el.appendChild(avatar);

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
  }: TokenUsageMessage): void {
    const el = document.createElement("div");
    el.className = "message token-usage";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = `(tokens cached: ${cachedTokens} prompt:${promptTokens} completion:${completionTokens} total:${totalTokens})`;
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

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "⚠️";
    el.appendChild(avatar);

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

  /** Best-effort tool name from a tool_result entry: JSON "name", then "tool: ..." prefix. */
  function extractToolNameFromEntry(content: string): string {
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
      switch (entry.source) {
        case "input":
        case "prompt":
          handleUserMessage({ content: entry.content });
          break;
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
              handleToolCall({ name, args });
            }
          }
          if (entry.content?.trim()) {
            handleAssistantMessage({ content: entry.content });
          }
          break;
        }
        case "tool_result":
          handleToolResult({ name: extractToolNameFromEntry(entry.content || ""), output: entry.content });
          break;
        case "compaction":
          handleCompacting({ message: entry.content });
          break;
      }
    }
    scrollBottom();
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
    handleQuestionAnswered,
    handleTaskProgress,
    handleTokenUsage,
    handleCompactionResult,
    handleSessionState,
    handleError,
    finalizeAssistant,
    clear,
    renderLogEntries,
  };
}
