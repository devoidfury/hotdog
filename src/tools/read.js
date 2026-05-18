// Read tool — read content from a file.

import fsSync from 'node:fs';
import path from 'node:path';
import { ToolContext, toolDef, param, toolResult, validateCwdBoundary } from './registry.js';
import { DEFAULT_READ_TOOL_LIMIT } from '../config.js';

export class ReadTool {
  static TOOL_NAME = 'read';

  static tryNewFromContext(ctx) {
    return new ReadTool();
  }

  toToolDef() {
    return toolDef(
      ReadTool.TOOL_NAME,
      "Read a file's contents with optional pagination. Supports line-based or byte-based extraction with offset/limit. Returns an error for directories with a depth-1 listing instead.",
      {
        schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          path: param('string', 'Path to the file to read (relative to workspace root)'),
          limit: param('integer', 'Maximum number of lines or bytes to return', { minimum: 1 }),
          offset: param('integer', 'Number of lines or bytes to skip', { minimum: 0 }),
          type: param('string', "Extraction type: 'lines' for line-based, 'bytes' for byte-based", { enum: ['lines', 'bytes'] }),
        },
        required: ['path'],
      }
    );
  }

  callDisplay(input) {
    const args = parseArgs(input);
    if (!args) {
      return typeof input === 'string' ? input : '(no path)';
    }
    const { path: filePath, limit, offset, type } = args;
    if (!filePath) {
      return '(no path)';
    }
    const typeStr = type || 'lines';
    const end = offset + limit;
    return `${filePath} (${typeStr} ${offset}-${end})`;
  }

  firstUseHelp() {
    return "Read a file's contents with optional pagination. Supports line-based or byte-based extraction with offset/limit. Returns an error for directories with a depth-1 listing instead.";
  }

  async execute(input, ctx) {
    const args = parseArgs(input);
    if (!args) {
      return toolResult('Error parsing arguments');
    }

    const { path: filePath, limit, offset, type } = args;
    const cwdBoundary = ctx?.cwdBoundary || null;
    const workspaceRoot = ctx?.workspaceRoot || null;

    // Resolve path: cwdBoundary takes precedence, falls back to workspaceRoot
    const resolvedPath = resolvePath(filePath, cwdBoundary, workspaceRoot);

    // Validate cwd boundary
    const boundaryError = validateCwdBoundary(resolvedPath, cwdBoundary);
    if (boundaryError) {
      return toolResult(boundaryError);
    }

    const resolved = resolvedPath;

    // Check if it's a directory
    try {
      const stat = fsSync.statSync(resolved);
      if (stat.isDirectory()) {
        const listing = listDirectoryDepth1(resolved);
        return toolResult(
          `'${filePath}' is a directory. Here's a depth-1 listing:\n${listing}`,
        );
      }
    } catch (e) {
      // stat failed — continue to file-not-found handling below
    }

    // Check if file exists
    if (!fsSync.existsSync(resolved)) {
      return toolResult(`File not found: ${filePath}`);
    }

    const mode = type || 'lines';
    if (mode === 'bytes') {
      return readBytes(resolved, offset, limit);
    }
    return readLines(resolved, offset, limit);
  }
}

/**
 * Resolve a file path against cwdBoundary or workspaceRoot.
 * cwdBoundary takes precedence if set; otherwise falls back to workspaceRoot.
 * Absolute paths are returned as-is.
 */
function resolvePath(filePath, cwdBoundary, workspaceRoot) {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  if (cwdBoundary) {
    return path.resolve(cwdBoundary, filePath);
  }
  if (workspaceRoot) {
    return path.resolve(workspaceRoot, filePath);
  }
  return path.resolve(filePath);
}

/**
 * Parse and validate read tool arguments.
 */
function parseArgs(input) {
  if (!input || (typeof input === 'string' && input.trim().length === 0)) {
    return { path: null, limit: DEFAULT_READ_TOOL_LIMIT, offset: 0, type: 'lines' };
  }

  let json;
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input);
    } catch {
      return null;
    }
  } else {
    json = input;
  }

  const filePath = json.path;
  if (!filePath || typeof filePath !== 'string') {
    return null;
  }

  const limit = typeof json.limit === 'number' && json.limit >= 1
    ? json.limit
    : DEFAULT_READ_TOOL_LIMIT;
  const offset = typeof json.offset === 'number' && json.offset >= 0
    ? json.offset
    : 0;
  const type = (json.type === 'bytes' || json.type === 'lines') ? json.type : 'lines';

  return { path: filePath, limit, offset, type };
}

/**
 * Read file by lines with offset/limit pagination.
 */
function readLines(filePath, offset, limit) {
  try {
    const content = fsSync.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const totalLines = lines.length;

    if (offset >= totalLines) {
      return toolResult(
        `File has ${totalLines} lines, offset ${offset} is beyond end.\n[empty]`,
      );
    }

    const end = Math.min(offset + limit, totalLines);
    const selected = lines.slice(offset, end);
    const result = selected.length === 0 ? '[empty]' : selected.join('\n');

    return toolResult(result);
  } catch (e) {
    return toolResult(`Failed to read file: ${e.message}`);
  }
}

/**
 * Read file by bytes with offset/limit pagination.
 */
function readBytes(filePath, offset, limit) {
  try {
    const bytes = fsSync.readFileSync(filePath);
    const totalBytes = bytes.length;

    if (offset >= totalBytes) {
      return toolResult(
        `File has ${totalBytes} bytes, offset ${offset} is beyond end.\n[empty]`,
      );
    }

    const end = Math.min(offset + limit, totalBytes);
    const selected = bytes.slice(offset, end);
    const content = selected.toString('utf-8');
    const result = content.length === 0 ? '[empty]' : content;

    return toolResult(result);
  } catch (e) {
    return toolResult(`Failed to read file: ${e.message}`);
  }
}

/**
 * List directory contents at depth 1, sorted.
 */
function listDirectoryDepth1(dirPath) {
  try {
    const entries = fsSync.readdirSync(dirPath, { withFileTypes: true });
    const sorted = entries
      .map((entry) => {
        const suffix = entry.isDirectory() ? '/' : '';
        return `  ${entry.name}${suffix}`;
      })
      .sort();
    return sorted.join('\n');
  } catch {
    return '  (unable to read directory)';
  }
}

