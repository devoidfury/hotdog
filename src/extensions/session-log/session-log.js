// Session log — append-only JSONL audit trail for observability.
// Each session gets a file at ~/.cache/oa-agent/sessions/<uuid>.jsonl.
// Messages are appended as JSON lines. The file is never truncated or modified.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";

// Re-export core session log functions from src/ (session resume is a core feature)
import {
  stripNulls,
  LOG_SOURCE,
  readSessionEntries,
  readAllSessions,
  sessionExists,
  replayEntriesIntoContext,
} from "../../core/session/session-log.js";

// Re-export core functions for convenience
export {
  stripNulls,
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
  };
}

/**
 * Create a user input entry.
 */
export function createInputEntry(sessionId, content) {
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
  };
}

/**
 * Create a compaction entry.
 */
export function createCompactionEntry(sessionId, messagesCompacted, summary) {
  return {
    ts: now(),
    session_id: sessionId,
    role: "system",
    source: LOG_SOURCE.COMPACTION,
    content: `[Compacted ${messagesCompacted} messages]\n\n${summary}`,
    reasoning_content: null,
    tool_calls: null,
    tool_call_id: null,
    tool_name: null,
  };
}

/**
 * Create a prompt expansion entry.
 */
export function createPromptEntry(sessionId, content) {
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
  _ensureDir() {
    const dir = sessionsDir();
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // Best effort — will fail on first write if dir can't be created
      }
    }
  }

  /**
   * Append an entry to the log file.
   */
  append(entry) {
    this._ensureDir();
    const line = JSON.stringify(stripNulls(entry));
    appendFileSync(this.path, line + "\n");
  }

  /**
   * Write a system prompt entry.
   */
  writeSystemPrompt(content) {
    this.append(createSystemPromptEntry(this.sessionId, content));
  }

  /**
   * Write a user input entry.
   */
  writeInput(content) {
    this.append(createInputEntry(this.sessionId, content));
  }

  /**
   * Write an LLM assistant response entry.
   */
  writeAssistant(content, toolCalls = null, reasoningContent = null) {
    this.append(
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
  writeToolResult(content, toolCallId = null, toolName = null) {
    this.append(
      createToolResultEntry(this.sessionId, content, toolCallId, toolName),
    );
  }

  /**
   * Write a reset entry.
   */
  writeReset() {
    this.append(createResetEntry(this.sessionId));
  }

  /**
   * Write a compaction entry.
   */
  writeCompaction(messagesCompacted, summary) {
    this.append(
      createCompactionEntry(this.sessionId, messagesCompacted, summary),
    );
  }

  /**
   * Write a prompt expansion entry.
   */
  writePrompt(content) {
    this.append(createPromptEntry(this.sessionId, content));
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
