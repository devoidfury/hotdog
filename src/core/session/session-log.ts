// Reading/replaying session logs lives in core because resume is a core feature;
// writing happens in the session-log extension's hook handlers.

import { homedir } from "node:os";
import { join, resolve as resolveAbs, sep } from "node:path";
import { readFile, access, readdir, stat, unlink } from "node:fs/promises";
import { MESSAGE_SOURCES, Message, type ToolCall, type ImageAttachment, type MessageSource } from "../context/message.ts";
import { repairToolCalls, INTERRUPTED_OUTCOME_UNKNOWN, INTERRUPTED_NOT_STARTED } from "../context/repair.ts";
import { AgentError, CliError, formatError } from "../error.ts";
import { HOOKS } from "../hooks.ts";
import { logger } from "@utils/logger.ts";

export const LOG_SOURCE = {
  SYSTEM_PROMPT: "system_prompt",
  INPUT: "input",
  LLM: "llm",
  TOOL_RESULT: "tool_result",
  RESET: "reset",
  COMPACTION: "compaction",
  PROMPT: "prompt",
  /**
   * Durability record: fsynced before the tool runs (session-log extension,
   * TOOL_BEFORE_EXECUTE). The gate fails closed per call -- a call whose own
   * record could not be written is refused -- so in a log that uses the
   * records: started with no result = outcome-unknown (side effects may have
   * landed), neither = never dispatched. Pre-protocol logs hold no records,
   * so absence proves nothing there; their dangling calls keep the generic
   * interrupted wording. Never replayed as a message.
   */
  TOOL_STARTED: "tool_started",
  /**
   * Durability record: written when the question tool puts a question to the
   * UI. Fsynced but fire-and-forget (output events are not awaited): losing
   * the write degrades to the started-record classification, never to an
   * unsafe claim. An asked call with no tool_result replays as a pending
   * question. Never replayed as a message.
   */
  QUESTION_ASKED: "question_asked",
  /**
   * Durability record: written when a session log is resumed into a fresh
   * agent (restoreSessionIntoAgent). The livelock cap's counter: the log is
   * the system of record, the session index only mirrors it, so deleting the
   * index costs a re-scan, never the cap. Never replayed as a message.
   */
  RESUME_ATTEMPT: "resume_attempt",
  /** Session header: initial model and profile. Survives index loss. Never replayed. */
  SESSION_START: "session_start",
  /** Runtime profile switch (via /profile). Records from/to. Never replayed. */
  PROFILE_SWITCH: "profile_switch",
  /** Token usage snapshot after each LLM response. Replayed as an output event, not a message. */
  TOKEN_USAGE: "token_usage",
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
  emitOutput?(type: string, data: Record<string, unknown>): void;
}

/**
 * Agent surface needed to restore a session by id: the message sink plus the
 * isRestoring flag (which fires SESSION_RESTORE_ACTIVE so the session-log
 * extension suppresses its own writes during the replay).
 */
interface AgentForRestore extends AgentForReplay {
  sessionId: string;
  isRestoring: boolean;
  /** Hook surface used to fire SESSION_RESUME_ATTEMPT (absent on bare test agents). */
  hooks?: { notifyHooks(name: string, payload: unknown): Promise<unknown> };
}

/**
 * Replay an existing session log into a freshly built agent, when the agent
 * actually adopted the caller's explicit session id (`-s <id>`). Returns the
 * number of messages replayed (0 when the session exists but has nothing
 * after its last RESET).
 *
 * Shared by every entry point that can resume by id (interactive CLI,
 * one-shot). The log is append-only, so an adopted id with an existing log
 * means "continue that conversation": without the replay the entry point
 * would append to a log the model never read, and the transcript would lie
 * about what the model knew.
 *
 * An adopted id with NO log at all is a caller mistake (typo, stale id),
 * not a fresh session: an explicit `-s <id>` means "continue THIS
 * conversation", so throw CliError instead of silently starting over (a
 * silent start would surface later only as "why does the model not know X").
 *
 * Returns the replay count plus pending questions (question_asked with no
 * result): the entry point owns re-presenting them -- interactive surfaces
 * re-ask, headless ones resolve them as unanswered.
 */
export async function restoreSessionIntoAgent(
  agent: AgentForRestore,
  explicitSessionId: string | null | undefined,
): Promise<ReplayResult> {
  // No explicit id, or the agent did not adopt it (e.g. a subagent built
  // with its own id): never touch another session's log.
  if (!explicitSessionId || agent.sessionId !== explicitSessionId) {
    return { replayed: 0, pendingQuestions: [], profile: null };
  }
  if (!(await sessionExists(explicitSessionId))) {
    throw new CliError(`Invalid session id: ${explicitSessionId} (no such session)`);
  }

  // fsync the resume_attempt record before replay so the counter is honest
  // even if the process dies mid-replay. notifyHooks swallows handler errors
  // so a failed write degrades gracefully (lower counter, never unsafe).
  await agent.hooks?.notifyHooks(HOOKS.SESSION_RESUME_ATTEMPT, {
    agent,
    sessionId: explicitSessionId,
  });

  const entries = await readSessionEntries(explicitSessionId);

  // isRestoring prevents the session-log extension from re-logging restored
  // messages (which would double-count on the next resume). finally: a throw
  // mid-replay must not leave the flag stuck true, silently killing all later logging.
  agent.isRestoring = true;
  try {
    return replayEntriesIntoContext(agent, entries);
  } finally {
    agent.isRestoring = false;
  }
}

/** A question that was asked but never answered: replay holds the call open
 *  and the entry point re-presents these to a human. */
export interface PendingQuestion {
  toolCallId: string;
  /** The question defs as recorded in the question_asked entry's content. */
  questions: unknown;
}

export interface ReplayResult {
  /** Number of messages replayed into the agent's context. */
  replayed: number;
  /** Unanswered question-tool calls reconstructed from the log. */
  pendingQuestions: PendingQuestion[];
  /** Active profile at end of logged session (last SESSION_START or PROFILE_SWITCH). Null if absent. */
  profile: string | null;
}

/** Durability facts reconstructed from a log scan: which calls began,
 *  which were answered, which questions were asked (asked order preserved,
 *  deduplicated by tool_call_id). Shared by replay and the session index so
 *  neither can drift from the other's classification rules. */
export interface DurabilityFacts {
  /** tool_call_ids with a tool_started record (execution began). */
  started: Set<string>;
  /** tool_call_ids with a tool_result record. */
  answered: Set<string>;
  /** question_asked records, in log order. */
  asked: PendingQuestion[];
  /** Number of resume_attempt records (the livelock cap's counter). */
  resumeAttempts: number;
}

export function collectDurabilityFacts(entries: LogEntry[]): DurabilityFacts {
  const started = new Set<string>();
  const answered = new Set<string>();
  const asked: PendingQuestion[] = [];
  let resumeAttempts = 0;

  for (const entry of entries) {
    const source = entry.source;

    if (
      (source === LOG_SOURCE.TOOL_STARTED ||
        source === LOG_SOURCE.QUESTION_ASKED ||
        source === LOG_SOURCE.TOOL_RESULT) &&
      typeof entry.tool_call_id === "string" &&
      entry.tool_call_id !== ""
    ) {
      if (source === LOG_SOURCE.TOOL_STARTED) started.add(entry.tool_call_id);
      if (source === LOG_SOURCE.TOOL_RESULT) answered.add(entry.tool_call_id);
      if (
        source === LOG_SOURCE.QUESTION_ASKED &&
        !asked.some((p) => p.toolCallId === entry.tool_call_id)
      ) {
        asked.push({ toolCallId: entry.tool_call_id, questions: entry.content });
      }
    }

    if (source === LOG_SOURCE.RESUME_ATTEMPT) resumeAttempts++;
  }

  return { started, answered, asked, resumeAttempts };
}

/** Converts log entries to Messages in the agent's context. */
export function replayEntriesIntoContext(
  agent: AgentForReplay,
  entries: LogEntry[],
): ReplayResult {
  if (!entries || entries.length === 0) return { replayed: 0, pendingQuestions: [], profile: null };

  // Last SESSION_START or PROFILE_SWITCH entry wins for profile restoration.
  let lastProfile: string | null = null;
  for (const entry of entries) {
    if (entry.source === LOG_SOURCE.SESSION_START && entry.profile) {
      lastProfile = entry.profile as string;
    }
    if (entry.source === LOG_SOURCE.PROFILE_SWITCH && entry.profile) {
      lastProfile = entry.profile as string;
    }
  }

  const messages: Message[] = [];

  // Durability bookkeeping for the resume protocol: started/asked/answered
  // drive the missing-result classification below (see collectDurabilityFacts).
  const { started, answered, asked } = collectDurabilityFacts(entries);

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
        messages.push(
          new Message({
            role: role ?? "user",
            content: entry.content,
            images: entry.images as ImageAttachment[] | undefined,
            source: origin,
          }),
        );
        break;
      }

      case LOG_SOURCE.LLM: {
        messages.push(
          new Message({
            role: role ?? "assistant",
            content: entry.content,
            reasoningContent: entry.reasoning_content ?? null,
            toolCalls: entry.tool_calls ?? null,
            source: origin,
          }),
        );
        break;
      }

      case LOG_SOURCE.TOOL_RESULT: {
        messages.push(
          new Message({
            role: "tool",
            content: entry.content,
            toolCallId: entry.tool_call_id ?? null,
            source: origin ?? "tool",
          }),
        );
        break;
      }

      case LOG_SOURCE.COMPACTION: {
        messages.push(new Message({ role: "harness", source: "harness", content: entry.content }));
        break;
      }

      case LOG_SOURCE.TOKEN_USAGE: {
        const d = entry as unknown as Record<string, unknown>;
        agent.emitOutput?.("token_usage", {
          sessionPromptTokens: d.sessionPromptTokens as number,
          sessionCachedTokens: d.sessionCachedTokens as number,
          sessionCompletionTokens: d.sessionCompletionTokens as number,
          sessionTotalTokens: d.sessionTotalTokens as number,
          turns: d.turns as number,
          promptTokens: d.promptTokens as number,
          cachedTokens: d.cachedTokens as number,
          completionTokens: d.completionTokens as number,
          totalTokens: d.totalTokens as number,
          contextWindow: d.contextWindow as number,
        });
        break;
      }

      // Durability records are bookkeeping, not conversation: they classify
      // other entries (see the repair below) but never become messages.
      case LOG_SOURCE.TOOL_STARTED:
      case LOG_SOURCE.QUESTION_ASKED:
      case LOG_SOURCE.RESUME_ATTEMPT:
      case LOG_SOURCE.SESSION_START:
        break;

      default:
        break;
    }
  }

  // A crash between log flushes (or an interrupt mid-tool-execution) can leave
  // tool_calls without results, or results without calls -- either way the next
  // request is a guaranteed 400 on strict backends. Repair before replay so a
  // restored context is always wire-valid. The started records classify each
  // missing result (dispatched = outcome-unknown, never-dispatched = safe to
  // retry, no records in the log = no claim); asked-but-unanswered questions
  // are held open so the user's answer lands as the real tool result.
  const pendingQuestions = asked.filter((p) => !answered.has(p.toolCallId));
  const durabilityActive = started.size > 0;
  const { messages: repaired } = repairToolCalls(messages, {
    holdUnresolved: new Set(pendingQuestions.map((p) => p.toolCallId)),
    synthesisFor: (tc) =>
      started.has(tc.id)
        ? INTERRUPTED_OUTCOME_UNKNOWN
        : durabilityActive
          ? INTERRUPTED_NOT_STARTED
          : undefined,
  });
  for (const msg of repaired) {
    agent.addMessage(msg);
  }
  return { replayed: repaired.length, pendingQuestions, profile: lastProfile };
}
