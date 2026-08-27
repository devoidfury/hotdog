// Review tool — access session log data from within agent tool calls.

import {
  LOG_SOURCE,
  readSessionEntries,
  sessionsDir,
} from "../../core/session/session-log.ts";
import { join } from "node:path";
import { readdir, access, stat, readFile } from "node:fs/promises";
import {
  ToolResult,
  defaultCallDisplay,
  toolDef,
} from "../../core/extensions/tool-utils.ts";
import type { ToolMetadata } from "../../core/extensions/tool-registry.ts";

interface SessionSummary {
  id: string;
  last_modified: string;
  entry_count: number;
}

interface ToolIndexEntry {
  index: number;
  tool_name: string;
  arguments: string;
}

interface ParsedArgs {
  operation: string;
  session_id: string | null;
  limit: number;
  message_start: number | null;
  message_end: number | null;
}

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + "\u2026";
}

async function countEntries(filePath: string): Promise<number> {
  const content = await readFile(filePath, "utf-8");
  let count = 0;
  for (const line of content.split("\n")) {
    if (line.trim()) count++;
  }
  return count;
}

async function listSessions(limit: number): Promise<SessionSummary[]> {
  const dir = sessionsDir();

  try {
    await access(dir);
  } catch {
    return [];
  }

  const files = (await readdir(dir)).filter((f: string) =>
    f.endsWith(".jsonl"),
  );
  if (files.length === 0) return [];

  const sessions: Array<{
    id: string;
    last_modified: string;
    entry_count: number;
    mtime: number;
  }> = [];
  for (const file of files) {
    const sessionId = file.replace(/\.jsonl$/, "");
    const filePath = join(dir, file);
    let metadata;
    let entryCount;
    try {
      metadata = await stat(filePath);
      entryCount = await countEntries(filePath);
    } catch {
      // File vanished between readdir() and here (e.g. concurrent
      // `sessions cleanup`); skip it rather than failing the whole list.
      continue;
    }

    // Filter out sessions with only 1 entry
    if (entryCount <= 1) continue;

    const lastTs = new Date(metadata.mtime).toISOString();
    sessions.push({
      id: sessionId,
      last_modified: lastTs,
      entry_count: entryCount,
      mtime: metadata.mtime.getTime(),
    });
  }

  // Sort by modification time (ascending), take most recent
  sessions.sort((a, b) => a.mtime - b.mtime);
  const len = sessions.length;
  const start = Math.max(0, len - limit);
  return sessions.slice(start).map((s) => ({
    id: s.id,
    last_modified: s.last_modified,
    entry_count: s.entry_count,
  }));
}

// "get" is a summary view: user input messages plus the model's final stop
// responses (llm entries with no tool calls). Each entry keeps the full
// on-disk format with an `index` added, for use with "read_context".
async function getSessionSummary(
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  const entries = await readSessionEntries(sessionId);
  const summary: Record<string, unknown>[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const isUserInput =
      entry.source === LOG_SOURCE.INPUT || entry.source === LOG_SOURCE.PROMPT;
    const isStopResponse =
      entry.source === LOG_SOURCE.LLM &&
      (!entry.tool_calls || entry.tool_calls.length === 0);
    if (!isUserInput && !isStopResponse) continue;
    summary.push({ ...entry, index: i });
  }
  return summary;
}

async function getToolIndex(sessionId: string): Promise<ToolIndexEntry[]> {
  const entries = await readSessionEntries(sessionId);
  const indexEntries: ToolIndexEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const toolCalls = entry.tool_calls as
      | Array<{
          function?: { name?: string; arguments?: string };
        }>
      | null
      | undefined;

    if (toolCalls) {
      for (const tc of toolCalls) {
        const args = truncateContent(tc.function?.arguments || "", 500);
        indexEntries.push({
          index: i,
          tool_name: tc.function?.name || "",
          arguments: args,
        });
      }
    }
  }

  return indexEntries;
}

function parseArgs(input: string | null): ParsedArgs {
  if (!input || input.trim().length === 0) {
    return {
      operation: "list",
      session_id: null,
      limit: 10,
      message_start: null,
      message_end: null,
    };
  }
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    return {
      operation: (parsed.operation as string) || "list",
      session_id: (parsed.session_id as string) || null,
      limit: (parsed.limit as number) || 10,
      message_start:
        typeof parsed.message_start === "number" ? parsed.message_start : null,
      message_end:
        typeof parsed.message_end === "number" ? parsed.message_end : null,
    };
  } catch {
    return {
      operation: "list",
      session_id: null,
      limit: 10,
      message_start: null,
      message_end: null,
    };
  }
}

export class ReviewTool {
  static TOOL_NAME = "review";
  metadata: ToolMetadata = { sideEffects: false, difficulty: 5 };

  toToolDef() {
    return toolDef(
      ReviewTool.TOOL_NAME,
      "List recent sessions, get a session summary (user input + final model responses, with entry indexes), read a specific index range of session entries, or get a lightweight tool call index. Indexes position entries in the session; read_context uses the half-open range [message_start, message_end). Returns JSON data. Disabled by default; enable via profile whitelist.",
      {
        properties: {
          operation: {
            type: "string",
            description:
              'Operation: "list" (list recent sessions), "get" (session summary: user input + final model responses with indexes), "read_context" (entries in a specific index range), or "tool_index" (lightweight tool call index)',
            enum: ["list", "get", "read_context", "tool_index"],
          },
          session_id: {
            type: "string",
            description:
              'Session ID (required for "get", "read_context" and "tool_index" operations, optional for "list" to filter)',
          },
          message_start: {
            type: "integer",
            description:
              "First entry index, inclusive (0-based). Required for 'read_context'.",
          },
          message_end: {
            type: "integer",
            description:
              "Last entry index, exclusive. Required for 'read_context'. Must be greater than message_start.",
          },
          limit: {
            type: "integer",
            description:
              'Maximum number of sessions to list (default 10, only used for "list" operation)',
            minimum: 1,
            maximum: 100,
          },
        },
        required: ["operation"],
      },
    );
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(input, (args: Record<string, unknown>) => {
      switch (args.operation) {
        case "list":
          return `(list, limit=${args.limit})`;
        case "get":
          return `(get, session_id=${args.session_id || "?"})`;
        case "read_context":
          return `(read_context, session_id=${args.session_id || "?"}, ${args.message_start}-${args.message_end})`;
        case "tool_index":
          return `(tool_index, session_id=${args.session_id || "?"})`;
        default:
          return `(unknown op=${args.operation})`;
      }
    });
  }

  async execute(input: string | null): Promise<ToolResult> {
    const args = parseArgs(input);

    switch (args.operation) {
      case "list": {
        const limit = Math.min(100, Math.max(1, args.limit));
        const sessions = await listSessions(limit);
        return ToolResult.ok(JSON.stringify(sessions)).withEntries({
          operation: "list",
          session_count: String(sessions.length),
        });
      }
      case "get": {
        if (!args.session_id) {
          return ToolResult.err(
            "Error: session_id is required for 'get' operation",
          );
        }
        const summary = await getSessionSummary(args.session_id);
        return ToolResult.ok(JSON.stringify(summary)).withEntries({
          operation: "get",
          session_id: args.session_id,
          entry_count: String(summary.length),
        });
      }
      case "read_context": {
        if (!args.session_id) {
          return ToolResult.err(
            "Error: session_id is required for 'read_context' operation",
          );
        }
        const start = args.message_start;
        const end = args.message_end;
        if (
          typeof start !== "number" ||
          typeof end !== "number" ||
          !Number.isInteger(start) ||
          !Number.isInteger(end)
        ) {
          return ToolResult.err(
            "Error: 'read_context' requires integer 'message_start' and 'message_end' (half-open range: message_start <= index < message_end)",
          );
        }
        if (start < 0 || end < start) {
          return ToolResult.err(
            `Error: invalid range [${start}, ${end}) -- require 0 <= message_start <= message_end`,
          );
        }
        const entries = await readSessionEntries(args.session_id);
        if (start > entries.length || end > entries.length) {
          return ToolResult.err(
            `Error: range [${start}, ${end}) out of bounds -- session has ${entries.length} entries (valid range 0..${entries.length})`,
          );
        }
        const slice = entries
          .slice(start, end)
          .map((entry, i) => ({ ...entry, index: start + i }));
        return ToolResult.ok(JSON.stringify(slice)).withEntries({
          operation: "read_context",
          session_id: args.session_id,
          entry_count: String(slice.length),
        });
      }
      case "tool_index": {
        if (!args.session_id) {
          return ToolResult.err(
            "Error: session_id is required for 'tool_index' operation",
          );
        }
        const index = await getToolIndex(args.session_id);
        return ToolResult.ok(JSON.stringify(index)).withEntries({
          operation: "tool_index",
          session_id: args.session_id,
          tool_call_count: String(index.length),
        });
      }
      default:
        return ToolResult.err(
          `Error: Unknown operation: '${args.operation}'. Use 'list', 'get', 'read_context', or 'tool_index'.`,
        );
    }
  }
}
