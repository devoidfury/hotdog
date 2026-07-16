// Session log — append-only JSONL audit trail for observability.
// Each session gets a file at ~/.cache/hotdog/sessions/<uuid>.jsonl.
// Messages are appended as JSON lines. The file is never truncated or modified.

import { homedir } from "node:os";
import { join } from "node:path";
import { appendFile, access, mkdir } from "node:fs/promises";

// Re-export core session log functions from src/ (session resume is a core feature)
import {
  LOG_SOURCE,
  readSessionEntries,
  readAllSessions,
  sessionExists,
  replayEntriesIntoContext,
} from "../../core/session/session-log.ts";
import { stripNulls } from "../../utils/objects.ts";

// Re-export core functions for convenience
export {
  LOG_SOURCE,
  readSessionEntries,
  readAllSessions,
  sessionExists,
  replayEntriesIntoContext,
};

// ── Session Log Entry ───────────────────────────────────────────────────────

interface LogEntry extends Record<string, unknown> {
  ts: string;
  session_id: string;
  role: string;
  source: string;
  content: string | unknown[];
  reasoning_content: string | null;
  tool_calls: unknown;
  tool_call_id: string | null;
  tool_name: string | null;
  images: unknown[] | null;
}

/**
 * Create a system prompt entry.
 */
export function createSystemPromptEntry(
  sessionId: string,
  content: string,
): LogEntry {
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
 */
export function createInputEntry(
  sessionId: string,
  content: string | unknown[],
  images: unknown[] | null = null,
): LogEntry {
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
  sessionId: string,
  content: string,
  toolCalls: unknown = null,
  reasoningContent: string | null = null,
): LogEntry {
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
  sessionId: string,
  content: string,
  toolCallId: string | null = null,
  toolName: string | null = null,
): LogEntry {
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
export function createResetEntry(sessionId: string): LogEntry {
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
export function createCompactionEntry(
  sessionId: string,
  messagesCompacted: number,
  summary: string,
): LogEntry {
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
 */
export function createPromptEntry(
  sessionId: string,
  content: string | unknown[],
  images: unknown[] | null = null,
): LogEntry {
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
function sessionsDir(): string {
  const home = homedir();
  return join(home, ".cache", "hotdog", "sessions");
}

/**
 * Get the session file path for a given session ID.
 */
function sessionPath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.jsonl`);
}

/**
 * Session log writer. Append-only, never truncates.
 */
export class SessionLog {
  readonly sessionId: string;
  readonly path: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.path = sessionPath(sessionId);
  }

  /**
   * Ensure the sessions directory exists.
   */
  private async _ensureDir(): Promise<void> {
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
  async append(entry: LogEntry): Promise<void> {
    await this._ensureDir();
    const line = JSON.stringify(stripNulls(entry));
    await appendFile(this.path, line + "\n");
  }

  /**
   * Write a system prompt entry.
   */
  async writeSystemPrompt(content: string): Promise<void> {
    await this.append(createSystemPromptEntry(this.sessionId, content));
  }

  /**
   * Write a user input entry.
   */
  async writeInput(
    content: string | unknown[],
    images: unknown[] | null = null,
  ): Promise<void> {
    await this.append(createInputEntry(this.sessionId, content, images));
  }

  /**
   * Write an LLM assistant response entry.
   */
  async writeAssistant(
    content: string,
    toolCalls: unknown = null,
    reasoningContent: string | null = null,
  ): Promise<void> {
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
  async writeToolResult(
    content: string,
    toolCallId: string | null = null,
    toolName: string | null = null,
  ): Promise<void> {
    await this.append(
      createToolResultEntry(this.sessionId, content, toolCallId, toolName),
    );
  }

  /**
   * Write a reset entry.
   */
  async writeReset(): Promise<void> {
    await this.append(createResetEntry(this.sessionId));
  }

  /**
   * Write a compaction entry.
   */
  async writeCompaction(
    messagesCompacted: number,
    summary: string,
  ): Promise<void> {
    await this.append(
      createCompactionEntry(this.sessionId, messagesCompacted, summary),
    );
  }

  /**
   * Write a prompt expansion entry.
   */
  async writePrompt(
    content: string | unknown[],
    images: unknown[] | null = null,
  ): Promise<void> {
    await this.append(createPromptEntry(this.sessionId, content, images));
  }
}

/**
 * Create a disabled session log (no-op).
 */
export function disabledSessionLog(): Record<string, () => Promise<void>> {
  const noop = () => Promise.resolve();
  return {
    append: noop,
    writeSystemPrompt: noop,
    writeInput: noop,
    writeAssistant: noop,
    writeToolResult: noop,
    writeReset: noop,
    writeCompaction: noop,
    writePrompt: noop,
  };
}

/**
 * Get current timestamp string.
 */
function now(): string {
  const d = new Date();
  return d.toISOString();
}
