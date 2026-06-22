// Shared test helpers for extension tests.
// Extracted to reduce duplication across test files.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ToolResult } from '../src/core/extensions/tool-utils.js';
import { ToolContext } from '../src/core/extensions/tool-context.js';

/**
 * Extract string output from a tool result (handles ToolResult or plain string).
 * For error results, includes the error message.
 */
export function resultStr(result) {
  if (result instanceof ToolResult) {
    if (result.error) {
      return result.error;
    }
    return result.output;
  }
  return result;
}

/**
 * Get display string from a tool result (calls toDisplay()).
 */
export function getDisplay(result) {
  if (result?.toDisplay) {
    return result.toDisplay();
  }
  return String(result);
}

/**
 * Create a temporary directory for file-based tests.
 */
export function tmpDir(prefix = 'oa-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Create a ToolContext with optional overrides.
 */
export function toolCtx(opts = {}) {
  return new ToolContext({
    cwdBoundary: opts.cwdBoundary || null,
    workspaceRoot: opts.workspaceRoot || null,
    ...opts,
  });
}

/**
 * Clean up a temporary directory recursively.
 */
export function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
