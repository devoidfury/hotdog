// Session log — append-only JSONL audit trail for observability.
// Each session gets a file at ~/.cache/hotdog/sessions/<uuid>.jsonl.
// Messages are appended as JSON lines. The file is never truncated or modified.

import { appendFile, access, mkdir } from "node:fs/promises";

// Re-export core session log functions from src/ (session resume is a core feature)
import {
  LOG_SOURCE,
  readSessionEntries,
  readAllSessions,
  sessionExists,
  sessionPath,
  sessionsDir,
  listSessionLogs,
  replayEntriesIntoContext,
  type LogEntry,
} from "../../core/session/session-log.ts";
import { stripNulls } from "../../utils/objects.ts";
import { ImageAttachment, ToolCall } from "../../core/context/message.ts";

// Re-export core functions for convenience
export {
  LOG_SOURCE,
  readSessionEntries,
  readAllSessions,
  sessionExists,
  sessionPath,
  sessionsDir,
  listSessionLogs,
  replayEntriesIntoContext,
};

/** Create a system prompt entry. */
export function createSystemPromptEntry(
  sessionId: string,
  content: string,
): LogEntry {
  return {
    ts: now(),
    session_id: sessionId,
    source: LOG_SOURCE.SYSTEM_PROMPT,
    content,
  };
}

/** Create a user input entry. */
export function createInputEntry(
  sessionId: string,
  content: string,
  images?: ImageAttachment[],
): LogEntry {
  return {
    ts: now(),
    session_id: sessionId,
    source: LOG_SOURCE.INPUT,
    content,
    images,
  };
}

/** Create an LLM assistant response entry. */
export function createAssistantEntry(
  sessionId: string,
  content: string,
  toolCalls?: ToolCall[] | null,
  reasoningContent: string | null = null,
): LogEntry {
  return {
    ts: now(),
    session_id: sessionId,
    source: LOG_SOURCE.LLM,
    content,
    reasoning_content: reasoningContent,
    tool_calls: toolCalls,
  };
}

/** Create a tool result entry. */
export function createToolResultEntry(
  sessionId: string,
  content: string,
  toolCallId: string | undefined = undefined,
  toolName: string | undefined = undefined,
): LogEntry {
  return {
    ts: now(),
    session_id: sessionId,
    source: LOG_SOURCE.TOOL_RESULT,
    content,
    tool_call_id: toolCallId,
    tool_name: toolName,
  };
}

/** Create a reset entry. */
export function createResetEntry(sessionId: string): LogEntry {
  return {
    ts: now(),
    session_id: sessionId,
    source: LOG_SOURCE.RESET,
    content: "",
  };
}

/** Create a compaction entry. */
export function createCompactionEntry(
  sessionId: string,
  messagesCompacted: number,
  summary: string,
): LogEntry {
  return {
    ts: now(),
    session_id: sessionId,
    source: LOG_SOURCE.COMPACTION,
    content: `<system-notice>[Compacted ${messagesCompacted} messages]\n\n${summary}</system-notice>`,
  };
}

/** Create a prompt expansion entry. */
export function createPromptEntry(
  sessionId: string,
  content: string,
  images?: ImageAttachment[],
): LogEntry {
  return {
    ts: now(),
    session_id: sessionId,
    source: LOG_SOURCE.PROMPT,
    content,
    images,
  };
}

// ── Session Log Writer ──────────────────────────────────────────────────────

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
    const line = JSON.stringify(stripNulls(entry as unknown as Record<string, unknown>));
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
    content: string,
    images?: ImageAttachment[],
  ): Promise<void> {
    await this.append(createInputEntry(this.sessionId, content, images));
  }

  /**
   * Write an LLM assistant response entry.
   */
  async writeAssistant(
    content: string,
    toolCalls?: ToolCall[] | null,
    reasoningContent?: string | null,
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
    toolCallId: string | null | undefined = undefined,
    toolName: string | null | undefined = undefined,
  ): Promise<void> {
    await this.append(
      createToolResultEntry(this.sessionId, content, toolCallId ?? undefined, toolName ?? undefined),
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
    content: string,
    images?: ImageAttachment[],
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
