// I/O utilities for tests — temp dirs, session files, tool result helpers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import { ToolResult } from '@core/extensions/tool-utils.ts';
import { ToolContext } from '@core/extensions/tool-context.ts';
import { Workspace } from '@utils/workspace.ts';
import { LOG_SOURCE, sessionPath, sessionsDir, type LogEntry } from '@core/session/session-log.ts';
import { stripNulls } from '@utils/objects.ts';
import type { ImageAttachment, ToolCall } from '@core/context/message.ts';

/**
 * Minimal JSONL session writer for tests — appends LogEntry lines in the
 * same on-disk format the session-log extension produces.
 */
export class TestSessionLog {
  readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  get path(): string {
    return sessionPath(this.sessionId);
  }

  async append(entry: LogEntry): Promise<void> {
    await mkdir(sessionsDir(), { recursive: true });
    await appendFile(this.path, JSON.stringify(stripNulls(entry)) + "\n");
  }

  async writeSystemPrompt(content: string): Promise<void> {
    await this.append({ ts: new Date().toISOString(), session_id: this.sessionId, source: LOG_SOURCE.SYSTEM_PROMPT, content });
  }

  async writeInput(content: string, images?: ImageAttachment[]): Promise<void> {
    await this.append({ ts: new Date().toISOString(), session_id: this.sessionId, source: LOG_SOURCE.INPUT, content, images });
  }

  async writeAssistant(content: string, toolCalls?: ToolCall[] | null, reasoningContent: string | null = null): Promise<void> {
    await this.append({
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      source: LOG_SOURCE.LLM,
      content,
      reasoning_content: reasoningContent,
      tool_calls: toolCalls,
    });
  }

  async writeToolResult(content: string, toolCallId?: string | null, toolName?: string): Promise<void> {
    await this.append({
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      source: LOG_SOURCE.TOOL_RESULT,
      content,
      tool_call_id: toolCallId ?? null,
      tool_name: toolName,
    });
  }

  async writeReset(): Promise<void> {
    await this.append({ ts: new Date().toISOString(), session_id: this.sessionId, source: LOG_SOURCE.RESET, content: "" });
  }

  async writeCompaction(messagesCompacted: number, summary: string): Promise<void> {
    await this.append({
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      source: LOG_SOURCE.COMPACTION,
      content: `[Compacted ${messagesCompacted} messages]\n\n${summary}`,
    });
  }
}

/**
 * Extract string output from a tool result (handles ToolResult or plain string).
 */
export function resultStr(result: unknown): string {
  if (result instanceof ToolResult) {
    if (result.error) {
      return result.error;
    }
    return result.output;
  }
  return String(result);
}

/**
 * Get display string from a tool result (calls toDisplay()).
 */
export function getDisplay(result: unknown): string {
  if (result && typeof result === 'object' && 'toDisplay' in result && typeof (result as any).toDisplay === 'function') {
    return (result as any).toDisplay();
  }
  return String(result);
}

/**
 * Create a temporary directory for file-based tests.
 */
export function tmpDir(prefix = 'hotdog-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Clean up a temporary directory recursively.
 */
export function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Create a ToolContext with optional overrides.
 */
export function toolCtx(opts: Record<string, unknown> = {}) {
  const roots = opts.workspaceRoots as string[] | string | undefined;
  const workspace = roots ? new Workspace(roots) : null;
  return new ToolContext({
    workspace,
    ...opts,
  });
}

/**
 * Set up the session log test directory and clean up any existing test file.
 */
export function setupSessionTestDir(sessionId: string): void {
  const { mkdirSync, rmSync } = fs;
  const { join } = path;
  const { homedir } = os;
  const dir = join(homedir(), ".cache", "hotdog", "sessions");
  mkdirSync(dir, { recursive: true });
  const testFile = join(dir, `${sessionId}.jsonl`);
  try { rmSync(testFile); } catch { /* doesn't exist yet */ }
}

/**
 * Clean up a session log test file.
 */
export function cleanupSessionTest(sessionId: string): void {
  const { rmSync } = fs;
  const { join } = path;
  const { homedir } = os;
  const testFile = join(homedir(), ".cache", "hotdog", "sessions", `${sessionId}.jsonl`);
  try { rmSync(testFile); } catch { /* ignore */ }
}
