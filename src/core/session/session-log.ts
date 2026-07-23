// Session log — core functions for reading/replaying session logs.
// Session resume is a core feature, so these functions live in src/.
// Writing (SessionLog class) remains in the extension for observability.

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, access, readdir, stat, unlink } from "node:fs/promises";
import { Message, type ImageAttachment as MessageImageAttachment } from "../context/message.ts";
import { logger } from "../logger.ts";

// ── Log Source Types ────────────────────────────────────────────────────────

export const LOG_SOURCE = {
  SYSTEM_PROMPT: "system_prompt",
  INPUT: "input",
  LLM: "llm",
  TOOL_RESULT: "tool_result",
  RESET: "reset",
  COMPACTION: "compaction",
  PROMPT: "prompt",
} as const;

export type LogSource = (typeof LOG_SOURCE)[keyof typeof LOG_SOURCE];

export interface LogEntry {
  source: LogSource;
  content: string;
  images?: Array<{ type: string; mimeType: string; data: string }>;
  reasoning_content?: string | null;
  tool_calls?: unknown[] | null;
  tool_call_id?: string | null;
}

// ── Session File Paths ──────────────────────────────────────────────────────

/**
 * Get the sessions directory path.
 */
export function sessionsDir(): string {
  const home = homedir();
  return join(home, ".cache", "hotdog", "sessions");
}

/**
 * Get the session file path for a given session ID.
 */
export function sessionPath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.jsonl`);
}

// ── Session Log Readers ─────────────────────────────────────────────────────

/**
 * Read all entries from a specific session file, replaying from the last reset.
 */
export async function readSessionEntries(sessionId: string): Promise<LogEntry[]> {
  const path = sessionPath(sessionId);
  try {
    await access(path);
  } catch {
    return [];
  }

  const content = await readFile(path, "utf-8");
  const lines = content.split("\n");
  const entries: LogEntry[] = [];
  let lastResetIdx: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const entry = JSON.parse(trimmed) as LogEntry;
      entries.push(entry);
      if (entry.source === LOG_SOURCE.RESET) {
        // Track the index AFTER the reset entry (skip the reset itself)
        lastResetIdx = entries.length;
      }
    } catch {
      logger.warn(
        `[session-log] malformed JSON line in session ${sessionId}: ` +
          `line ${i + 1} — "${trimmed.slice(0, 80)}${trimmed.length > 80 ? "..." : ""}"`,
      );
    }
  }

  // Replay from the last reset event (or beginning if no reset)
  return entries.slice(lastResetIdx ?? 0);
}

/**
 * Read all entries from all session files.
 */
export async function readAllSessions(): Promise<LogEntry[]> {
  const dir = sessionsDir();
  try {
    await access(dir);
  } catch {
    return [];
  }

  const allEntries: LogEntry[] = [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));

  for (const file of files) {
    const path = join(dir, file);
    const content = await readFile(path, "utf-8");

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        allEntries.push(JSON.parse(trimmed) as LogEntry);
      } catch {
        logger.warn(
          `[session-log] malformed JSON in ${file}: ` +
            `"${trimmed.slice(0, 80)}${trimmed.length > 80 ? "..." : ""}"`,
        );
      }
    }
  }

  return allEntries;
}

/**
 * Check if a session file exists.
 */
export async function sessionExists(sessionId: string): Promise<boolean> {
  try {
    await access(sessionPath(sessionId));
    return true;
  } catch {
    return false;
  }
}

export interface SessionLogInfo {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
}

/**
 * List all session log files with metadata.
 * Returns sessions sorted by last activity (most recent first).
 * Only includes sessions with at least one non-system/non-reset entry.
 */
export async function listSessionLogs(): Promise<SessionLogInfo[]> {
  const dir = sessionsDir();
  try {
    await access(dir);
  } catch {
    return [];
  }

  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  const results: Array<SessionLogInfo & { mtime: number }> = [];

  for (const file of files) {
    const sessionId = file.replace(".jsonl", "");
    const filePath = join(dir, file);
    try {
      const metadata = await stat(filePath);
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length === 0) continue;

      let createdAt = 0;
      let lastActivityAt = 0;
      let messageCount = 0;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown> & LogEntry;
          const ts = (entry.ts as string) ? new Date(entry.ts as string).getTime() : 0;
          if (ts > 0) {
            if (createdAt === 0 || ts < createdAt) createdAt = ts;
            if (ts > lastActivityAt) lastActivityAt = ts;
          }
          // Count non-system, non-reset entries
          if (entry.source && entry.source !== LOG_SOURCE.SYSTEM_PROMPT && entry.source !== LOG_SOURCE.RESET) {
            messageCount++;
          }
        } catch {
          // Skip malformed lines
        }
      }

      if (messageCount > 0) {
        results.push({
          id: sessionId,
          createdAt: createdAt || metadata.mtime.getTime(),
          lastActivityAt: lastActivityAt || metadata.mtime.getTime(),
          messageCount,
          mtime: metadata.mtime.getTime(),
        });
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Sort by last activity, most recent first
  results.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return results.map(({ mtime, ...rest }) => rest);
}

/**
 * Delete a session log file from disk.
 * @param sessionId - Session ID whose log file to delete
 * @returns True if the file was deleted, false if it didn't exist
 */
export async function deleteSessionLog(sessionId: string): Promise<boolean> {
  const path = sessionPath(sessionId);
  try {
    await unlink(path);
    return true;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      return false;
    }
    logger.warn(`[session-log] failed to delete session log ${sessionId}: ${error.message}`);
    return false;
  }
}

export interface AgentForReplay {
  addMessage(msg: Message): void;
}

/**
 * Replay log entries into an agent's context.
 *
 * Takes an array of log entries (from readSessionEntries) and converts them
 * to Message objects, adding them to the agent's context. This allows the
 * agent to "continue" a previous conversation.
 *
 * System prompt entries are skipped — the agent regenerates it dynamically
 * via ensureSystemPrompt().
 *
 * @param agent - The agent whose context to populate
 * @param entries - Log entries from readSessionEntries()
 * @returns The number of entries actually replayed (excluding skipped ones)
 */
export function replayEntriesIntoContext(agent: AgentForReplay, entries: LogEntry[]): number {
  if (!entries || entries.length === 0) return 0;

  let replayed = 0;

  for (const entry of entries) {
    const source = entry.source;

    // Skip system prompt entries — they are regenerated dynamically
    if (source === LOG_SOURCE.SYSTEM_PROMPT) {
      continue;
    }

    // Skip reset entries — they mark the start of the replayed portion
    if (source === LOG_SOURCE.RESET) {
      continue;
    }

    switch (source) {
      case LOG_SOURCE.INPUT:
      case LOG_SOURCE.PROMPT: {
        // Both INPUT and PROMPT are user messages in context
        // Preserve images if present
        agent.addMessage(
          new Message({
            role: "user",
            content: entry.content,
            images: entry.images as MessageImageAttachment[] | null | undefined,
          }),
        );
        replayed++;
        break;
      }

      case LOG_SOURCE.LLM: {
        // Assistant response — preserve reasoning content and tool calls
        agent.addMessage(
          new Message({
            role: "assistant",
            content: entry.content,
            reasoningContent: entry.reasoning_content ?? null,
            toolCalls: entry.tool_calls ?? null,
          }),
        );
        replayed++;
        break;
      }

      case LOG_SOURCE.TOOL_RESULT: {
        // Tool result
        agent.addMessage(
          new Message({
            role: "tool",
            content: entry.content,
            toolCallId: entry.tool_call_id ?? null,
          }),
        );
        replayed++;
        break;
      }

      case LOG_SOURCE.COMPACTION: {
        // Compaction summary — added as user message in context
        agent.addMessage(new Message({ role: "user", content: entry.content }));
        replayed++;
        break;
      }

      default:
        // Unknown source — skip silently
        break;
    }
  }

  return replayed;
}
