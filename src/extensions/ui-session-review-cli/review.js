// Review tool — access session log data from within agent tool calls.
//
// Provides three operations:
// - `list`: List recent sessions (same format as `review --json`)
// - `get`: Get all entries for a specific session
// - `tool_index`: Get a lightweight index of tool calls (name, index, args only)
//
// Disabled by default; enable via profile whitelist.

import { readSessionEntries } from '../../core/session/session-log.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, access, stat } from 'node:fs/promises';
import { ToolResult, defaultCallDisplay } from '../../core/extensions/tool-utils.js';

/**
 * Truncate content to max_len bytes, appending '…' if truncated.
 */
function truncateContent(content, maxLength) {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + '\u2026';
}

/**
 * Get the sessions directory path.
 */
function sessionsDir() {
  const home = homedir();
  return join(home, '.cache', 'oa-agent', 'sessions');
}

/**
 * List sessions, returning JSON array of summaries.
 */
async function listSessions(limit) {
  const dir = sessionsDir();

  try {
    await access(dir);
  } catch {
    return [];
  }

  const files = (await readdir(dir)).filter(f => f.endsWith('.jsonl'));
  if (files.length === 0) return [];

  const sessions = [];
  for (const file of files) {
    const sessionId = file.replace(/\.jsonl$/, '');
    const filePath = join(dir, file);
    const metadata = await stat(filePath);
    const entries = await readSessionEntries(sessionId);

    // Filter out sessions with only 1 entry
    if (entries.length <= 1) continue;

    const lastTs = new Date(metadata.mtime).toISOString();
    sessions.push({
      id: sessionId,
      last_modified: lastTs,
      entry_count: entries.length,
      mtime: metadata.mtime.getTime(),
    });
  }

  // Sort by modification time (ascending), take most recent
  sessions.sort((a, b) => a.mtime - b.mtime);
  const len = sessions.length;
  const start = Math.max(0, len - limit);
  return sessions.slice(start).map(s => ({
    id: s.id,
    last_modified: s.last_modified,
    entry_count: s.entry_count,
  }));
}

/**
 * Get a specific session's entries as a JSON array.
 */
async function getSession(sessionId) {
  const entries = await readSessionEntries(sessionId);
  return entries;
}

/**
 * Get a lightweight index of tool calls in a session.
 */
async function getToolIndex(sessionId) {
  const entries = await readSessionEntries(sessionId);
  const indexEntries = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.tool_calls) {
      for (const tc of entry.tool_calls) {
        const args = truncateContent(tc.function?.arguments || '', 500);
        indexEntries.push({
          index: i,
          tool_name: tc.function?.name || '',
          arguments: args,
        });
      }
    }
  }

  return indexEntries;
}

/**
 * Parse tool arguments from JSON string.
 */
function parseArgs(input) {
  if (!input || input.trim().length === 0) {
    return { operation: 'list', session_id: null, limit: 10 };
  }
  try {
    const parsed = JSON.parse(input);
    return {
      operation: parsed.operation || 'list',
      session_id: parsed.session_id || null,
      limit: parsed.limit || 10,
    };
  } catch {
    return { operation: 'list', session_id: null, limit: 10 };
  }
}

export class ReviewTool {
  static TOOL_NAME = 'review';

  toToolDef() {
    return {
      type: 'function',
      function: {
        name: 'review',
        description:
          'List recent sessions, get all entries for a specific session, or get a lightweight tool call index. Returns JSON data. Disabled by default; enable via profile whitelist.',
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              description:
                'Operation: "list" (list recent sessions), "get" (get session entries), or "tool_index" (get lightweight tool call index)',
              enum: ['list', 'get', 'tool_index'],
            },
            session_id: {
              type: 'string',
              description:
                'Session ID (required for "get" and "tool_index" operations, optional for "list" to filter)',
            },
            limit: {
              type: 'integer',
              description:
                'Maximum number of sessions to list (default 10, only used for "list" operation)',
              minimum: 1,
              maximum: 100,
            },
          },
          required: ['operation'],
        },
      },
    };
  }

  callDisplay(input) {
    return defaultCallDisplay(input, (args) => {
      switch (args.operation) {
        case 'list':
          return `(list, limit=${args.limit})`;
        case 'get':
          return `(get, session_id=${args.session_id || '?'})`;
        case 'tool_index':
          return `(tool_index, session_id=${args.session_id || '?'})`;
        default:
          return `(unknown op=${args.operation})`;
      }
    });
  }

  async execute(input) {
    const args = parseArgs(input);

    switch (args.operation) {
      case 'list': {
        const limit = Math.min(100, Math.max(1, args.limit));
        const sessions = await listSessions(limit);
        return ToolResult.ok(JSON.stringify(sessions)).withEntries({
          operation: 'list',
          session_count: String(sessions.length),
        });
      }
      case 'get': {
        if (!args.session_id) {
          return ToolResult.err('Error: session_id is required for \'get\' operation');
        }
        const entries = await getSession(args.session_id);
        return ToolResult.ok(JSON.stringify(entries)).withEntries({
          operation: 'get',
          session_id: args.session_id,
          entry_count: String(entries.length),
        });
      }
      case 'tool_index': {
        if (!args.session_id) {
          return ToolResult.err('Error: session_id is required for \'tool_index\' operation');
        }
        const index = await getToolIndex(args.session_id);
        return ToolResult.ok(JSON.stringify(index)).withEntries({
          operation: 'tool_index',
          session_id: args.session_id,
          tool_call_count: String(index.length),
        });
      }
      default:
        return ToolResult.err(`Error: Unknown operation: '${args.operation}'. Use 'list', 'get', or 'tool_index'.`);
    }
  }
}
