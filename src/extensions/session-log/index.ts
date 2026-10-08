// Session Log Extension
// Append-only JSONL audit trail for observability.

import { appendFile, open, readFile, access, mkdir } from "node:fs/promises";
import { HOOKS, type GateAction } from "@core/hooks.ts";
import { stripNulls } from "@utils/objects.ts";
import { CoreContext, ExtensionInstance } from "@core/extensions/types.ts";
import { isWrapperPart, isToolResultPart } from "@core/context/wrappers.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";

import { LOG_SOURCE, sessionPath, sessionsDir, type LogEntry } from "@core/session/session-log.ts";

interface SessionLogMessage {
  sessionId?: string;
  role: string | undefined;
  content?: string | Array<unknown>;
  reasoningContent?: string | null;
  toolCalls?: unknown;
  toolCallId?: string | null;
  /** Message provenance (Message.source); recorded as `origin` on the entry. */
  source?: string;
  /** Present when the payload is a live Message (not raw log data). */
  getTextContent?: () => string;
}


/**
 * Content to persist: structured content (harness messages with `untrusted`
 * parts) is kept as raw parts so replay restores the exact trust structure;
 * everything else stays plain text (images stripped) as before.
 */
function logContent(message: SessionLogMessage): string | Array<Record<string, unknown>> {
  const raw = message.content;
  // Raw parts ride the log as-is when they carry harness structure:
  // `untrusted` payloads (mangled only at the wire) and wrapper parts -- a
  // tool-result part must round-trip as DATA, since rendering it here would
  // bake one WireFormat's shape into a log that other formats (and the UI)
  // have to read.
  if (
    Array.isArray(raw) &&
    raw.some(
      (p) =>
        p != null &&
        typeof p === "object" &&
        ((p as Record<string, unknown>).type === "untrusted" || isWrapperPart(p)),
    )
  ) {
    return raw as Array<Record<string, unknown>>;
  }
  if (typeof message.getTextContent === "function") return message.getTextContent();
  return (raw as string | undefined) || "";
}

/**
 * Create a log entry from a message.
 */
function messageToLogEntry(
  message: SessionLogMessage & { content: string | Array<Record<string, unknown>> },
  source: string,
): LogEntry {
  // The executor's tool messages carry one ToolResultPart; its `tool` is the
  // authoritative name. Legacy string contents have no part, so no name.
  const toolResult = Array.isArray(message.content)
    ? (message.content as unknown[]).find(isToolResultPart)
    : undefined;
  return stripNulls({
    ts: new Date().toISOString(),
    session_id: message.sessionId || "unknown",
    role: message.role,
    source,
    content: message.content,
    reasoning_content: message.reasoningContent || null,
    tool_calls: message.toolCalls || null,
    tool_call_id: message.toolCallId || null,
    tool_name: toolResult?.tool ?? null,
    // Provenance: recorded for every message so resume replay restores the
    // exact source (and the mangle exemption for "harness").
    origin: message.source ?? null,
  }) as LogEntry;
}

/**
 * Create the session log extension.
 * Uses the current agent's session ID (from the hook context) for the log file.
 */
export async function create(core: CoreContext): Promise<ExtensionInstance> {
  // `--no-log` / HOTDOG_NO_LOG / noLog config
  if (core.resolved?.noLog) return {};

  // Canonical sessions dir (respects HOTDOG_SESSIONS_DIR for tests).
  const cacheDir = sessionsDir();
  await mkdir(cacheDir, { recursive: true });

  // Track session state
  let isRestoring = false;
  // Durability-barrier failures keyed by tool call id (set when that call's
  // tool_started fsync fails). notifyHooks swallows handler errors, so the
  // failure cannot propagate from TOOL_BEFORE_EXECUTE -- the TOOL_CALL gate
  // below refuses the call instead. Per-call, never a global flag: this
  // instance is shared across webui sessions, and another session's landed
  // write must not rescue a call whose own record is missing (replay would
  // read it as "never ran, safe to retry" when it may have run).
  const barrierFailures = new Map<string, string>();
  // Track the most recent session ID so readEntries/getLogPath work correctly.
  let lastSessionId: string | null = null;

  // Serialize writes per session file. Hook handlers fire independently (addMessage
  // does not await notifyHooks), so floating appendFile calls can land out of dispatch
  // order -- e.g. a /fork's first prompt entry written below the copied history it
  // should follow. Chaining keeps file order equal to hook dispatch order, which holds
  // because handlers enqueue synchronously (async handlers run to their first await
  // before the next dispatch).
  const writeQueues = new Map<string, Promise<void>>();
  const queuedAppend = (logPath: string, line: string): Promise<void> => {
    const prev = writeQueues.get(logPath) ?? Promise.resolve();
    // Chain on either outcome: one failed write must not poison the queue.
    const next = prev.then(
      () => appendFile(logPath, line),
      () => appendFile(logPath, line),
    );
    writeQueues.set(logPath, next);
    return next;
  };

  /**
   * Durability-class append: same write queue (file order = dispatch order),
   * fsynced so the record and everything appended before it survives
   * kill -9 / power loss. Only for records whose presence on disk carries
   * meaning: tool_started, question_asked.
   */
  const queuedFsyncAppend = (logPath: string, line: string): Promise<void> => {
    const prev = writeQueues.get(logPath) ?? Promise.resolve();
    const write = async () => {
      const fh = await open(logPath, "a");
      try {
        await fh.appendFile(line);
        await fh.sync();
      } finally {
        await fh.close();
      }
    };
    const next = prev.then(write, write);
    writeQueues.set(logPath, next);
    return next;
  };

  /** Validate + remember the log path for a session id; null when rejected. */
  const resolveLogPath = (sessionId: string): string | null => {
    try {
      const logPath = sessionPath(sessionId);
      lastSessionId = sessionId;
      return logPath;
    } catch (err) {
      logger.warn(`[session-log] rejected session id: ${formatError(err)}`);
      return null;
    }
  };

  /** Map message role to the correct log source type. */
  const logSourceForRole = (role: string | undefined): string => {
    switch (role) {
      case "assistant":
        return LOG_SOURCE.LLM;
      case "tool":
        return LOG_SOURCE.TOOL_RESULT;
      case "user":
      case "system":
      case "harness":
      default:
        // Non-initial system messages (e.g. task completion) should be logged as user messages with wrapper --
        // but at this point they're already wrapped as user messages by the caller. If a bare system message
        // somehow makes it here, log it as a user input to avoid mislabeling it as the initial system prompt.
        // Harness-injected messages replay via their "harness" origin.
        return LOG_SOURCE.INPUT;
    }
  };

  /** Append one message to the agent's session log (validated path). */
  const appendMessageEntry = async (
    agent: { sessionId?: string },
    message: SessionLogMessage,
  ): Promise<void> => {
    const sessionId = agent.sessionId || "unknown";
    let logPath: string;
    try {
      logPath = sessionPath(sessionId);
    } catch (err) {
      logger.warn(`[session-log] rejected session id: ${formatError(err)}`);
      return;
    }
    lastSessionId = sessionId;

    const entry = messageToLogEntry(
      {
        sessionId: agent.sessionId,
        role: message.role,
        content: logContent(message),
        reasoningContent: message.reasoningContent,
        toolCalls: message.toolCalls,
        toolCallId: message.toolCallId,
        source: message.source,
      },
      logSourceForRole(message.role),
    );
    await queuedAppend(logPath, JSON.stringify(entry) + "\n");
  };

  return {
    hooks: {
      /**
       * Track session restoration state via hook — avoids reading private fields.
       */
      [HOOKS.SESSION_RESTORE_ACTIVE]: ({
        isRestoring: restoring,
      }: {
        isRestoring: boolean;
      }) => {
        isRestoring = restoring;
      },

      /**
       * Log messages as they enter the context.
       * Uses the agent's sessionId from the hook context to determine the log file.
       * Maps message roles to the correct log source types for proper replay.
       */
      [HOOKS.CONTEXT_MESSAGE]: async ({
        message,
        agent,
      }: {
        message: SessionLogMessage;
        agent: { sessionId?: string };
      }) => {
        // Skip logging during session restoration to avoid duplicate entries
        if (isRestoring) return;
        await appendMessageEntry(agent, message);
      },

      /**
       * Checkpoint the log on a deliberate rewind (/undo, /rewind, /clear): append a reset entry, then re-append the kept messages.
       * Replay slices from the last reset, so resume (and any fork of this session) sees exactly the rewound context while the
       * log stays append-only (the undone history remains above the marker for audit).
       *
       * System-role messages are skipped: the system prompt is regenerated on replay, so writing it would resurface it as a user message.
       */
      [HOOKS.CONTEXT_REWOUND]: async ({
        agent,
        newContext,
      }: {
        agent: { sessionId?: string };
        newContext: SessionLogMessage[];
      }) => {
        if (isRestoring) return;

        const sessionId = agent.sessionId || "unknown";
        let logPath: string;
        try {
          logPath = sessionPath(sessionId);
        } catch (err) {
          logger.warn(`[session-log] rejected session id: ${formatError(err)}`);
          return;
        }
        lastSessionId = sessionId;

        const resetEntry = stripNulls({
          ts: new Date().toISOString(),
          session_id: sessionId,
          source: LOG_SOURCE.RESET,
          content: "",
        });

        // Enqueue the whole checkpoint synchronously (no await in between): the
        // block must be atomic in queue order, or a message dispatched mid-checkpoint
        // would replay between the reset marker and the kept history.
        let done = queuedAppend(logPath, JSON.stringify(resetEntry) + "\n");
        for (const message of newContext || []) {
          if (message.role === "system") continue;
          // appendMessageEntry queues synchronously before its first await.
          done = appendMessageEntry(agent, message);
        }
        await done;
      },

      /**
       * Write the tool_started record on the executor's awaited hook, so the
       * fsync lands the record (and the tool_calls entry appended before it)
       * before any side effect runs. Classification semantics: see
       * LOG_SOURCE.TOOL_STARTED.
       */
      [HOOKS.TOOL_BEFORE_EXECUTE]: async ({
        toolCallId,
        toolName,
        input,
        agent,
      }: {
        toolCallId?: string;
        toolName: string;
        input: string;
        agent: { sessionId?: string };
      }) => {
        if (!toolCallId) return; // no id to tie the record (and any replay) to
        const logPath = resolveLogPath(agent.sessionId || "unknown");
        if (!logPath) return;
        const entry = stripNulls({
          ts: new Date().toISOString(),
          session_id: agent.sessionId || "unknown",
          source: LOG_SOURCE.TOOL_STARTED,
          content: input,
          tool_call_id: toolCallId,
          tool_name: toolName,
        });
        // A rejection here is invisible to the executor (notifyHooks swallows
        // handler errors): catch, remember it against the call id, and let
        // the TOOL_CALL gate refuse it.
        try {
          await queuedFsyncAppend(logPath, JSON.stringify(entry) + "\n");
          barrierFailures.delete(toolCallId);
        } catch (err) {
          const why = formatError(err);
          barrierFailures.set(toolCallId, why);
          logger.error(
            `[session-log] durability barrier failed: ${why} -- tool ${toolCallId} is blocked until its record can be written`,
          );
        }
      },

      /**
       * Fail-closed gate: a call whose own tool_started write failed does not
       * run. The block surfaces to the model as a normal blocked tool result.
       * A retry is a new call id with a fresh barrier attempt.
       */
      [HOOKS.TOOL_CALL]: ({ toolCallId }: { toolCallId?: string }): GateAction | undefined => {
        if (typeof toolCallId !== "string" || toolCallId === "") return undefined;
        const failure = barrierFailures.get(toolCallId);
        if (!failure) return undefined;
        // The call is answered once (the block); forget its failure so the
        // map cannot accumulate stale ids.
        barrierFailures.delete(toolCallId);
        return {
          action: "block",
          result:
            `Tool not executed: the session log is unwritable (${failure}), so this call could not be recorded ` +
            "before its side effects. Fix the sessions directory (disk space / permissions) and retry. " +
            "If you accept losing crash-resume safety for this session, disable logging with --no-log.",
        };
      },

      /**
       * Log compaction results.
       */
      [HOOKS.OUTPUT_EVENT]: async ({ type, data, agent }) => {
        // Durability record for a question put to the UI (see
        // LOG_SOURCE.QUESTION_ASKED): fsynced but fire-and-forget, since
        // OUTPUT_EVENT handlers are not awaited.
        if (type === "question") {
          const d = data as { toolCallId?: unknown; questions?: unknown };
          const toolCallId = typeof d.toolCallId === "string" ? d.toolCallId : "";
          const questions = Array.isArray(d.questions) ? d.questions : null;
          if (!toolCallId || !questions || questions.length === 0) return;
          const sessionId = agent.sessionId || "unknown";
          const logPath = resolveLogPath(sessionId);
          if (!logPath) return;
          const entry = stripNulls({
            ts: new Date().toISOString(),
            session_id: sessionId,
            source: LOG_SOURCE.QUESTION_ASKED,
            content: questions,
            tool_call_id: toolCallId,
          });
          await queuedFsyncAppend(logPath, JSON.stringify(entry) + "\n");
          return;
        }

        if (type === "compaction_result") {
          const compactionData = data as { summary?: string; messagesCompacted?: number };
          if (compactionData?.summary) {
            const sessionId = agent.sessionId || "unknown";
            let logPath: string;
            try {
              logPath = sessionPath(sessionId);
            } catch (err) {
              logger.warn(`[session-log] rejected session id: ${formatError(err)}`);
              return;
            }
            lastSessionId = sessionId;
            // Log the message exactly as it enters the context: harness
            // structure with the real wrapper tag parts around the RAW
            // model-generated summary (`untrusted` part, mangled only at the
            // wire). Never escape here: the log must stay re-serializable by
            // any future session's mangler.
            const tag = "previous-context-summary";
            const entry = stripNulls({
              ts: new Date().toISOString(),
              session_id: sessionId,
              source: LOG_SOURCE.COMPACTION,
              content: [
                { type: "text", text: `<${tag}>` },
                { type: "untrusted", text: compactionData.summary },
                { type: "text", text: `</${tag}>` },
              ],
              summary: compactionData.summary,
              messages_compacted: compactionData.messagesCompacted,
              // Compaction summaries are harness-generated content.
              origin: "harness",
            });
            await queuedAppend(logPath, JSON.stringify(entry) + "\n");
          }
        }
      },
    },

    /**
     * Read all entries from the session log.
     * Uses the most recently observed session ID.
     */
    async readEntries(): Promise<Record<string, LogEntry>[]> {
      if (!lastSessionId) return [];
      // lastSessionId is only set after a successful sessionPath() validation.
      const logPath = sessionPath(lastSessionId);
      // Drain the write queue: entries dispatched but not yet flushed (floating
      // hook writes) must be on disk before the read.
      const pending = writeQueues.get(logPath);
      if (pending) {
        try {
          await pending;
        } catch {}
      }
      try {
        await access(logPath);
      } catch {
        return [];
      }
      const content = await readFile(logPath, "utf-8");
      return content
        .split("\n")
        .filter(Boolean)
        .map((line: string) => JSON.parse(line));
    },

    /**
     * Get the session log path.
     * Returns the path for the most recently observed session ID.
     */
    getLogPath(): string | null {
      if (!lastSessionId) return null;
      return sessionPath(lastSessionId);
    },
  };
}

