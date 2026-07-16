/// <reference lib="dom" />
// Message rendering — displays all OUTPUT_EVENT types in the chat view.
// Manages a message list per session, with streaming, tool calls, and thinking.

import { sanitize } from "./utils.ts";

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
      contentEl.className = "content";
      bubble.appendChild(contentEl);
      currentAssistantEl.appendChild(bubble);

      container.appendChild(currentAssistantEl);
    }
    return currentAssistantEl;
  }

  function ensureThinkingEl(): HTMLDivElement {
    if (!currentThinkingEl) {
      currentThinkingEl = document.createElement("div");
      currentThinkingEl.className = "thinking-block";
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
    contentEl.className = "content";
    contentEl.textContent = content;
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
    contentDiv.textContent += content;
    scrollBottom();
  }

  function handleStreamingReasoningChunk({ content }: StreamingChunk): void {
    const el = ensureThinkingEl();
    el.textContent += content;
    scrollBottom();
  }

  function handleThinking({ content }: ThinkingMessage): void {
    // Final thinking block (non-streaming)
    const el = ensureThinkingEl();
    el.textContent = content;
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
    if (currentAssistantEl) {
      currentAssistantEl.classList.remove("streaming");
      currentAssistantEl = null;
    }
    currentThinkingEl = null;
    currentToolCalls = [];
    hasToolCallsSinceLastAssistant = false;
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
