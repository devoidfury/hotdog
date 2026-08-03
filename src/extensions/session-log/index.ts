// Session Log Extension
// Append-only JSONL audit trail for observability.

import { homedir } from "node:os";
import { join } from "node:path";
import { appendFile, readFile, access, mkdir } from "node:fs/promises";
import { HOOKS } from "../../core/hooks.ts";
import { stripNulls } from "../../utils/objects.ts";
import { CoreContext, ExtensionInstance } from "../../core/extensions/types.ts";

// Re-export core session log functions and types
export {
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

// Import LOG_SOURCE and LogEntry for internal use
import { LOG_SOURCE, type LogEntry } from "../../core/session/session-log.ts";

interface SessionLogMessage {
  sessionId?: string;
  role: string | undefined;
  content?: string | Array<unknown>;
  reasoningContent?: string | null;
  toolCalls?: unknown;
  toolCallId?: string | null;
}


/**
 * Get the cache directory for session logs.
 */
async function getCacheDir(): Promise<string> {
  const cacheDir = join(homedir(), ".cache", "hotdog", "sessions");
  try {
    await access(cacheDir);
  } catch {
    await mkdir(cacheDir, { recursive: true });
  }
  return cacheDir;
}

/**
 * Create a log entry from a message.
 */
function messageToLogEntry(message: SessionLogMessage, source: string): LogEntry {
  return stripNulls({
    ts: new Date().toISOString(),
    session_id: message.sessionId || "unknown",
    role: message.role,
    source,
    content: message.content || "",
    reasoning_content: message.reasoningContent || null,
    tool_calls: message.toolCalls || null,
    tool_call_id: message.toolCallId || null,
    tool_name: null,
  }) as LogEntry;
}

/**
 * Create the session log extension.
 * Uses the current agent's session ID (from the hook context) for the log file.
 */
export async function create(_core: CoreContext): Promise<ExtensionInstance> {
  const cacheDir = await getCacheDir();

  // Track session state
  let systemPromptWritten = false;
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
          default:
            source = LOG_SOURCE.INPUT;
        }

        const entry = messageToLogEntry({
          sessionId: agent.sessionId,
          role: message.role,
          content: typeof message.getTextContent === "function" ? message.getTextContent() : message.content || "",
          reasoningContent: message.reasoningContent,
          toolCalls: message.toolCalls,
          toolCallId: message.toolCallId,
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
            const entry = stripNulls({
              ts: new Date().toISOString(),
              session_id: sessionId,
              source: LOG_SOURCE.COMPACTION,
              summary: compactionData.summary,
              messages_compacted: compactionData.messagesCompacted,
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

/**
 * Create a disabled session log (no-op).
 */
export function disabledSessionLog(): {
  sessionId: null;
  logPath: null;
  writeInput: (...args: unknown[]) => void;
  writeSystemPrompt: (...args: unknown[]) => void;
  writeAssistant: (...args: unknown[]) => void;
  writeToolResult: (...args: unknown[]) => void;
  writeReset: (...args: unknown[]) => void;
  readEntries: () => [];
  getLogPath: () => null;
} {
  return {
    sessionId: null,
    logPath: null,
    writeInput() {},
    writeSystemPrompt() {},
    writeAssistant() {},
    writeToolResult() {},
    writeReset() {},
    readEntries() {
      return [];
    },
    getLogPath() {
      return null;
    },
  };
}
