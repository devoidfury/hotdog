// Session log — append-only JSONL audit trail for observability.
// Each session gets a file at ~/.cache/oa-agent/sessions/<uuid>.jsonl.
// Messages are appended as JSON lines. The file is never truncated or modified.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { Message } from "../../src/context/message.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Strip null fields from an object for serialization.
 */
export function stripNulls(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null) {
      result[k] = v;
    }
  }
  return result;
}

// ── Log Source Types ────────────────────────────────────────────────────────

export const LOG_SOURCE = {
  SYSTEM_PROMPT: "system_prompt",
  INPUT: "input",
  LLM: "llm",
  TOOL_RESULT: "tool_result",
  RESET: "reset",
  COMPACTION: "compaction",
  PROMPT: "prompt",
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
 * Read all entries from a specific session file, replaying from the last reset.
 */
export function readSessionEntries(sessionId) {
  const path = sessionPath(sessionId);
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  const entries = [];
  let lastResetIdx = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    try {
      const entry = JSON.parse(trimmed);
      entries.push(entry);
      if (entry.source === LOG_SOURCE.RESET) {
        // Track the index AFTER the reset entry (skip the reset itself)
        lastResetIdx = entries.length;
      }
    } catch {
      // Skip malformed lines
      // TODO: log warning
    }
  }

  // Replay from the last reset event (or beginning if no reset)
  return entries.slice(lastResetIdx ?? 0);
}

/**
 * Read all entries from all session files.
 */
export function readAllSessions() {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];

  const allEntries = [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));

  for (const file of files) {
    const path = join(dir, file);
    const content = readFileSync(path, "utf-8");

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        allEntries.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines
        // TODO: log warning
      }
    }
  }

  return allEntries;
}

/**
 * Check if a session file exists.
 */
export function sessionExists(sessionId) {
  return existsSync(sessionPath(sessionId));
}

/**
 * Replay log entries into an agent's context.
 *
 * Takes an array of log entries (from readSessionEntries) and converts them
 * to Message objects, adding them to the agent's context. This allows the
 * agent to "continue" a previous conversation.
 *
 * System prompt entries are skipped — the agent regenerates them dynamically
 * via ensureSystemPrompt().
 *
 * Compaction entries (role: "system", source: LOG_SOURCE.COMPACTION) are
 * added as user messages, since compaction summaries appear in context as
 * user messages wrapped in <previous-context-summary> tags.
 *
 * @param {import("../../src/core/agent.js").Agent} agent - The agent whose context to populate
 * @param {Array<object>} entries - Log entries from readSessionEntries()
 * @returns {number} The number of entries actually replayed (excluding skipped ones)
 */
export function replayEntriesIntoContext(agent, entries) {
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
        if (typeof agent.context.addUserMessage === "function") {
          agent.context.addUserMessage(entry.content);
        } else {
          agent.context.push(
            new Message({ role: "user", content: entry.content }),
          );
        }
        replayed++;
        break;
      }

      case LOG_SOURCE.LLM: {
        // Assistant response — preserve reasoning content and tool calls
        if (typeof agent.context.addAssistantMessage === "function") {
          agent.context.addAssistantMessage(
            entry.content,
            entry.reasoning_content || null,
            entry.tool_calls || null,
          );
        } else {
          agent.context.push(
            new Message({
              role: "assistant",
              content: entry.content,
              reasoningContent: entry.reasoning_content || null,
              toolCalls: entry.tool_calls || null,
            }),
          );
        }
        replayed++;
        break;
      }

      case LOG_SOURCE.TOOL_RESULT: {
        // Tool result — use addMessage or push directly
        if (typeof agent.context.addMessage === "function") {
          agent.context.addMessage({
            role: "tool",
            content: entry.content,
            reasoningContent: null,
            toolCalls: null,
            toolCallId: entry.tool_call_id || null,
          });
        } else {
          agent.context.push(
            new Message({
              role: "tool",
              content: entry.content,
              reasoningContent: null,
              toolCalls: null,
              toolCallId: entry.tool_call_id || null,
            }),
          );
        }
        replayed++;
        break;
      }

      case LOG_SOURCE.COMPACTION: {
        // Compaction summary — added as user message in context
        // (the agent sees it as a user message with <m_r3hthso4y9htef72> tags)
        if (typeof agent.context.addUserMessage === "function") {
          agent.context.addUserMessage(entry.content);
        } else {
          agent.context.push(
            new Message({ role: "user", content: entry.content }),
          );
        }
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

/**
 * Get current timestamp string.
 */
function now() {
  const d = new Date();
  return d.toISOString();
}
