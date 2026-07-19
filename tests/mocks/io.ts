// I/O utilities for tests — temp dirs, session files, tool result helpers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolResult } from '../../src/core/extensions/tool-utils.ts';
import { ToolContext } from '../../src/core/extensions/tool-context.ts';

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
  return new ToolContext({
    cwdBoundary: opts.cwdBoundary ?? null,
    workspaceRoot: opts.workspaceRoot ?? null,
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
