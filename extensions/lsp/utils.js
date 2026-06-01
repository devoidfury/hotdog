// LSP utilities — URI conversion, language ID mapping, token estimation.

/**
 * Convert a file path to a file:// URI.
 * Handles both Unix and Windows paths.
 */
export function pathToUri(filePath) {
  // Encode the path but preserve forward slashes
  const encoded = encodeURIComponent(filePath).replace(/%2F/g, '/');
  // Windows paths need drive letter prefix
  if (filePath.length >= 2 && filePath[1] === ':') {
    return `file:///${encoded}`;
  }
  return `file://${encoded}`;
}

/**
 * Convert a file:// URI to a file path.
 */
export function uriToPath(uri) {
  if (!uri || !uri.startsWith('file://')) {
    return uri;
  }
  // Remove file:// prefix
  let path = uri.slice(7);
  // Decode percent-encoding
  try {
    path = decodeURIComponent(path);
  } catch {
    // If decoding fails, return as-is
  }
  // Windows paths: file:///C:/... → C:/...
  if (path.length >= 2 && path[1] === ':') {
    path = path.slice(1);
  }
  return path;
}

/**
 * Map a file extension to a language ID.
 */
export function getLanguageId(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const map = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    rb: 'ruby',
    php: 'php',
    c: 'c',
    cpp: 'cpp',
    cs: 'csharp',
    swift: 'swift',
    kt: 'kotlin',
    md: 'markdown',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sh: 'shellscript',
    bash: 'shellscript',
    toml: 'toml',
    xml: 'xml',
    sql: 'sql',
  };
  return map[ext] || 'plaintext';
}

/**
 * Estimate token count for LSP responses.
 * Rough approximation: ~4 chars per token for English text.
 */
export function estimateLspTokenCount(text) {
  if (!text) return 0;
  // LSP uses UTF-16, but tokenizers typically work on UTF-8
  const bytes = Buffer.byteLength(text, 'utf-8');
  return Math.ceil(bytes / 4);
}

/**
 * Convert UTF-16 offset to UTF-8 offset (and vice versa).
 * LSP uses UTF-16 code units for position encoding.
 */
export function utf16ToUtf8Offset(str, utf16Offset) {
  // Count bytes up to the utf16Offset-th UTF-16 code unit
  let utf8Offset = 0;
  let utf16Count = 0;
  for (let i = 0; i < str.length && utf16Count < utf16Offset; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      utf8Offset += 1;
    } else if (code < 0x800) {
      utf8Offset += 2;
    } else if (code < 0xd800 || code > 0xdfff) {
      utf8Offset += 3;
    } else {
      // Surrogate pair
      utf8Offset += 4;
      i++; // Skip next char
    }
    utf16Count++;
  }
  return utf8Offset;
}

/**
 * Convert UTF-8 offset to UTF-16 offset.
 */
export function utf8ToUtf16Offset(str, utf8Offset) {
  let currentUtf8 = 0;
  let utf16Count = 0;
  for (let i = 0; i < str.length && currentUtf8 < utf8Offset; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      currentUtf8 += 1;
    } else if (code < 0x800) {
      currentUtf8 += 2;
    } else if (code < 0xd800 || code > 0xdfff) {
      currentUtf8 += 3;
    } else {
      currentUtf8 += 4;
      i++; // Skip next char in surrogate pair
    }
    utf16Count++;
  }
  return utf16Count;
}

/**
 * Truncate text to a maximum number of lines.
 */
export function truncateLines(text, maxLines) {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  const truncated = lines.slice(0, maxLines).join('\n');
  return `${truncated}\n--- [truncated, ${lines.length - maxLines} more lines] ---`;
}

/**
 * Safely stringify an object for display, limiting depth and length.
 */
export function safeStringify(obj, maxDepth = 2) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      if (maxDepth !== undefined) {
        // Simple depth check — skip deep nesting
        const str = JSON.stringify(value);
        if (str.length > 500) return '[...]';
      }
      seen.add(value);
    }
    return value;
  }, 2);
}
