// Tool registry and common utilities.

const fs = require('node:fs');
const path = require('node:path');

/**
 * Metadata keys rendered as XML attributes on the root <tool> tag.
 * Everything else becomes a child node.
 */
const SHORT_META_KEYS = new Set([
  'truncated', 'page', 'total_pages', 'total_lines', 'showing',
  'duration_ms', 'timeout', 'exit_code', 'path', 'pattern',
]);

/**
 * Minimal XML escaping for attribute/text content.
 */
function xmlEscape(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Tool result — structured result for tool execution.
 * Supports success/failure status, metadata, and XML serialization for API output.
 */
export class ToolResult {
  constructor({ output = '', error = null, metadata = null, success = true, outputTag = null } = {}) {
    this.output = output;
    this.error = error;
    this.metadata = metadata;
    this.success = success;
    this.outputTag = outputTag;
  }

  /**
   * Create a successful result with the given output.
   */
  static ok(output) {
    return new ToolResult({ output, success: true });
  }

  /**
   * Create an error result with the given message.
   */
  static err(message) {
    return new ToolResult({ output: '', error: String(message), success: false });
  }

  /**
   * Add a single metadata entry.
   */
  withEntry(key, value) {
    this.metadata = this.metadata || new Map();
    this.metadata.set(key, String(value));
    return this;
  }

  /**
   * Add multiple metadata entries at once.
   */
  withEntries(entries) {
    this.metadata = this.metadata || new Map();
    for (const [key, value] of Object.entries(entries)) {
      this.metadata.set(key, String(value));
    }
    return this;
  }

  /**
   * Set a custom XML tag name for the output.
   */
  withOutputTag(tag) {
    this.outputTag = tag;
    return this;
  }

  /**
   * Check if result is successful.
   */
  isOk() {
    return this.success;
  }

  /**
   * Check if result is an error.
   */
  isErr() {
    return !this.success;
  }

  /**
   * Format result for display (plain text).
   */
  toDisplay() {
    const parts = this.output ? [this.output] : [];
    if (this.error) {
      parts.push(`Error: ${this.error}`);
    }
    return parts.join('\n');
  }

  /**
   * Format result as XML for API content.
   */
  toApiContent(toolName) {
    const status = this.success ? 'success' : 'failure';
    const tag = this.outputTag || 'output';

    const attrs = [
      `name="${xmlEscape(toolName)}"`,
      `status="${status}"`,
    ];
    const longMeta = [];

    if (this.metadata) {
      for (const [key, value] of this.metadata) {
        if (SHORT_META_KEYS.has(key)) {
          attrs.push(`${xmlEscape(key)}="${xmlEscape(value)}"`);
        } else {
          longMeta.push(`  <${xmlEscape(key)}>${xmlEscape(value)}</${xmlEscape(key)}>`);
        }
      }
    }

    if (!this.success && this.error) {
      longMeta.unshift(`  <error>${xmlEscape(this.error)}</error>`);
    }

    const outputNode = `  <${tag}>${xmlEscape(this.output)}</${tag}>`;

    const parts = [`<tool ${attrs.join(' ')}>`];
    parts.push(...longMeta);
    parts.push(outputNode);
    parts.push('</tool>');

    return parts.join('\n');
  }
}

/**
 * Tool definition (OpenAI function-calling schema).
 * Supports JSON Schema draft/2020-12 format with additional fields like enum, min/max, etc.
 */
export function toolDef(name, description, parameters) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        ...(parameters?.schema ? { schema: parameters.schema } : {}),
        type: 'object',
        properties: parameters?.properties || {},
        required: parameters?.required || [],
      },
    },
  };
}

/**
 * Create a parameter definition.
 * Supports additional JSON Schema fields: enum, minimum, maximum, etc.
 */
export function param(typeName, description, extra = {}) {
  return { type: typeName, description: description || '', ...extra };
}

/**
 * Parse tool arguments from JSON input string.
 */
export function parseToolArgs(input) {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      return { input };
    }
  }
  return input;
}

/**
 * Resolve a tool result string.
 * Handles plain strings, objects, and ToolResult instances.
 */
export function toolResult(result) {
  if (result instanceof ToolResult) {
    return result.toDisplay();
  }
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && result !== null) {
    return JSON.stringify(result);
  }
  return String(result);
}

/**
 * Truncate output to max lines.
 */
export function truncateOutput(text, maxLines) {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  const truncated = lines.slice(0, maxLines).join('\n');
  return `${truncated}\n--- [truncated, ${lines.length - maxLines} more lines] ---`;
}

/**
 * Generate a simple unified diff between old and new text.
 */
export function generateDiff(oldText, newText, maxLines = 80) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const diff = [];

  let oldIdx = 0, newIdx = 0;
  while (oldIdx < oldLines.length && newIdx < newLines.length) {
    if (oldLines[oldIdx] === newLines[newIdx]) {
      oldIdx++;
      newIdx++;
    } else {
      // Simple diff: just show the changed lines
      diff.push(`- ${oldLines[oldIdx]}`);
      diff.push(`+ ${newLines[newIdx]}`);
      oldIdx++;
      newIdx++;
      if (diff.length > maxLines * 2) break;
    }
  }

  while (oldIdx < oldLines.length) {
    diff.push(`- ${oldLines[oldIdx]}`);
    oldIdx++;
  }
  while (newIdx < newLines.length) {
    diff.push(`+ ${newLines[newIdx]}`);
    newIdx++;
  }

  return diff.join('\n');
}

/**
 * Write a file, creating parent directories as needed.
 */
export function writeFileWithParents(filePath, content) {
  const parentDir = path.dirname(filePath);
  if (parentDir && parentDir !== '.') {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  fs.writeFileSync(filePath, content);
}

/**
 * Validate that a path is within the cwd boundary.
 * Returns an error string if outside the boundary, or null if valid.
 */
export function validateCwdBoundary(filePath, cwdBoundary) {
  if (!cwdBoundary) return null;
  const boundaryResolved = path.resolve(cwdBoundary);
  const fileResolved = path.resolve(filePath);
  if (!fileResolved.startsWith(boundaryResolved + path.sep) && fileResolved !== boundaryResolved) {
    return `Error: path ${filePath} is outside cwd boundary ${cwdBoundary}`;
  }
  return null;
}

/**
 * Resolve a path and verify it stays within the cwd boundary (if set).
 * Returns the resolved path string.
 * Throws if the path doesn't exist or escapes the boundary.
 */
export function resolvePath(requested, cwdBoundary = null) {
  const resolved = path.resolve(requested);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Path not found: ${requested}`);
  }

  if (cwdBoundary) {
    const boundaryResolved = path.resolve(cwdBoundary);
    if (!resolved.startsWith(boundaryResolved + path.sep) && resolved !== boundaryResolved) {
      throw new Error(
        `Path '${requested}' is outside the allowed directory '${cwdBoundary}'. ` +
        'File operations are restricted to the boundary directory.',
      );
    }
  }

  return resolved;
}

/**
 * Get file size in bytes.
 * Returns the file size as a number.
 */
export function fileSize(filePath) {
  const stats = fs.statSync(filePath);
  return stats.size;
}

/**
 * Check if a path is writable.
 * Tests by creating a temp file in the parent dir (if new) or opening for write (if existing).
 * Returns true if writable, throws if not.
 */
export function checkWritable(filePath) {
  const parentDir = path.dirname(filePath);

  // Test parent directory writability by creating a temp file
  if (parentDir && parentDir !== '.') {
    const tempPath = path.join(parentDir, '.oa-agent-permission-test');
    try {
      fs.writeFileSync(tempPath, '');
      fs.unlinkSync(tempPath);
    } catch (e) {
      throw new Error(`Directory '${parentDir}' is not writable: ${e.message}`);
    }
  }

  // If file exists, check if it can be opened for writing
  if (fs.existsSync(filePath)) {
    try {
      fs.openSync(filePath, 'w');
    } catch (e) {
      throw new Error(`File '${filePath}' is not writable: ${e.message}`);
    }
  }

  return true;
}

/**
 * Check if a path is readable.
 * Returns true if readable, throws if not.
 */
export function checkReadable(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Path '${filePath}' does not exist`);
  }
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch (e) {
    throw new Error(`File '${filePath}' is not readable: ${e.message}`);
  }
  return true;
}

/**
 * Extract a required string from a JSON value.
 * Returns the string value, or throws if missing/not a string.
 */
export function getRequiredStr(value, key) {
  const v = value?.[key];
  if (typeof v !== 'string') {
    throw new Error(`Missing required argument: ${key}`);
  }
  return v;
}

/**
 * Run a shell command and capture stdout.
 * Throws on non-zero exit or spawn failure.
 */
export function runCommand(cmd, args = [], cwd = null) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024, // 10MB
  });

  if (result.error) {
    throw new Error(`Failed to execute '${cmd}': ${result.error.message}`);
  }

  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';

  if (result.status !== 0) {
    throw new Error(
      `Command '${cmd}' failed with exit code ${result.status}: ${stdout}\n${stderr}`,
    );
  }

  return stdout;
}

/**
 * Tool registry — holds all available tools.
 */
export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(name, tool) {
    this.tools.set(name, tool);
  }

  get(name) {
    return this.tools.get(name);
  }

  has(name) {
    return this.tools.has(name);
  }

  getAll() {
    return Array.from(this.tools.entries());
  }

  getToolDefs() {
    return Array.from(this.tools.values())
      .filter(t => t.toToolDef)
      .map(t => t.toToolDef());
  }

  /**
   * Filter tools by whitelist/blacklist.
   */
  filter(whitelist, blacklist, managerToolsEnabled = false) {
    const result = new ToolRegistry();
    for (const [name, tool] of this.tools) {
      // Check blacklist
      if (blacklist && blacklist.includes(name)) continue;
      // Check whitelist
      if (whitelist && !whitelist.includes(name)) continue;
      result.register(name, tool);
    }
    return result;
  }
}

/**
 * Tool context — shared state available to tools.
 */
export class ToolContext {
  constructor(options = {}) {
    this.skills = options.skills || [];
    this.allSkills = options.allSkills || [];
    this.skillDirectories = options.skillDirectories || [];
    this.modelRegistry = options.modelRegistry || {};
    this.cwdBoundary = options.cwdBoundary || null;
    this.workspaceRoot = options.workspaceRoot || null;
    this.currentFile = options.currentFile || null;
    this.modelNames = options.modelNames || [];
    this.activeProvider = options.activeProvider || null;
    this.onActivateSkill = options.onActivateSkill || null;
    this.onSwitchModel = options.onSwitchModel || null;
    this.onClearContext = options.onClearContext || null;
    this.onCacheToolOutput = options.onCacheToolOutput || null;
    this.onGetCachedToolOutput = options.onGetCachedToolOutput || null;
    this.isCancelled = options.isCancelled || (() => false);
  }
}
