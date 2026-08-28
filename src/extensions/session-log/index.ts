// Session Log Extension
// Append-only JSONL audit trail for observability.

import { join } from "node:path";
import { appendFile, readFile, access, mkdir } from "node:fs/promises";
import { HOOKS } from "../../core/hooks.ts";
import { stripNulls } from "../../utils/objects.ts";
import { CoreContext, ExtensionInstance } from "../../core/extensions/types.ts";

import { LOG_SOURCE, sessionsDir, type LogEntry } from "../../core/session/session-log.ts";

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
  if (
    Array.isArray(raw) &&
    raw.some((p) => p != null && typeof p === "object" && (p as Record<string, unknown>).type === "untrusted")
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
  return stripNulls({
    ts: new Date().toISOString(),
    session_id: message.sessionId || "unknown",
    role: message.role,
    source,
    content: message.content,
    reasoning_content: message.reasoningContent || null,
    tool_calls: message.toolCalls || null,
    tool_call_id: message.toolCallId || null,
    tool_name: null,
    // Provenance: recorded for every message so resume replay restores the
    // exact source (and the mangle exemption for "harness").
    origin: message.source ?? null,
  }) as LogEntry;
}

/**
 * Create the session log extension.
 * Uses the current agent's session ID (from the hook context) for the log file.
 */
export async function create(_core: CoreContext): Promise<ExtensionInstance> {
  // Canonical sessions dir (respects HOTDOG_SESSIONS_DIR for tests).
  const cacheDir = sessionsDir();
  await mkdir(cacheDir, { recursive: true });

  // Track session state
  let isRestoring = false;
  // Track the most recent session ID so readEntries/getLogPath work correctly.
  let lastSessionId: string | null = null;

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
      }) => {
        // Skip logging during session restoration to avoid duplicate entries
        if (isRestoring) return;

        const sessionId = agent.sessionId || "unknown";
        lastSessionId = sessionId;
        const logPath = join(cacheDir, `${sessionId}.jsonl`);

        // Map message role to the correct log source type
        let source: string;
        switch (message.role) {
          case "user":
            source = LOG_SOURCE.INPUT;
            break;
          case "assistant":
            source = LOG_SOURCE.LLM;
            break;
          case "tool":
            source = LOG_SOURCE.TOOL_RESULT;
            break;
          case "system":
            // Non-initial system messages (e.g. task completion) should be
            // logged as user messages with wrapper — but at this point they're
            // already wrapped as user messages by the caller. If a bare system
            // message somehow makes it here, log it as a user input to avoid
            // mislabeling it as the initial system prompt.
            source = LOG_SOURCE.INPUT;
            break;
          case "harness":
            // Harness-injected message; replayed via its "harness" origin.
            source = LOG_SOURCE.INPUT;
            break;
          default:
            source = LOG_SOURCE.INPUT;
        }

        const entry = messageToLogEntry({
          sessionId: agent.sessionId,
          role: message.role,
          content: logContent(message),
          reasoningContent: message.reasoningContent,
          toolCalls: message.toolCalls,
          toolCallId: message.toolCallId,
          source: message.source,
        }, source);
        await appendFile(logPath, JSON.stringify(entry) + "\n");
      },

      /**
       * Log compaction results.
       */
      [HOOKS.OUTPUT_EVENT]: async ({ type, data, agent }) => {
        if (type === "compaction_result") {
          const compactionData = data as { summary?: string; messagesCompacted?: number };
          if (compactionData?.summary) {
            const sessionId = agent.sessionId || "unknown";
            lastSessionId = sessionId;
            const logPath = join(cacheDir, `${sessionId}.jsonl`);
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
            await appendFile(logPath, JSON.stringify(entry) + "\n");
          }
        }
      },
    },

    // Expose for external use (sessionId is dynamic, determined per-request)
    sessionId: null,
    logPath: null,

    /**
     * Read all entries from the session log.
     * Uses the most recently observed session ID.
     */
    async readEntries(): Promise<Record<string, LogEntry>[]> {
      if (!lastSessionId) return [];
      const logPath = join(cacheDir, `${lastSessionId}.jsonl`);
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
      return join(cacheDir, `${lastSessionId}.jsonl`);
    },
  };
}

