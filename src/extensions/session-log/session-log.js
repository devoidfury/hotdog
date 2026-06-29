// Session log — append-only JSONL audit trail for observability.
// Each session gets a file at ~/.cache/oa-agent/sessions/<uuid>.jsonl.
// Messages are appended as JSON lines. The file is never truncated or modified.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendFile,
  access,
  mkdir,
} from "node:fs/promises";

// Re-export core session log functions from src/ (session resume is a core feature)
import {
  LOG_SOURCE,
  readSessionEntries,
  readAllSessions,
  sessionExists,
  replayEntriesIntoContext,
} from "../../core/session/session-log.js";
import { stripNulls } from "../../utils/objects.js";

// Re-export core functions for convenience
export {
  LOG_SOURCE,
  readSessionEntries,
  readAllSessions,
  sessionExists,
  replayEntriesIntoContext,
};

// ── Session Log Entry ───────────────────────────────────────────────────────

/**
 * Create a system prompt entry.
 */
export function createSystemPromptEntry(sessionId, content) {
  return {
    ts: now(),
    session_id: sessionId,
    role: "system",
    source: LOG_SOURCE.SYSTEM_PROMPT,
    content,
    reasoning_content: null,
    tool_calls: null,
    tool_call_id: null,
    tool_name: null,
    images: null,
  };
}

/**
 * Create a user input entry.
 * @param {string} sessionId
 * @param {string|Array} content — Plain text or array of content parts
 * @param {Array<{type: string, mimeType: string, data: string}>} [images] — Optional images
 */
export function createInputEntry(sessionId, content, images = null) {
  return {
    ts: now(),
    session_id: sessionId,
    role: "user",
    source: LOG_SOURCE.INPUT,
    content,
    reasoning_content: null,
    tool_calls: null,
    tool_call_id: null,
    tool_name: null,
    images,
  };
}

/**
 * Create an LLM assistant response entry.
 */
export function createAssistantEntry(
  sessionId,
  content,
  toolCalls = null,
  reasoningContent = null,
) {
  return {
    ts: now(),
    session_id: sessionId,
    role: "assistant",
    source: LOG_SOURCE.LLM,
    content,
    reasoning_content: reasoningContent,
    tool_calls: toolCalls,
    tool_call_id: null,
    tool_name: null,
    images: null,
  };
}

/**
 * Create a tool result entry.
 */
export function createToolResultEntry(
  sessionId,
  content,
  toolCallId = null,
  toolName = null,
) {
  return {
    ts: now(),
    session_id: sessionId,
    role: "tool",
    source: LOG_SOURCE.TOOL_RESULT,
    content,
    reasoning_content: null,
    tool_calls: null,
    tool_call_id: toolCallId,
    tool_name: toolName,
    images: null,
  };
}

/**
 * Create a reset entry.
 */
export function createResetEntry(sessionId) {
  return {
    ts: now(),
    session_id: sessionId,
    role: "user",
    source: LOG_SOURCE.RESET,
    content: "",
    reasoning_content: null,
    tool_calls: null,
    tool_call_id: null,
    tool_name: null,
    images: null,
  };
}

/**
 * Create a compaction entry.
 */
export function createCompactionEntry(sessionId, messagesCompacted, summary) {
  return {
    ts: now(),
    session_id: sessionId,
    role: "user",
    source: LOG_SOURCE.COMPACTION,
    content: `<system-notice>[Compacted ${messagesCompacted} messages]\n\n${summary}</system-notice>`,
    reasoning_content: null,
    tool_calls: null,
    tool_call_id: null,
    tool_name: null,
    images: null,
  };
}

/**
 * Create a prompt expansion entry.
 * @param {string} sessionId
 * @param {string|Array} content
 * @param {Array<{type: string, mimeType: string, data: string}>} [images]
 */
export function createPromptEntry(sessionId, content, images = null) {
  return {
    ts: now(),
    session_id: sessionId,
    role: "user",
    source: LOG_SOURCE.PROMPT,
    content,
    reasoning_content: null,
    tool_calls: null,
    tool_call_id: null,
    tool_name: null,
    images,
  };
}

// ── Session Log Writer ──────────────────────────────────────────────────────

/**
 * Get the sessions directory path.
 */
function sessionsDir() {
  const home = homedir();
  return join(home, ".cache", "oa-agent", "sessions");
}

/**
 * Get the session file path for a given session ID.
 */
function sessionPath(sessionId) {
  return join(sessionsDir(), `${sessionId}.jsonl`);
}

/**
 * Session log writer. Append-only, never truncates.
 */
export class SessionLog {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.path = sessionPath(sessionId);
  }

  /**
   * Ensure the sessions directory exists.
   */
  async _ensureDir() {
    const dir = sessionsDir();
    try {
      await access(dir);
    } catch {
      try {
        await mkdir(dir, { recursive: true });
      } catch {
        // Best effort — will fail on first write if dir can't be created
      }
    }
  }

  /**
   * Append an entry to the log file.
   */
  async append(entry) {
    await this._ensureDir();
    const line = JSON.stringify(stripNulls(entry));
    await appendFile(this.path, line + "\n");
  }

  /**
   * Write a system prompt entry.
   */
  async writeSystemPrompt(content) {
    await this.append(createSystemPromptEntry(this.sessionId, content));
  }

  /**
   * Write a user input entry.
   * @param {string|Array} content
   * @param {Array<{type: string, mimeType: string, data: string}>} [images]
   */
  async writeInput(content, images = null) {
    await this.append(createInputEntry(this.sessionId, content, images));
  }

  /**
   * Write an LLM assistant response entry.
   */
  async writeAssistant(content, toolCalls = null, reasoningContent = null) {
    await this.append(
      createAssistantEntry(
        this.sessionId,
        content,
        toolCalls,
        reasoningContent,
      ),
    );
  }

  /**
   * Write a tool result entry.
   */
  async writeToolResult(content, toolCallId = null, toolName = null) {
    await this.append(
      createToolResultEntry(this.sessionId, content, toolCallId, toolName),
    );
  }

  /**
   * Write a reset entry.
   */
  async writeReset() {
    await this.append(createResetEntry(this.sessionId));
  }

  /**
   * Write a compaction entry.
   */
  async writeCompaction(messagesCompacted, summary) {
    await this.append(
      createCompactionEntry(this.sessionId, messagesCompacted, summary),
    );
  }

  /**
   * Write a prompt expansion entry.
   * @param {string|Array} content
   * @param {Array<{type: string, mimeType: string, data: string}>} [images]
   */
  async writePrompt(content, images = null) {
    await this.append(createPromptEntry(this.sessionId, content, images));
  }
}

/**
 * Create a disabled session log (no-op).
 */
export function disabledSessionLog() {
  return {
    append() {},
    writeSystemPrompt() {},
    writeInput() {},
    writeAssistant() {},
    writeToolResult() {},
    writeReset() {},
    writeCompaction() {},
    writePrompt() {},
  };
}

/**
 * Get current timestamp string.
 */
function now() {
  const d = new Date();
  return d.toISOString();
}
