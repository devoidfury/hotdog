// Message rendering — displays all OUTPUT_EVENT types in the chat view.
// Manages a message list per session, with streaming, tool calls, and thinking.

import { sanitize } from "./utils.js";

/**
 * Create a message list manager for a single session.
 * @param {string} sessionId
 * @param {Object} options
 * @param {boolean} [options.hideThinking=false]
 * @returns {Object} Message list manager
 */
export function createMessageList(sessionId, { hideThinking = false } = {}) {
  const container = document.getElementById("message-list");
  let currentAssistantEl = null;
  let currentThinkingEl = null;
  let currentToolCalls = [];

  function ensureAssistantEl() {
    if (!currentAssistantEl) {
      currentAssistantEl = document.createElement("div");
      currentAssistantEl.className = "message assistant streaming";
      const contentEl = document.createElement("div");
      contentEl.className = "content";
      currentAssistantEl.appendChild(contentEl);
      container.appendChild(currentAssistantEl);
    }
    return currentAssistantEl;
  }

  function ensureThinkingEl() {
    if (!currentThinkingEl) {
      currentThinkingEl = document.createElement("div");
      currentThinkingEl.className = "thinking-block";
      if (hideThinking) currentThinkingEl.classList.add("hidden");
      container.appendChild(currentThinkingEl);
    }
    return currentThinkingEl;
  }

  /** Show/hide thinking blocks. */
  function setHideThinking(v) {
    hideThinking = v;
    if (currentThinkingEl) {
      currentThinkingEl.classList.toggle("hidden", v);
    }
  }

  // ── Message Handlers ──────────────────────────────────────────────────────

  function handleUserMessage({ content }) {
    finalizeAssistant();
    const el = document.createElement("div");
    el.className = "message user";
    el.innerHTML = `<div class="content">${sanitize(content)}</div>`;
    container.appendChild(el);
    scrollBottom();
  }

  function handleAssistantMessage({ content }) {
    finalizeAssistant();
    const el = document.createElement("div");
    el.className = "message assistant";
    el.innerHTML = `<div class="content">${sanitize(content)}</div>`;
    container.appendChild(el);
    scrollBottom();
  }

  function handleStreamingChunk({ content }) {
    const el = ensureAssistantEl();
    const contentDiv = el.querySelector(".content");
    contentDiv.textContent += content;
    scrollBottom();
  }

  function handleStreamingReasoningChunk({ content }) {
    const el = ensureThinkingEl();
    el.textContent += content;
    scrollBottom();
  }

  function handleThinking({ content }) {
    // Final thinking block (non-streaming)
    const el = ensureThinkingEl();
    el.textContent = content;
  }

  function handleToolCall({ name, args }) {
    const parent = ensureAssistantEl();

    const block = document.createElement("div");
    block.className = "tool-call-block";

    const header = document.createElement("div");
    header.className = "tool-call-header";
    header.innerHTML = `<span>🛠 ${sanitize(name)}</span><span>${sanitize(args)}</span>`;

    const body = document.createElement("div");
    body.className = "tool-call-body hidden";
    body.textContent = args;

    header.addEventListener("click", () => {
      body.classList.toggle("hidden");
    });

    block.appendChild(header);
    block.appendChild(body);
    parent.appendChild(block);

    currentToolCalls.push(block);
    scrollBottom();
  }

  function handleToolResult({ name, output, error }) {
    // Find the last tool call block for this tool and add result
    const blocks = container.querySelectorAll(".tool-call-block");
    let target = null;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const hdr = blocks[i].querySelector(".tool-call-header span");
      if (hdr && hdr.textContent.includes(name)) {
        target = blocks[i];
        break;
      }
    }
    if (!target) return;

    const body = target.querySelector(".tool-call-body");
    if (body) {
      if (output) body.textContent = output.slice(0, 2000);
      else if (error) body.textContent = `Error: ${error}`;
      body.classList.remove("hidden");
    }
    scrollBottom();
  }

  function handleCompacting({ message }) {
    // Show compacting notice
    const el = document.createElement("div");
    el.className = "message compacting";
    el.textContent = `⚡ ${message}`;
    container.appendChild(el);
    scrollBottom();
  }

  function handleCommandResult({ content }) {
    const el = document.createElement("div");
    el.className = "message command-result";
    el.innerHTML = `<div class="content">${sanitize(content)}</div>`;
    container.appendChild(el);
    scrollBottom();
  }

  function handleQuestion({ questions }) {
    finalizeAssistant();
    const el = document.createElement("div");
    el.className = "message question";
    let html = `<div class="content"><strong>Question:</strong><br>`;
    for (const q of questions) {
      html += `${sanitize(q.message || q.prompt)}<br>`;
      if (q.options) {
        for (const opt of q.options) {
          html += `  • ${sanitize(opt)}<br>`;
        }
      }
    }
    html += `</div>`;
    el.innerHTML = html;
    container.appendChild(el);
    scrollBottom();
  }

  function handleTaskProgress({ taskId, status, message }) {
    // Task progress — subtle indicator
    let el = container.querySelector(`.task-progress[data-task-id="${sanitize(taskId)}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "message task-progress";
      el.dataset.taskId = taskId;
      container.appendChild(el);
    }
    el.textContent = `⚡ ${status}${message ? ": " + message : ""}`;
    scrollBottom();
  }

  function handleTokenUsage({ inputTokens, outputTokens, totalTokens }) {
    const el = document.createElement("div");
    el.className = "message token-usage";
    el.textContent = `(tokens: ${inputTokens} in → ${outputTokens} out, ${totalTokens} total)`;
    container.appendChild(el);
    scrollBottom();
  }

  function handleCompactionResult({ summary, messagesCompacted }) {
    const el = document.createElement("div");
    el.className = "message compaction-result";
    el.textContent = `Compacted ${messagesCompacted} messages. Summary: ${summary}`;
    container.appendChild(el);
    scrollBottom();
  }

  function handleSessionState({ key, value }) {
    if (key === "hideThinking") {
      setHideThinking(value);
    }
  }

  function handleError({ message }) {
    finalizeAssistant();
    const el = document.createElement("div");
    el.className = "message error";
    el.textContent = `Error: ${sanitize(message)}`;
    container.appendChild(el);
    scrollBottom();
  }

  /** Finalize the current streaming assistant message. */
  function finalizeAssistant() {
    if (currentAssistantEl) {
      currentAssistantEl.classList.remove("streaming");
      currentAssistantEl = null;
    }
    currentThinkingEl = null;
    currentToolCalls = [];
  }

  function scrollBottom() {
    container.scrollTop = container.scrollHeight;
  }

  function clear() {
    container.innerHTML = "";
    currentAssistantEl = null;
    currentThinkingEl = null;
    currentToolCalls = [];
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
