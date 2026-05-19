# LSAP Implementation Plan for oa-js

> **Status**: Draft — for planning and discussion
> **Source**: [LSAP Repository](https://github.com/lsp-client/LSAP)
> **Target**: `ext/lsap/` in oa-js (JavaScript)

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Directory Structure](#directory-structure)
4. [Component Design](#component-design)
5. [Template System](#template-system)
6. [Integration with Tool Registry](#integration-with-tool-registry)
7. [Phase-by-Phase Implementation Plan](#phase-by-phase-implementation-plan)
8. [Gap Analysis](#gap-analysis)

---

## Overview

### What is LSAP?

**LSAP (Language Server Agent Protocol)** is an open protocol that transforms low-level LSP capabilities into high-level, **agent-native cognitive tools**. It acts as an **orchestration layer** over LSP, composing atomic LSP operations into semantic interfaces designed for AI coding agents.

### Core Philosophy

| Aspect | LSP (Editor Perspective) | LSAP (Agent Perspective) |
|--------|--------------------------|--------------------------|
| **Operations** | Atomic (e.g., `textDocument/definition`) | Cognitive (e.g., "Find all references with context") |
| **Output** | Raw LSP types (Location, Symbol) | Structured Markdown reports |
| **Intent** | "Jump to definition" | "Understand this symbol and its usages" |
| **Complexity** | Agent must orchestrate multiple calls | Single request handles orchestration |

### Example: References

**LSP approach** (what oa-js does today):
```
Agent → lsp-references { file, line, character } → [Location[]]
Agent must manually: read files, extract context, format output
```

**LSAP approach**:
```
Agent → lsap-references { locate, mode, max_items }
  → LSAP internally:
    1. Locate the symbol (hover + symbol resolution)
    2. Fetch references
    3. For each reference, read surrounding code context
    4. Fetch symbol info and hover docs
    5. Return structured Markdown report
Agent ← lsap-references { items, total, pagination, markdown }
```

### Key Design Decisions for oa-js

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Directory** | `ext/lsap/` (new) | Distinct from `ext/lsp/` (raw LSP tools) |
| **Transport** | `ext/lsp/LspClient` | Reuse existing JSON-RPC client |
| **Templates** | String templates (no libraries) | Zero external dependencies |
| **Models** | JSDoc + factory functions | No Pydantic — trust LSP server responses |
| **Concurrency** | `Promise.allSettled()` | Already used in oa-js |
| **Output** | `ToolResult` with XML/markdown | Matches existing tool patterns |

### Dependencies

- **Zero new npm packages** — only Node.js built-ins (`fs`, `path`, `util`, `crypto`)
- **`ext/lsp/`** — LspClient, DocumentStore, utilities (existing)
- **`src/tools/registry.js`** — ToolResult, ToolRegistry, ToolContext (existing)

---

## Architecture

### High-Level Component Diagram

```
┌─────────────────────────────────────────────────┐
│                    Agent                         │
│  (calls tools via tool registry)                │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│              ext/lsap/ (LSAP Layer)              │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │         Cognitive Capabilities           │   │
│  │                                          │   │
│  │  LocateCapability    ──►  InspectCapability│  │
│  │  DefinitionCapability ──► ReferenceCapability│ │
│  │  OutlineCapability   ──►  SearchCapability │  │
│  │  RenamePreview       ──►  RenameExecute    │  │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │         Utilities & Models               │   │
│  │                                          │   │
│  │  models.js       symbol.js               │   │
│  │  locate.js       markdown.js             │   │
│  │  cache.js        pagination.js           │   │
│  │  id.js           capability.js           │   │
│  └──────────────────────────────────────────┘   │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│              ext/lsp/ (Transport Layer)          │
│                                                  │
│  LspClient — JSON-RPC over stdio                │
│  DocumentStore — in-memory document state       │
│  Utilities — path/uri conversion                │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │         Raw LSP Tools (12 tools)         │   │
│  │                                          │   │
│  │  lsp-hover, lsp-definition, lsp-references│  │
│  │  lsp-document-symbol, lsp-rename, etc.   │   │
│  └──────────────────────────────────────────┘   │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│         Language Server Process (stdio)          │
└─────────────────────────────────────────────────┘
```

### Layer Separation

| Layer | Directory | Responsibility |
|-------|-----------|----------------|
| **Transport** | `ext/lsp/` | JSON-RPC communication, process management, raw LSP tools |
| **LSAP** | `ext/lsap/` | Cognitive capabilities, orchestration, output formatting |
| **Registry** | `src/tools/` | Tool registration, context management |

### Key Principle: `ext/lsap/` Uses `ext/lsp/` Directly

LSAP capabilities do NOT implement their own LSP transport. They use:
- `LspClient` from `ext/lsp/client.js` for JSON-RPC calls
- `DocumentStore` from `ext/lsp/document-store.js` for document state
- Utilities from `ext/lsp/utils.js` for path/uri conversion
- `LspBaseTool` helpers from `ext/lsp/tools/base.js` for formatting

This avoids duplication and keeps the transport layer in a single place.

---

## Directory Structure

```
ext/
├── lsp/              ← Existing: raw LSP tools (12 tools, LspClient, etc.)
│   ├── client.js         — LspClient: JSON-RPC over stdio
│   ├── client-cache.js   — lspClientCache: languageId → LspClient
│   ├── config.js         — getServerForFile(), getServerByLanguageId()
│   ├── document-store.js — DocumentStore: URI → {content, languageId, version}
│   ├── utils.js          — pathToUri(), uriToPath(), getLanguageId()
│   └── tools/
│       ├── base.js       — LspBaseTool: shared helpers, formatting
│       ├── index.js      — Tool exports
│       ├── lsp-hover.js
│       ├── lsp-definition.js
│       ├── lsp-completion.js
│       ├── lsp-signature.js
│       ├── lsp-document-symbol.js
│       ├── lsp-references.js
│       ├── lsp-code-action.js
│       ├── lsp-formatting.js
│       ├── lsp-rename.js
│       ├── lsp-diagnostics.js
│       ├── lsp-workspace-symbol.js
│       └── lsp-apply-edit.js
│
└── lsap/             ← New: high-level cognitive capabilities
    ├── index.js          — Extension entry point: exports, registerLsapTools()
    ├── models.js         — Position, Range, Location, SymbolKind, SymbolInfo, CallHierarchy
    ├── symbol.js         — iterSymbols(), symbolAt(), contains(), isNarrower()
    ├── locate.js         — LocateCapability, parseLocateString(), detectMarker()
    ├── document-reader.js — DocumentReader (wraps ext/lsp/document-store)
    ├── capability.js     — Capability base class, ensureCapability()
    ├── inspect.js        — InspectCapability (locate + symbol + hover + callHierarchy)
    ├── definition.js     — DefinitionCapability (locate + definition + inspect)
    ├── reference.js      — ReferenceCapability (references + context + hover + pagination)
    ├── outline.js        — OutlineCapability (file mode + directory mode)
    ├── search.js         — SearchCapability (workspaceSymbol + pagination)
    ├── rename.js         — RenamePreview + RenameExecute (two-step workflow)
    ├── cache.js          — LRUCache, PaginationCache
    ├── pagination.js     — paginate() utility
    ├── markdown.js       — cleanHoverContent(), simple template render
    └── id.js             — generateShortId()
```

### File Responsibilities

| File | Purpose | Key Exports |
|------|---------|-------------|
| `index.js` | Entry point, registration hook | `registerLsapTools()`, exports all capabilities |
| `models.js` | Type definitions (JSDoc) | `createPosition()`, `createRange()`, `createLocation()`, SymbolKind enum |
| `symbol.js` | Symbol tree utilities | `iterSymbols()`, `symbolAt()`, `contains()`, `isNarrower()` |
| `locate.js` | Symbol resolution from strings | `LocateCapability`, `parseLocateString()`, `detectMarker()` |
| `document-reader.js` | Efficient file content access | `DocumentReader` class |
| `capability.js` | Capability base class | `Capability` abstract class, `ensureCapability()` |
| `inspect.js` | Symbol inspection | `InspectCapability` |
| `definition.js` | Definition resolution | `DefinitionCapability` |
| `reference.js` | Reference search | `ReferenceCapability` |
| `outline.js` | Symbol outline | `OutlineCapability` |
| `search.js` | Workspace search | `SearchCapability` |
| `rename.js` | Rename operations | `RenamePreviewCapability`, `RenameExecuteCapability` |
| `cache.js` | Result caching | `LRUCache`, `PaginationCache` |
| `pagination.js` | Pagination utility | `paginate()` |
| `markdown.js` | Output formatting | `cleanHoverContent()`, `renderTemplate()` |
| `id.js` | Short ID generation | `generateShortId()` |

---

## Component Design

### Models (No Pydantic — Plain JavaScript)

Instead of Python Pydantic models, use plain JavaScript objects with factory functions and JSDoc type documentation:

```javascript
// ext/lsap/models.js

/**
 * LSP Position (0-indexed line, 0-indexed character).
 * @typedef {object} Position
 * @property {number} line - 0-indexed line number
 * @property {number} character - 0-indexed character offset (UTF-16)
 */

/**
 * Create a Position object.
 * @param {object} options
 * @param {number} options.line - 0-indexed line number
 * @param {number} options.character - 0-indexed character offset
 * @returns {Position}
 */
export function createPosition({ line, character }) {
  return { line, character };
}

/**
 * LSP Range.
 * @typedef {object} Range
 * @property {Position} start - Start position
 * @property {Position} end - End position
 */

/**
 * Create a Range object.
 * @param {object} options
 * @param {Position} options.start
 * @param {Position} options.end
 * @returns {Range}
 */
export function createRange({ start, end }) {
  return { start, end };
}

/**
 * LSP Location.
 * @typedef {object} Location
 * @property {string} uri - File URI
 * @property {Range} range - Location range
 */

/**
 * Create a Location object.
 * @param {object} options
 * @param {string} options.uri - File URI
 * @param {Range} options.range - Location range
 * @returns {Location}
 */
export function createLocation({ uri, range }) {
  return { uri, range };
}

/**
 * Symbol kind values (matching LSP spec numeric codes).
 * @enum {string}
 */
export const SymbolKind = {
  File: 'File', Module: 'Module', Namespace: 'Namespace', Package: 'Package',
  Class: 'Class', Method: 'Method', Property: 'Property', Field: 'Field',
  Constructor: 'Constructor', Enum: 'Enum', Interface: 'Interface',
  Function: 'Function', Variable: 'Variable', Constant: 'Constant',
  String: 'String', Number: 'Number', Boolean: 'Boolean', Array: 'Array',
  Object: 'Object', Key: 'Key', Null: 'Null', EnumMember: 'EnumMember',
  Struct: 'Struct', Event: 'Event', Operator: 'Operator', TypeParameter: 'TypeParameter',
};

/**
 * Symbol kind numeric code → string mapping.
 * @type {Map<number, string>}
 */
export const SymbolKindCode = new Map([
  [1, 'File'], [2, 'Module'], [3, 'Namespace'], [4, 'Package'],
  [5, 'Class'], [6, 'Method'], [7, 'Property'], [8, 'Field'],
  [9, 'Constructor'], [10, 'Enum'], [11, 'Interface'], [12, 'Function'],
  [13, 'Variable'], [14, 'Constant'], [15, 'String'], [16, 'Number'],
  [17, 'Boolean'], [18, 'Array'], [19, 'Object'], [20, 'Key'],
  [21, 'Null'], [22, 'EnumMember'], [23, 'Struct'], [24, 'Event'],
  [25, 'Operator'], [26, 'TypeParameter'],
]);
```

### Capability Base Class

```javascript
// ext/lsap/capability.js

/**
 * Abstract base class for LSAP capabilities.
 * Capabilities orchestrate multiple LSP calls into a single cognitive operation.
 */
export class Capability {
  /**
   * @param {object} options
   * @param {import('../lsp/client.js').LspClient} options.client - LSP client instance
   */
  constructor({ client }) {
    this.client = client;
  }

  /**
   * Execute the capability. Override in subclasses.
   * @param {object} input - Capability-specific input
   * @returns {Promise<import('../../src/tools/registry.js').ToolResult>}
   */
  async execute(input) {
    throw new Error('Not implemented');
  }
}

/**
 * Check if an LSP client supports a specific capability.
 * @param {import('../lsp/client.js').LspClient} client
 * @param {string} capability - Capability name (e.g., 'hoverProvider')
 * @returns {boolean}
 */
export function ensureCapability(client, capability) {
  const caps = client.getCapabilities();
  if (!caps) return false;
  // Handle both direct properties and nested provider objects
  const value = caps[capability];
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object') return 'provideProvider' in value || true;
  return false;
}

/**
 * Get the LSP client, or null if not available.
 * @param {import('../lsp/client.js').LspClient} client
 * @returns {import('../lsp/client.js').LspClient | null}
 */
export function getClient(client) {
  if (!client || !client.isReady()) return null;
  return client;
}
```

### Symbol Utilities

```javascript
// ext/lsap/symbol.js

/**
 * Iterate through a symbol tree in DFS order.
 * @param {object[]} symbols - Array of DocumentSymbol objects
 * @yields {object} Each symbol in DFS order
 */
export function* iterSymbols(symbols) {
  if (!Array.isArray(symbols)) return;
  for (const symbol of symbols) {
    yield symbol;
    if (symbol.children && symbol.children.length > 0) {
      yield* iterSymbols(symbol.children);
    }
  }
}

/**
 * Find the most specific symbol containing a given position.
 * @param {object[]} symbols - Array of DocumentSymbol objects
 * @param {Position} position - Position to search for
 * @returns {object | null} The most specific symbol, or null
 */
export function symbolAt(symbols, position) {
  if (!Array.isArray(symbols)) return null;
  let best = null;
  for (const symbol of iterSymbols(symbols)) {
    if (contains(symbol.range, position)) {
      best = symbol;
    }
  }
  return best;
}

/**
 * Check if a position is within a range.
 * @param {Range} range
 * @param {Position} position
 * @returns {boolean}
 */
export function contains(range, position) {
  if (!range || !position) return false;
  const { start, end } = range;
  if (position.line < start.line || position.line > end.line) return false;
  if (position.line === start.line && position.character < start.character) return false;
  if (position.line === end.line && position.character > end.character) return false;
  return true;
}

/**
 * Check if inner range is strictly inside outer range.
 * @param {Range} inner
 * @param {Range} outer
 * @returns {boolean}
 */
export function isNarrower(inner, outer) {
  if (!inner || !outer) return false;
  return (
    (inner.start.line > outer.start.line ||
      (inner.start.line === outer.start.line && inner.start.character >= outer.start.character)) &&
    (inner.end.line < outer.end.line ||
      (inner.end.line === outer.end.line && inner.end.character <= outer.end.character))
  );
}
```

### Locate Capability

```javascript
// ext/lsap/locate.js

import { iterSymbols } from './symbol.js';

/**
 * Locate a symbol or position within a file.
 * Supports multiple locate modes:
 * - Symbol path: "MyClass.myMethod"
 * - Line number: "42"
 * - Line range: "10,20"
 * - Pattern with marker: "@pattern<|>"
 */
export class LocateCapability extends Capability {
  /**
   * @param {object} options
   * @param {import('../lsp/client.js').LspClient} options.client
   */
  constructor({ client }) {
    super({ client });
  }

  /**
   * Locate a symbol by path within a file.
   * @param {object} params
   * @param {string} params.filePath - Absolute file path
   * @param {string} [params.symbolPath] - Dot-separated symbol path (e.g., "MyClass.myMethod")
   * @param {number} [params.line] - Line number (1-indexed)
   * @param {string} [params.find] - Pattern to find with optional marker
   * @returns {Promise<{uri: string, position: Position, symbol?: object} | null>}
   */
  async locate({ filePath, symbolPath, line, find }) {
    const client = getClient(this.client);
    if (!client) return null;

    const uri = this._pathToUri(filePath);
    const languageId = this._getLanguageId(filePath);
    await this._ensureDocumentOpen(client, filePath, languageId);

    // Get document symbols for this file
    const symbols = await client.request('textDocument/documentSymbol', {
      textDocument: { uri },
    }).catch(() => null);

    if (symbolPath) {
      // Navigate via symbol path
      return this._locateBySymbolPath(symbols, symbolPath);
    }

    if (line) {
      // Locate at line
      const lspLine = line - 1; // Convert 1-indexed to 0-indexed
      return { uri, position: { line: lspLine, character: 0 } };
    }

    if (find) {
      // Find pattern with optional marker
      return this._locateByPattern(symbols, uri, filePath, find);
    }

    return null;
  }

  /**
   * Parse a locate string: "file.py:scope@find".
   * @param {string} str - Locate string
   * @returns {{filePath: string, scope?: string, find?: string}}
   */
  static parseLocateString(str) {
    // Handle "file.py:scope@find" format
    const atIdx = str.lastIndexOf('@');
    const colonIdx = str.lastIndexOf(':');

    let filePath, scope, find;

    if (atIdx > colonIdx) {
      // Has @find part
      filePath = str.slice(0, atIdx);
      const rest = str.slice(atIdx + 1);
      const marker = detectMarker(rest);
      find = marker ? rest.slice(0, -marker.length) : rest;
      scope = null;
    } else if (colonIdx > 0) {
      // Has :scope part
      filePath = str.slice(0, colonIdx);
      scope = str.slice(colonIdx + 1);
    } else {
      filePath = str;
    }

    return { filePath, scope, find };
  }

  /**
   * Detect nested bracket markers like <|>, <<|>>, etc.
   * @param {string} text
   * @returns {string} The marker string or empty string
   */
  static detectMarker(text) {
    const depth = (text.match(/<\|>/g) || []).length;
    if (depth === 0) return '';
    const maxDepth = Math.max(depth, 1);
    // Use the deepest marker that exists
    for (let d = maxDepth; d >= 1; d--) {
      const open = '<'.repeat(d) + '|>';
      const close = '<' + '|>'.repeat(d);
      if (text.includes(open) && text.includes(close)) {
        return open + close;
      }
    }
    return '<|>><|>';
  }

  // ── Internal Helpers (reuse ext/lsp utilities) ──

  _pathToUri(filePath) {
    const { pathToUri } = require('../lsp/utils.js');
    return pathToUri(filePath);
  }

  _getLanguageId(filePath) {
    const { getLanguageId } = require('../lsp/utils.js');
    return getLanguageId(filePath);
  }

  async _ensureDocumentOpen(client, filePath, languageId) {
    const uri = this._pathToUri(filePath);
    const doc = client.documentStore.get(uri);
    if (!doc || doc.content === undefined) {
      const fs = await import('node:fs');
      const content = fs.readFileSync(filePath, 'utf-8');
      await client.didOpen(uri, content, languageId);
    }
    return uri;
  }

  _locateBySymbolPath(symbols, symbolPath) {
    if (!symbols) return null;
    const parts = symbolPath.split('.');
    let current = symbols;

    for (const part of parts) {
      let found = null;
      for (const sym of current) {
        if (sym.name === part) {
          found = sym;
          break;
        }
      }
      if (!found) return null;
      current = found.children || [];
    }

    return found ? {
      uri: null, // Will be resolved by caller
      position: found.range.start,
      symbol: found,
    } : null;
  }

  _locateByPattern(symbols, uri, filePath, find) {
    // For now, return a placeholder — full pattern matching
    // requires reading file content and regex search
    return { uri, position: { line: 0, character: 0 } };
  }
}
```

---

## Template System

### Design: Simple String Templates (No External Libraries)

Instead of Python's `python-liquid` library, use simple JavaScript string template functions. Templates are stored as `.js` files exporting template strings, or inline in the capability files.

```javascript
// ext/lsap/markdown.js

/**
 * Simple template renderer using ${placeholder} syntax.
 * Replaces ${key} with context[key], or leaves placeholder if missing.
 * @param {string} template - Template string with ${key} placeholders
 * @param {object} context - Key-value pairs for substitution
 * @returns {string}
 */
export function renderTemplate(template, context) {
  return template.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const value = context[key.trim()];
    return value !== undefined ? String(value) : `${${key}}`;
  });
}

/**
 * Clean hover content for display.
 * Removes excessive whitespace, normalizes markdown.
 * @param {string} content - Raw hover content
 * @returns {string}
 */
export function cleanHoverContent(content) {
  if (!content) return '';
  return content
    .replace(/\r\n/g, '\n')           // Normalize line endings
    .replace(/[ \t]+$/gm, '')         // Trim trailing whitespace
    .replace(/^\n{3,}/g, '\n\n')      // Collapse excessive newlines
    .trim();
}

/**
 * Format a code snippet with line numbers.
 * @param {string} code - Code content
 * @param {number} startLine - Starting line number (1-indexed)
 * @param {number} [maxLines] - Maximum lines to display
 * @returns {string}
 */
export function formatCodeSnippet(code, startLine, maxLines) {
  if (!code) return '';
  const lines = code.split('\n');
  const display = maxLines ? lines.slice(0, maxLines) : lines;
  const numbered = display.map((line, i) => {
    const lineNum = startLine + i;
    return `${String(lineNum).padStart(4)} | ${line}`;
  }).join('\n');
  return numbered;
}
```

### Template Examples

Templates are stored as plain strings in `.js` files:

```javascript
// ext/lsap/templates/reference.js

/**
 * Template for reference results.
 * Uses ${placeholder} syntax for substitution.
 */
export const referenceTemplate = `
# References Found

Total: ${total} | Showing: ${showing}

${items}

${pagination}
`;

/**
 * Template for a single reference item.
 */
export const referenceItemTemplate = `
### ${file}:${line}

${context}
`;
```

Usage in capabilities:

```javascript
// In reference.js
class ReferenceCapability extends Capability {
  async execute(input) {
    // ... orchestrate LSP calls ...
    const markdown = renderTemplate(referenceTemplate, {
      total: results.length,
      showing: page.length,
      items: page.map(item => renderTemplate(referenceItemTemplate, item)).join('\n'),
      pagination: this._renderPagination(input, results.length),
    });
    return ToolResult.ok(markdown);
  }
}
```

### Why Not Liquid?

| Aspect | Liquid (python-liquid) | JS String Templates |
|--------|------------------------|---------------------|
| **Dependencies** | Requires `liquidjs` npm package | Zero — built into JS |
| **Syntax** | `{% for %}`, `{{ }}` | `${var}` |
| **Complexity** | Full templating language | Simple substitution |
| **Maintenance** | External library updates | No external deps |
| **oa-js fit** | Adds dependency | Follows existing patterns |

The oa-js codebase already uses string templates extensively (see `ext/lsp/tools/base.js` formatting methods). This approach is consistent with the existing codebase.

---

## Integration with Tool Registry

### Registration Pattern

LSAP tools integrate with the existing tool registry through a registration function exported from `ext/lsap/index.js`:

```javascript
// ext/lsap/index.js

import { LspClient } from '../lsp/client.js';
import { getCachedClient } from '../lsp/client-cache.js';
import { getLanguageId, pathToUri } from '../lsp/utils.js';
import { isLspEnabled } from '../lsp/config.js';
import { ToolResult } from '../../src/tools/registry.js';

// Capability classes
export { Capability } from './capability.js';
export { LocateCapability } from './locate.js';
export { InspectCapability } from './inspect.js';
export { DefinitionCapability } from './definition.js';
export { ReferenceCapability } from './reference.js';
export { OutlineCapability } from './outline.js';
export { SearchCapability } from './search.js';
export { RenamePreviewCapability, RenameExecuteCapability } from './rename.js';

// Models
export { createPosition, createRange, createLocation, SymbolKind } from './models.js';
export { iterSymbols, symbolAt, contains, isNarrower } from './symbol.js';

// Utilities
export { LRUCache, PaginationCache } from './cache.js';
export { paginate } from './pagination.js';
export { renderTemplate, cleanHoverContent } from './markdown.js';
export { generateShortId } from './id.js';

/**
 * LSAP tool class map — maps tool names to constructor functions.
 * Each constructor takes { client, ctx } options.
 */
const LSAP_TOOL_MAP = {
  'lsap-inspect': InspectTool,
  'lsap-definition': DefinitionTool,
  'lsap-references': ReferenceTool,
  'lsap-outline': OutlineTool,
  'lsap-search': SearchTool,
  'lsap-rename-preview': RenamePreviewTool,
  'lsap-rename-execute': RenameExecuteTool,
  'lsap-locate': LocateTool,
};

/**
 * Get the list of LSAP tool names.
 */
export const LSAP_TOOL_NAMES = Object.keys(LSAP_TOOL_MAP);

/**
 * Register all LSAP tools with a registry when LSP is enabled.
 * Factory method that creates and registers LSAP tools.
 * Returns the number of tools registered (0 if LSP is disabled).
 *
 * @param {import('../../src/tools/registry.js').ToolRegistry} registry
 * @param {import('../../src/tools/registry.js').ToolContext} ctx
 * @returns {Promise<number>} Number of tools registered
 */
export async function registerLsapTools(registry, ctx) {
  const lspConfig = ctx?.lspConfig || null;
  if (!isLspEnabled(lspConfig)) {
    return 0;
  }

  const languageId = ctx?.currentFile ? getLanguageId(ctx.currentFile) : null;
  let registered = 0;

  for (const toolName of LSAP_TOOL_NAMES) {
    const tool = createLsapInstance(toolName, ctx, lspConfig);
    if (tool) {
      registry.register(toolName, tool);
      registered++;
    }
  }

  return registered;
}

/**
 * Create an LSAP tool instance with proper client setup.
 */
function createLsapInstance(toolName, ctx, lspConfig) {
  const ToolClass = LSAP_TOOL_MAP[toolName];
  if (!ToolClass) return null;

  // Get or create LSP client for the language
  let client = null;
  if (languageId) {
    client = getCachedClient(languageId);
    if (!client || !client.isReady()) {
      client = null;
    }
  }

  if (!client) {
    return null; // Skip if no LSP client available
  }

  return new ToolClass({ client, ctx, lspConfig });
}
```

### Integration from `src/tools/index.js`

The existing `src/tools/index.js` will import and call `registerLsapTools` alongside `registerLspTools`:

```javascript
// In src/tools/index.js, add:

import { registerLsapTools, LSAP_TOOL_NAMES } from '../../ext/lsap/index.js';

// Extend ALL_TOOL_NAMES
export const ALL_TOOL_NAMES = [...CORE_TOOL_NAMES, ...LSP_TOOL_NAMES, ...LSAP_TOOL_NAMES];

// In createToolFactory, add LSAP tool creation:
function createLsapInstance(toolName, ctx, lspConfig) {
  // ... same as in ext/lsap/index.js (or extract to shared module)
}

// In createTool() method, add:
if (toolName.startsWith('lsap-')) {
  const lspConfig = ctx?.lspConfig || null;
  if (isLspEnabled(lspConfig)) {
    return createLsapInstance(toolName, ctx, lspConfig);
  }
  return null;
}
```

### Tool Naming Convention

| Convention | Example | Rationale |
|------------|---------|-----------|
| Prefix | `lsap-` | Distinguishes from raw LSP tools (`lsp-`) |
| Format | `lsap-inspect`, `lsap-references` | Descriptive, follows oa-js naming |
| Registry | Separate from `LSP_TOOL_NAMES` | LSAP tools are optional, registered separately |

### Optional Registration

LSAP tools follow the same optional pattern as existing LSP tools:
1. Only registered when LSP is enabled (`isLspEnabled(lspConfig)`)
2. Only created when an LSP client is available for the language
3. Fail gracefully — if a capability is not supported by the server, the tool returns an error result

---

## Phase-by-Phase Implementation Plan

### Phase 1: Foundation — Models, Symbol Utilities, and Locate

**Goal**: Add the foundational types, symbol utilities, and locate API.

#### Files to Create

```
ext/lsap/
├── models.js         — Position, Range, Location, SymbolKind factory functions
├── symbol.js         — iterSymbols(), symbolAt(), contains(), isNarrower()
├── locate.js         — LocateCapability, parseLocateString(), detectMarker()
├── document-reader.js — DocumentReader class
├── capability.js     — Capability base class, ensureCapability()
└── id.js             — generateShortId() using crypto.randomUUID()
```

#### Implementation Details

**1. `models.js`** — Type definitions using JSDoc + factory functions:

```javascript
// Key exports:
export function createPosition({ line, character }) { ... }
export function createRange({ start, end }) { ... }
export function createLocation({ uri, range }) { ... }
export const SymbolKind = { ... };
export const SymbolKindCode = new Map([...]);
```

**2. `symbol.js`** — Symbol tree traversal:

```javascript
export function* iterSymbols(symbols) { ... }  // DFS generator
export function symbolAt(symbols, position) { ... }
export function contains(range, position) { ... }
export function isNarrower(inner, outer) { ... }
```

**3. `locate.js`** — Symbol resolution:

```javascript
export class LocateCapability extends Capability {
  async locate({ filePath, symbolPath, line, find }) { ... }
}
export function parseLocateString(str) { ... }
export function detectMarker(text) { ... }
```

**4. `document-reader.js`** — Efficient file content access:

```javascript
export class DocumentReader {
  constructor({ filePath, content, languageId }) { ... }
  async readRange(range, contextLines) { ... }  // Read with line numbers
  wordAt(position) { ... }  // Extract word at position
  positionToOffset(pos) { ... }  // Position → byte offset
  offsetToPosition(offset) { ... }  // Byte offset → position
}
```

**5. `capability.js`** — Base class and helpers:

```javascript
export class Capability {
  constructor({ client }) { ... }
  async execute(input) { throw new Error('Not implemented'); }
}
export function ensureCapability(client, capability) { ... }
```

**6. `id.js`** — Short ID generation:

```javascript
import { randomBytes } from 'node:crypto';

/**
 * Generate a short random ID (8 chars, URL-safe).
 * @returns {string}
 */
export function generateShortId() {
  return randomBytes(6).toString('hex').slice(0, 8);
}
```

#### No New Dependencies

All modules use only Node.js built-ins (`fs`, `path`, `crypto`) and existing oa-js code (`ext/lsp/` utilities).

---

### Phase 2: Cognitive Capabilities — Inspect, Definition, Reference

**Goal**: Add the first three cognitive capabilities that compose multiple LSP calls.

#### Files to Create

```
ext/lsap/
├── inspect.js      — InspectCapability (locate + symbol + hover + callHierarchy)
├── definition.js   — DefinitionCapability (locate + definition + inspect)
└── reference.js    — ReferenceCapability (references + context + hover + pagination)
```

#### Implementation Details

**1. `inspect.js`** — Inspect a symbol at a position:

```javascript
export class InspectCapability extends Capability {
  async execute(input) {
    const { filePath, line, character } = input;
    // 1. Get hover info
    const hover = await this.client.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: line - 1, character },
    }).catch(() => null);

    // 2. Get document symbols
    const symbols = await this.client.request('textDocument/documentSymbol', {
      textDocument: { uri },
    }).catch(() => null);

    // 3. Find symbol at position
    const position = { line: line - 1, character };
    const symbol = symbolAt(symbols, position);

    // 4. Get call hierarchy (if supported)
    let callHierarchy = null;
    if (ensureCapability(this.client, 'callHierarchyProvider')) {
      callHierarchy = await this._getCallHierarchy(uri, position);
    }

    // 5. Format output
    const markdown = this._formatInspect(symbol, hover, callHierarchy);
    return ToolResult.ok(markdown);
  }
}
```

**2. `definition.js`** — Resolve definitions with context:

```javascript
export class DefinitionCapability extends Capability {
  async execute(input) {
    const { filePath, line, character, mode } = input;
    // 1. Locate the symbol
    const location = await this.locateCapability.locate({
      filePath, line, symbolPath: null, find: null,
    });

    // 2. Fetch definition/declaration/typeDefinition
    const method = mode === 'typeDefinition'
      ? 'textDocument/typeDefinition'
      : 'textDocument/definition';
    const results = await this.client.request(method, {
      textDocument: { uri: location.uri },
      position: location.position,
    }).catch(() => null);

    // 3. For each result, get code context
    const items = await Promise.all(
      (Array.isArray(results) ? results : [results]).map(async (loc) => {
        const code = await this._getCodeContext(loc.uri, loc.range);
        return { location: loc, code };
      })
    );

    return ToolResult.ok(this._formatDefinition(items));
  }
}
```

**3. `reference.js`** — Find references with context and pagination:

```javascript
export class ReferenceCapability extends Capability {
  async execute(input) {
    const { filePath, line, character, mode, maxItems, startIndex, contextLines } = input;

    // 1. Locate the symbol
    const location = await this.locateCapability.locate({
      filePath, line, symbolPath: null, find: null,
    });

    // 2. Fetch references
    const method = mode === 'implementations' ? 'textDocument/implementation' : 'textDocument/references';
    const allRefs = await this.client.request(method, {
      textDocument: { uri: location.uri },
      position: location.position,
      includeDeclaration: true,
    }).catch(() => []);

    // 3. For each reference, read context
    const items = await Promise.allSettled(
      allRefs.map(async (ref) => {
        const context = await this._readContext(ref.uri, ref.range, contextLines);
        const hover = await this.client.request('textDocument/hover', {
          textDocument: { uri: ref.uri },
          position: ref.range.start,
        }).catch(() => null);
        return { location: ref, context, hover };
      })
    );

    // 4. Apply pagination
    const settled = items.filter(r => r.status === 'fulfilled').map(r => r.value);
    const page = settled.slice(startIndex, startIndex + maxItems);

    return ToolResult.ok(this._formatReferences(page, allRefs.length, startIndex, maxItems));
  }
}
```

#### Concurrency Pattern

Uses `Promise.allSettled()` for parallel execution — matching existing oa-js patterns from `ext/lsp/client.js`:

```javascript
// Existing pattern in ext/lsp/client.js:
const batchSize = 50;
for (let i = 0; i < openPromises.length; i += batchSize) {
  await Promise.allSettled(openPromises.slice(i, i + batchSize));
}

// Same pattern in LSAP capabilities:
const items = await Promise.allSettled(
  allRefs.map(async (ref) => { ... })
);
```

---

### Phase 3: Cognitive Capabilities — Outline, Search, Rename

**Goal**: Add directory outline, workspace search, and rename capabilities.

#### Files to Create

```
ext/lsap/
├── outline.js    — OutlineCapability (file mode + directory mode)
├── search.js     — SearchCapability (workspaceSymbol + pagination)
└── rename.js     — RenamePreviewCapability + RenameExecuteCapability
```

#### Implementation Details

**1. `outline.js`** — Hierarchical symbol outline:

```javascript
export class OutlineCapability extends Capability {
  async execute(input) {
    const { mode, path, recursive, contextLines } = input;

    if (mode === 'file') {
      // File mode: get document symbols + optional hover
      const symbols = await this.client.request('textDocument/documentSymbol', {
        textDocument: { uri: pathToUri(path) },
      }).catch(() => null);
      return ToolResult.ok(this._formatOutline(symbols, path, contextLines));
    }

    if (mode === 'directory') {
      // Directory mode: scan files, get top-level symbols
      const files = this._scanDirectory(path, input.glob);
      const results = await Promise.allSettled(
        files.map(async (file) => {
          const symbols = await this.client.request('textDocument/documentSymbol', {
            textDocument: { uri: pathToUri(file) },
          }).catch(() => null);
          return { file, symbols: (symbols || []).filter(s => !s.children) };
        })
      );
      return ToolResult.ok(this._formatDirectoryOutline(results));
    }
  }
}
```

**2. `search.js`** — Workspace symbol search:

```javascript
export class SearchCapability extends Capability {
  async execute(input) {
    const { query, kind, maxItems, startIndex } = input;

    // Fetch workspace symbols
    const symbols = await this.client.request('workspace/symbol', {
      query,
    }).catch(() => []);

    // Filter by kind if specified
    const filtered = kind
      ? symbols.filter(s => SymbolKindCode.get(s.kind) === kind)
      : symbols;

    // Apply pagination
    const page = filtered.slice(startIndex, startIndex + maxItems);

    return ToolResult.ok(this._formatSearch(page, filtered.length, startIndex, maxItems));
  }
}
```

**3. `rename.js`** — Two-step rename workflow:

```javascript
export class RenamePreviewCapability extends Capability {
  async execute(input) {
    const { filePath, line, character, newName } = input;

    // Step 1: Prepare rename
    const renameInfo = await this.client.request('textDocument/prepareRename', {
      textDocument: { uri },
      position: { line: line - 1, character },
    }).catch(() => null);

    if (!renameInfo) {
      return ToolResult.err('Rename not supported at this position');
    }

    // Step 2: Get rename edits
    const edits = await this.client.request('textDocument/rename', {
      textDocument: { uri },
      position: { line: line - 1, character },
      newName,
    }).catch(() => null);

    // Step 3: Read affected files and generate diffs
    const renameId = generateShortId();
    const preview = await this._generatePreview(edits, renameId);

    return ToolResult.ok(this._formatRenamePreview(preview, renameId));
  }
}

export class RenameExecuteCapability extends Capability {
  async execute(input) {
    const { renameId, edits, excludeFiles } = input;
    // Apply workspace edit
    const result = await this.client.request('workspace/applyEdit', {
      edit: { changes: edits },
    }).catch(() => null);

    return ToolResult.ok(this._formatRenameExecute(result));
  }
}
```

---

### Phase 4: Caching and Utilities

**Goal**: Add result caching and pagination infrastructure.

#### Files to Create

```
ext/lsap/
├── cache.js      — LRUCache, PaginationCache
└── pagination.js — paginate() utility
```

#### Implementation Details

**1. `cache.js`** — LRU and pagination caches:

```javascript
/**
 * Simple LRU cache.
 * @template T
 */
export class LRUCache {
  /**
   * @param {number} maxSize - Maximum number of entries
   */
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);  // Move to end (most recent)
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);  // Evict least recent
    }
    this.cache.set(key, value);
  }

  has(key) {
    return this.cache.has(key);
  }

  clear() {
    this.cache.clear();
  }
}

/**
 * Cache for paginated results.
 * Stores full result sets keyed by pagination ID.
 * @template T
 */
export class PaginationCache {
  constructor(maxSize = 50) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(paginationId) {
    return this.cache.get(paginationId);
  }

  set(paginationId, items) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(paginationId, items);
  }

  has(paginationId) {
    return this.cache.has(paginationId);
  }

  clear() {
    this.cache.clear();
  }
}
```

**2. `pagination.js`** — Pagination utility:

```javascript
/**
 * Paginate a result set.
 * @param {Array} items - Full result set
 * @param {number} startIndex - Starting index (0-based)
 * @param {number} maxItems - Maximum items per page
 * @param {string} [paginationId] - Optional cache ID
 * @returns {{page: Array, total: number, hasMore: boolean, paginationId: string}}
 */
export function paginate(items, startIndex, maxItems, paginationId = null) {
  const total = items.length;
  const end = Math.min(startIndex + maxItems, total);
  const page = items.slice(startIndex, end);
  const hasMore = end < total;
  const pid = paginationId || generateShortId();

  return { page, total, hasMore, paginationId: pid };
}
```

---

### Phase 5: Tool Wrappers and Registration

**Goal**: Create tool wrapper classes for each capability and register them with the tool registry.

#### Files to Create

```
ext/lsap/
├── index.js          — Entry point with registerLsapTools()
├── tools/
│   ├── base.js       — LsapBaseTool (shared helpers)
│   ├── lsap-inspect.js
│   ├── lsap-definition.js
│   ├── lsap-references.js
│   ├── lsap-outline.js
│   ├── lsap-search.js
│   ├── lsap-rename-preview.js
│   ├── lsap-rename-execute.js
│   └── lsap-locate.js
```

#### Implementation Details

**1. `tools/base.js`** — Base class for LSAP tools:

```javascript
import { ToolResult, toolDef, param } from '../../../src/tools/registry.js';
import { getCachedClient } from '../../lsp/client-cache.js';
import { getLanguageId } from '../../lsp/utils.js';

/**
 * Base class for all LSAP tools.
 */
export class LsapBaseTool {
  static TOOL_NAME = 'lsap-base';
  static DESCRIPTION = '';

  constructor({ client, ctx, lspConfig }) {
    this.client = client;
    this.ctx = ctx;
    this.lspConfig = lspConfig;
  }

  toToolDef() {
    return toolDef(
      this.constructor.TOOL_NAME,
      this.constructor.DESCRIPTION || 'LSAP tool',
      { schema: 'https://json-schema.org/draft/2020-12/schema', properties: {}, required: [] }
    );
  }

  async execute(input, ctx) {
    return ToolResult.err('Not implemented');
  }

  callDisplay(input) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    return `${this.constructor.TOOL_NAME}(${JSON.stringify(args)})`;
  }

  _getClient(languageId) {
    return getCachedClient(languageId);
  }

  _getLanguageId(filePath) {
    return getLanguageId(filePath);
  }
}
```

**2. Example tool wrapper (`tools/lsap-inspect.js`)**:

```javascript
import { LsapBaseTool } from './base.js';
import { InspectCapability } from '../inspect.js';
import { toolDef, param, ToolResult } from '../../../src/tools/registry.js';
import { getCachedClient } from '../../lsp/client-cache.js';
import { getLanguageId } from '../../lsp/utils.js';

export class InspectTool extends LsapBaseTool {
  static TOOL_NAME = 'lsap-inspect';
  static DESCRIPTION = 'Inspect a symbol at a position: get its type, documentation, callers, and callees. Combines hover, document symbols, and call hierarchy into a single report.';

  toToolDef() {
    return toolDef(
      InspectTool.TOOL_NAME,
      InspectTool.DESCRIPTION,
      {
        schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          file: param('string', 'Path to the file.'),
          line: param('integer', '1-indexed line number.'),
          character: param('integer', '0-indexed character offset (UTF-16).'),
        },
        required: ['file', 'line', 'character'],
      }
    );
  }

  async execute(input, ctx) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    const filePath = args.file;
    const line = args.line;
    const character = args.character;

    if (!filePath || !line || character === undefined) {
      return ToolResult.err('file, line, and character are required');
    }

    const languageId = this._getLanguageId(filePath);
    const client = this._getClient(languageId);

    if (!client) {
      return ToolResult.err(`No language server configured for '${languageId}'`);
    }

    const capability = new InspectCapability({ client });
    return capability.execute({ filePath, line, character });
  }
}
```

**3. `index.js`** — Entry point with registration:

```javascript
// ext/lsap/index.js
import { InspectTool } from './tools/lsap-inspect.js';
import { DefinitionTool } from './tools/lsap-definition.js';
import { ReferenceTool } from './tools/lsap-references.js';
import { OutlineTool } from './tools/lsap-outline.js';
import { SearchTool } from './tools/lsap-search.js';
import { RenamePreviewTool } from './tools/lsap-rename-preview.js';
import { RenameExecuteTool } from './tools/lsap-rename-execute.js';
import { LocateTool } from './tools/lsap-locate.js';
import { isLspEnabled } from '../lsp/config.js';
import { getCachedClient } from '../lsp/client-cache.js';
import { getLanguageId } from '../lsp/utils.js';

// Capability exports
export { Capability } from './capability.js';
export { LocateCapability } from './locate.js';
export { InspectCapability } from './inspect.js';
export { DefinitionCapability } from './definition.js';
export { ReferenceCapability } from './reference.js';
export { OutlineCapability } from './outline.js';
export { SearchCapability } from './search.js';
export { RenamePreviewCapability, RenameExecuteCapability } from './rename.js';

// Model exports
export { createPosition, createRange, createLocation, SymbolKind } from './models.js';
export { iterSymbols, symbolAt, contains, isNarrower } from './symbol.js';

// Utility exports
export { LRUCache, PaginationCache } from './cache.js';
export { paginate } from './pagination.js';
export { renderTemplate, cleanHoverContent } from './markdown.js';
export { generateShortId } from './id.js';

// Tool exports
export { InspectTool, DefinitionTool, ReferenceTool, OutlineTool, SearchTool };
export { RenamePreviewTool, RenameExecuteTool, LocateTool };

/** LSAP tool names */
export const LSAP_TOOL_NAMES = [
  'lsap-inspect', 'lsap-definition', 'lsap-references',
  'lsap-outline', 'lsap-search',
  'lsap-rename-preview', 'lsap-rename-execute',
  'lsap-locate',
];

/**
 * Register all LSAP tools with a registry when LSP is enabled.
 */
export async function registerLsapTools(registry, ctx) {
  const lspConfig = ctx?.lspConfig || null;
  if (!isLspEnabled(lspConfig)) return 0;

  const languageId = ctx?.currentFile ? getLanguageId(ctx.currentFile) : null;
  let registered = 0;

  for (const toolName of LSAP_TOOL_NAMES) {
    const tool = createLsapInstance(toolName, ctx, lspConfig);
    if (tool) {
      registry.register(toolName, tool);
      registered++;
    }
  }
  return registered;
}

function createLsapInstance(toolName, ctx, lspConfig) {
  const toolMap = {
    'lsap-inspect': InspectTool,
    'lsap-definition': DefinitionTool,
    'lsap-references': ReferenceTool,
    'lsap-outline': OutlineTool,
    'lsap-search': SearchTool,
    'lsap-rename-preview': RenamePreviewTool,
    'lsap-rename-execute': RenameExecuteTool,
    'lsap-locate': LocateTool,
  };

  const ToolClass = toolMap[toolName];
  if (!ToolClass) return null;

  const languageId = ctx?.currentFile ? getLanguageId(ctx.currentFile) : null;
  const client = languageId ? getCachedClient(languageId) : null;

  if (!client || !client.isReady()) return null;

  return new ToolClass({ client, ctx, lspConfig });
}
```

---

### Phase 6: Integration and Documentation

**Goal**: Wire LSAP tools into the main tool factory and document the new capabilities.

#### Changes to `src/tools/index.js`

```javascript
// Add imports
import { registerLsapTools, LSAP_TOOL_NAMES } from '../../ext/lsap/index.js';

// Extend ALL_TOOL_NAMES
export const ALL_TOOL_NAMES = [...CORE_TOOL_NAMES, ...LSP_TOOL_NAMES, ...LSAP_TOOL_NAMES];

// Add LSAP tool creation in createTool() method
function createLsapInstance(toolName, ctx, lspConfig) {
  // ... (same as in ext/lsap/index.js, or extract to shared module)
}

// In createTool() method, add after LSP tools check:
if (toolName.startsWith('lsap-')) {
  const lspConfig = ctx?.lspConfig || null;
  if (isLspEnabled(lspConfig)) {
    return createLsapInstance(toolName, ctx, lspConfig);
  }
  return null;
}
```

#### Documentation

Add TOC entries for new tools:

| Tool | Description |
|------|-------------|
| `lsap-locate` | Resolve a symbol or position using string syntax (`file.py:scope@find`) |
| `lsap-inspect` | Inspect a symbol: type, docs, callers, callees |
| `lsap-definition` | Resolve definitions with code context |
| `lsap-references` | Find references with context lines and hover |
| `lsap-outline` | Hierarchical symbol outline (file or directory mode) |
| `lsap-search` | Workspace symbol search with pagination |
| `lsap-rename-preview` | Preview rename changes before applying |
| `lsap-rename-execute` | Execute a previously previewed rename |

---

## Gap Analysis

### What LSAP Adds That oa-js Doesn't Have

| Feature | Status | Notes |
|---------|--------|-------|
| **Unified Locate API** | New | Fuzzy symbol path resolution, regex find, markers |
| **Cognitive Capabilities** | New | Single request composes multiple LSP calls |
| **Markdown-First Output** | New | Standardized output via string templates |
| **Rename Preview/Execute** | New | Two-step rename with preview |
| **Directory Outline** | New | Scan directories for symbols with glob |
| **Call Hierarchy** | New | Incoming/outgoing call relationships |
| **Pagination** | New | Built-in pagination for large results |
| **Result Caching** | New | LRU cache, pagination cache |
| **Symbol Path Navigation** | New | Navigate via `module.Class.method` |
| **Scoped Operations** | New | Limit to line ranges or symbol bodies |

### What oa-js Already Has That LSAP Reuses

| Feature | Source | Notes |
|---------|--------|-------|
| **LSP Transport** | `ext/lsp/client.js` | LspClient handles JSON-RPC, process mgmt |
| **Document Store** | `ext/lsp/document-store.js` | In-memory document state |
| **Path/URI Utils** | `ext/lsp/utils.js` | pathToUri, uriToPath, getLanguageId |
| **Tool Framework** | `src/tools/registry.js` | ToolResult, ToolRegistry, toolDef |
| **Base Tool Helpers** | `ext/lsp/tools/base.js` | Formatting, position validation |
| **Client Caching** | `ext/lsp/client-cache.js` | Per-language LSP client cache |
| **Concurrency** | Existing | `Promise.allSettled()` used throughout |

### Architecture Differences: Python LSAP vs JavaScript LSAP

| Aspect | Python LSAP | JavaScript LSAP (oa-js) |
|--------|-------------|------------------------|
| **Language** | Python | JavaScript (Node.js) |
| **Transport** | `lsp-client` library | `ext/lsp/client.js` (LspClient) |
| **Models** | Pydantic + JSON Schema | JSDoc + factory functions |
| **Output** | Liquid templates | String templates (`${var}`) |
| **Concurrency** | `anyio` + `asyncer` | `Promise.allSettled()` |
| **Caching** | LRU + Pagination caches | Same, implemented in JS |
| **Error Types** | Typed exceptions | `ToolResult.err()` |
| **Dependencies** | 6+ libraries | Zero new packages |

### Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| LSAP orchestration adds latency | Medium | Use `Promise.allSettled()` for parallel calls, add caching |
| Language server compatibility | Medium | Graceful fallback — check capabilities before calling |
| Increased tool complexity | Low | Keep each capability focused, document clearly |
| Template maintenance overhead | Low | Simple string templates, minimal complexity |
| Duplicate functionality with raw LSP tools | Low | LSAP tools are additive, not replacements |

---

## Appendix A: LSAP Request/Response Quick Reference

### Common Request Fields

| Field | Type | Description |
|-------|------|-------------|
| `filePath` | `string` | Target file path |
| `line` | `number` | 1-indexed line number |
| `character` | `number` | 0-indexed character offset (UTF-16) |
| `symbolPath` | `string` | Dot-separated symbol path |
| `mode` | `string` | Operation mode (varies by capability) |
| `maxItems` | `number` | Maximum results to return |
| `startIndex` | `number` | Pagination offset (0-based) |
| `contextLines` | `number` | Lines of context around matches |
| `paginationId` | `string` | Pagination continuation ID |

### Common Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `items` | `array` | Result items |
| `total` | `number` | Total result count |
| `hasMore` | `boolean` | More results available |
| `paginationId` | `string` | ID for next page |
| `markdown` | `string` | Formatted Markdown output |

### SymbolKind Values (Numeric → String)

| Code | Name | Code | Name |
|------|------|------|------|
| 1 | File | 14 | Constant |
| 2 | Module | 15 | String |
| 3 | Namespace | 16 | Number |
| 4 | Package | 17 | Boolean |
| 5 | Class | 18 | Array |
| 6 | Method | 19 | Object |
| 7 | Property | 20 | Key |
| 8 | Field | 21 | Null |
| 9 | Constructor | 22 | EnumMember |
| 10 | Enum | 23 | Struct |
| 11 | Interface | 24 | Event |
| 12 | Function | 25 | Operator |
| 13 | Variable | 26 | TypeParameter |

### Locate String Syntax

| Format | Example | Description |
|--------|---------|-------------|
| File + symbol | `"foo.py:MyClass.my_method"` | Locate symbol declaration |
| File + find | `"foo.py@self.<|>"` | Find pattern with marker |
| File + line + find | `"foo.py:42@return <|>result"` | Line scope with find |
| File + range + find | `"foo.py:10,20@if <|>condition"` | Line range with find |

### Marker Detection

LSAP uses nested bracket notation for position markers:
- `<|>` — single level
- `<<|>>` — double level (used when `<|>` appears multiple times in source)
- `<<<|>>>` — triple level, etc.

---

## Appendix B: oa-js File Reference

### Existing LSP Files

| File | Lines | Purpose |
|------|-------|---------|
| `ext/lsp/client.js` | ~550 | LspClient: JSON-RPC, process management |
| `ext/lsp/client-cache.js` | ~50 | LSP client caching |
| `ext/lsp/config.js` | ~80 | Server configuration helpers |
| `ext/lsp/document-store.js` | ~80 | Document content storage |
| `ext/lsp/utils.js` | ~120 | URI/path conversion, language detection |
| `ext/lsp/tools/base.js` | ~350 | Base tool class, formatting helpers |
| `ext/lsp/tools/index.js` | ~15 | Tool exports |
| `ext/lsp/tools/lsp-*.js` | ~100 each | Individual LSP tools (12 total) |

### Integration Files

| File | Integration |
|------|-------------|
| `src/tools/registry.js` | ToolResult, ToolRegistry, ToolContext |
| `src/tools/index.js` | createToolFactory, registerLspTools |
| `ext/lsp/index.js` | registerLspTools, LSP_TOOL_NAMES |
| `ext/lsap/index.js` | registerLsapTools, LSAP_TOOL_NAMES (new) |

### New LSAP Files (Proposed)

| File | Lines (est.) | Purpose |
|------|--------------|---------|
| `ext/lsap/index.js` | ~80 | Entry point, registration |
| `ext/lsap/models.js` | ~100 | Type definitions, factory functions |
| `ext/lsap/symbol.js` | ~60 | Symbol tree utilities |
| `ext/lsap/locate.js` | ~150 | Locate capability, string parsing |
| `ext/lsap/document-reader.js` | ~80 | File content access |
| `ext/lsap/capability.js` | ~50 | Base class, helpers |
| `ext/lsap/inspect.js` | ~120 | Inspect capability |
| `ext/lsap/definition.js` | ~100 | Definition capability |
| `ext/lsap/reference.js` | ~150 | Reference capability with pagination |
| `ext/lsap/outline.js` | ~120 | Outline capability |
| `ext/lsap/search.js` | ~80 | Search capability |
| `ext/lsap/rename.js` | ~150 | Rename preview + execute |
| `ext/lsap/cache.js` | ~80 | LRU and pagination caches |
| `ext/lsap/pagination.js` | ~40 | Pagination utility |
| `ext/lsap/markdown.js` | ~60 | Template rendering, formatting |
| `ext/lsap/id.js` | ~20 | Short ID generation |
| `ext/lsap/tools/base.js` | ~80 | LSAP base tool class |
| `ext/lsap/tools/lsap-*.js` | ~80 each | Individual tool wrappers (8 tools) |
| **Total** | **~1650** | |

---

## Getting Started: Phase 1 Checklist

A developer can start implementing Phase 1 immediately with this checklist:

- [ ] Create `ext/lsap/` directory
- [ ] Create `ext/lsap/models.js` with JSDoc types and factory functions
- [ ] Create `ext/lsap/symbol.js` with iterSymbols, symbolAt, contains, isNarrower
- [ ] Create `ext/lsap/locate.js` with LocateCapability class
- [ ] Create `ext/lsap/document-reader.js` with DocumentReader class
- [ ] Create `ext/lsap/capability.js` with Capability base class
- [ ] Create `ext/lsap/id.js` with generateShortId()
- [ ] Create `ext/lsap/markdown.js` with renderTemplate(), cleanHoverContent()
- [ ] Create `ext/lsap/cache.js` with LRUCache, PaginationCache
- [ ] Create `ext/lsap/pagination.js` with paginate()
- [ ] Verify imports work: `import { createPosition } from '../../ext/lsap/models.js'`
- [ ] Write basic tests for symbol utilities

All modules depend only on Node.js built-ins and existing `ext/lsp/` code. No new npm packages needed.
