// Session Log Extension
// Append-only JSONL audit trail for observability.
// Hooks: context:message, tool:afterExecute, output:event

import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { HOOKS } from '../../src/hooks.js';

// ── Log Source Types ────────────────────────────────────────────────────────

export const LOG_SOURCE = {
  SYSTEM_PROMPT: 'system_prompt',
  INPUT: 'input',
  LLM: 'llm',
  TOOL_RESULT: 'tool_result',
  RESET: 'reset',
  COMPACTION: 'compaction',
  PROMPT: 'prompt',
};

/**
 * Get the cache directory for session logs.
 */
function getCacheDir() {
  const cacheDir = join(homedir(), '.cache', 'oa-agent', 'sessions');
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
  return cacheDir;
}

/**
 * Strip null fields from an object for serialization.
 */
function stripNulls(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null) {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Create a log entry from a message.
 */
function messageToLogEntry(message, source) {
  return stripNulls({
    ts: new Date().toISOString(),
    session_id: message.sessionId || 'unknown',
    role: message.role,
    source,
    content: message.content || '',
    reasoning_content: message.reasoningContent || null,
    tool_calls: message.toolCalls || null,
    tool_call_id: message.toolCallId || null,
    tool_name: null,
  });
}

/**
 * Create the session log extension.
 */
export function create(core) {
  const sessionId = crypto.randomUUID();
  const cacheDir = getCacheDir();
  const logPath = join(cacheDir, `${sessionId}.jsonl`);

  // Track session state
  let systemPromptWritten = false;

  return {
    hooks: {
      /**
       * Log messages as they enter the context.
       */
      [HOOKS.CONTEXT_MESSAGE]: ({ message }) => {
        const entry = messageToLogEntry(message, LOG_SOURCE.INPUT);
        appendFileSync(logPath, JSON.stringify(entry) + '\n');
      },

      /**
       * Log tool results.
       */
      [HOOKS.TOOL_AFTER_EXECUTE]: ({ toolName, result }) => {
        const entry = stripNulls({
          ts: new Date().toISOString(),
          session_id: sessionId,
          source: LOG_SOURCE.TOOL_RESULT,
          tool_name: toolName,
          result: typeof result === 'string' ? result : JSON.stringify(result),
        });
        appendFileSync(logPath, JSON.stringify(entry) + '\n');
      },

      /**
       * Log compaction results.
       */
      [HOOKS.OUTPUT_EVENT]: ({ type, data }) => {
        if (type === 'compaction_result' && data?.summary) {
          const entry = stripNulls({
            ts: new Date().toISOString(),
            session_id: sessionId,
            source: LOG_SOURCE.COMPACTION,
            summary: data.summary,
            messages_compacted: data.messagesCompacted,
          });
          appendFileSync(logPath, JSON.stringify(entry) + '\n');
        }
      },
    },

    // Expose for external use
    sessionId,
    logPath,

    /**
     * Read all entries from the session log.
     */
    readEntries() {
      if (!existsSync(logPath)) return [];
      const content = readFileSync(logPath, 'utf-8');
      return content.split('\n').filter(Boolean).map(line => JSON.parse(line));
    },

    /**
     * Get the session log path.
     */
    getLogPath() {
      return logPath;
    },
  };
}

/**
 * Read session entries from a specific session by ID.
 * Used by subcommands to review sessions.
 */
export function readSessionEntries(sessionId) {
  const cacheDir = join(homedir(), '.cache', 'oa-agent', 'sessions');
  const path = join(cacheDir, `${sessionId}.jsonl`);
  if (!existsSync(path)) return [];

  const content = readFileSync(path, 'utf-8');
  return content.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/**
 * Create a disabled session log (no-op).
 */
export function disabledSessionLog() {
  return {
    sessionId: null,
    logPath: null,
    writeInput() {},
    writeSystemPrompt() {},
    writeAssistant() {},
    writeToolResult() {},
    writeReset() {},
    readEntries() { return []; },
    getLogPath() { return null; },
  };
}
