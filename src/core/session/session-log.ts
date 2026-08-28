// Reading/replaying session logs lives in core because resume is a core feature;
// writing happens in the session-log extension's hook handlers.

import { homedir } from "node:os";
import { join, resolve as resolveAbs, sep } from "node:path";
import { readFile, access, readdir, stat, unlink } from "node:fs/promises";
import { MESSAGE_SOURCES, Message, type ToolCall, type ImageAttachment, type MessageSource } from "../context/message.ts";
import { AgentError, formatError } from "../error.ts";
import { logger } from "../logger.ts";

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
  ts: string;
  session_id: string;
  source: LogSource;
  /** Plain text, or raw content parts (harness messages with `untrusted` parts; never escaped on disk). */
  content: string | Array<Record<string, unknown>>;
  images?: Array<{ type: string; mimeType: string; data: string }>;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[] | null;
  tool_call_id?: string | null;
  tool_name?: string;
  /**
   * Provenance of the message content, distinct from `source` (the log
   * channel); a MessageSource value. "harness" marks code-generated messages
   * that must be replayed with Message.source="harness" (exempt from marker
   * mangling); "model" marks LLM output (always mangled).
   */
  origin?: string;
  // Legacy fields for backwards compatibility with older log formats
  role?: string;
  result?: string;
  [key: string]: unknown;
}

export function sessionsDir(): string {
  const override = process.env.HOTDOG_SESSIONS_DIR;
  if (override) return override;
  const home = homedir();
  return join(home, ".cache", "hotdog", "sessions");
}

// Allows hand-supplied IDs (e.g. CLI --session) while rejecting path separators and `..` traversal.
const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function sessionPath(sessionId: string): string {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new AgentError(
      `Invalid session id: ${JSON.stringify(String(sessionId).slice(0, 80))}`,
    );
  }
  const dir = resolveAbs(sessionsDir());
  const path = resolveAbs(join(sessionsDir(), `${sessionId}.jsonl`));
  // Defense in depth: the resolved path must stay inside the sessions dir.
  if (!path.startsWith(dir + sep)) {
    throw new AgentError(`Session id escapes sessions dir: ${sessionId}`);
  }
  return path;
}

export async function readSessionEntries(sessionId: string): Promise<LogEntry[]> {
  let path: string;
  try {
    path = sessionPath(sessionId);
  } catch (err) {
    // Invalid session id (e.g. traversal attempt) — treat as no entries.
    logger.warn(`[session-log] rejected session id: ${formatError(err)}`);
    return [];
  }
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

/** Most recent activity first; only sessions with at least one real message. */
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
          if (entry.source && entry.source !== LOG_SOURCE.SYSTEM_PROMPT && entry.source !== LOG_SOURCE.RESET) {
            messageCount++;
          }
        } catch {
          // skip malformed lines
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
      // skip unreadable files
    }
  }

  results.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return results.map(({ mtime, ...rest }) => rest);
}

/** Returns true if the file was deleted, false if it didn't exist. */
export async function deleteSessionLog(sessionId: string): Promise<boolean> {
  let path: string;
  try {
    path = sessionPath(sessionId);
  } catch (err) {
    // Invalid session id (e.g. traversal attempt) — nothing to delete.
    logger.warn(`[session-log] rejected session id: ${formatError(err)}`);
    return false;
  }
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

/** Converts log entries to Messages in the agent's context; returns the count replayed. */
export function replayEntriesIntoContext(agent: AgentForReplay, entries: LogEntry[]): number {
  if (!entries || entries.length === 0) return 0;

  let replayed = 0;

  for (const entry of entries) {
    const source = entry.source;

    // System prompts are regenerated dynamically via ensureSystemPrompt().
    if (source === LOG_SOURCE.SYSTEM_PROMPT) {
      continue;
    }

    if (source === LOG_SOURCE.RESET) {
      continue;
    }

    // Provenance survives replay: harness-originated entries are re-tagged so
    // they keep their mangle exemption and role "harness" after resume;
    // "model"/"tool"/"user" re-tag untrusted content. Unknown values are
    // dropped (untrusted).
    const origin: MessageSource | undefined =
      typeof entry.origin === "string" && (MESSAGE_SOURCES as readonly string[]).includes(entry.origin)
        ? (entry.origin as MessageSource)
        : undefined;
    const role = origin === "harness" ? "harness" : undefined;

    switch (source) {
      case LOG_SOURCE.INPUT:
      case LOG_SOURCE.PROMPT: {
        agent.addMessage(
          new Message({
            role: role ?? "user",
            content: entry.content,
            images: entry.images as ImageAttachment[] | undefined,
            source: origin,
          }),
        );
        replayed++;
        break;
      }

      case LOG_SOURCE.LLM: {
        agent.addMessage(
          new Message({
            role: role ?? "assistant",
            content: entry.content,
            reasoningContent: entry.reasoning_content ?? null,
            toolCalls: entry.tool_calls ?? null,
            source: origin,
          }),
        );
        replayed++;
        break;
      }

      case LOG_SOURCE.TOOL_RESULT: {
        agent.addMessage(
          new Message({
            role: "tool",
            content: entry.content,
            toolCallId: entry.tool_call_id ?? null,
            source: origin ?? "tool",
          }),
        );
        replayed++;
        break;
      }

      case LOG_SOURCE.COMPACTION: {
        agent.addMessage(new Message({ role: "harness", source: "harness", content: entry.content }));
        replayed++;
        break;
      }

      default:
        break;
    }
  }

  return replayed;
}
