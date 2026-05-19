// LSP Client — JSON-RPC 2.0 over stdio with language server process management.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DocumentStore } from './document-store.js';
import { pathToUri } from './utils.js';

// JSON-RPC 2.0 message framing constants
const HEADER_REGEX = /^Content-Length: (\d+)\r?\n/;
const SEPARATOR = '\r\n';

/**
 * LSP Client error — wraps JSON-RPC errors.
 */
export class LspError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = 'LspError';
    this.code = code;
    this.data = data;
  }
}

/**
 * LSP Client — manages communication with a language server process.
 *
 * Implements JSON-RPC 2.0 over stdio with HTTP-like Content-Length framing.
 * Supports request/response, notifications, and lifecycle management.
 */
export class LspClient {
  /**
   * @param {object} [options] - Client options
   * @param {number} [options.requestTimeoutMs] - Request timeout in milliseconds
   * @param {number} [options.serverStartupTimeoutMs] - Server startup timeout
   */
  constructor(options = {}) {
    this.process = null;
    this.requestId = 0;
    /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.pendingRequests = new Map();
    this.capabilities = null;
    this.isInitialized = false;
    this.isShuttingDown = false;
    this.documentStore = new DocumentStore();
    this.onNotification = null;

    // Diagnostics cache — maps URI -> array of diagnostics
    /** @type {Map<string, import('./client.js').Diagnostic[]>} */
    this._diagnosticsCache = new Map();
    this._buffer = '';
    this._stderrOutput = '';
    this._stderrLines = 0;
    this._maxStderrLines = 50;

    // Configuration
    this.requestTimeoutMs = options.requestTimeoutMs || 30000;
    this.serverStartupTimeoutMs = options.serverStartupTimeoutMs || 60000;
  }

  /**
   * Initialize the language server and establish communication.
   * @param {object} config - Server configuration
   * @param {string} config.command - Command to run the language server
   * @param {string[]} config.args - Arguments for the command
   * @param {object} [config.initializationOptions] - Initialization options
   * @param {string} [config.rootPath] - Workspace root path
   * @param {object} [config.env] - Environment variables
   * @param {number} [config.timeoutMs] - Per-request timeout
   * @returns {Promise<object>} Server capabilities
   */
  async initialize(config) {
    if (this.process) {
      throw new Error('Client already initialized');
    }

    const command = config.command;
    const args = config.args || [];
    const env = config.env || process.env;
    const rootPath = config.rootPath || process.cwd();

    // Spawn the language server process
    this.process = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      detached: false,
      cwd: rootPath,
    });

    // Set up message handlers
    this._setupStdioHandlers();

    // Wait for server to be ready with startup timeout
    const startupPromise = new Promise((_, reject) => {
      this._startupTimer = setTimeout(() => {
        reject(new Error(
          `Language server '${command}' did not respond within ${this.serverStartupTimeoutMs}ms`
        ));
      }, this.serverStartupTimeoutMs);
    });

    try {
      // Send initialize request
      const result = await Promise.race([
        this._doInitialize(config, rootPath),
        startupPromise,
      ]);

      // Clear startup timer on success
      clearTimeout(this._startupTimer);

      // Send initialized notification
      try {
        await this.notification('initialized', { capabilities: {} });
      } catch {
        // Non-fatal — server may have already exited
      }

      // Small delay to let the server settle before indexing
      await new Promise(r => setTimeout(r, 1000));

      // Index workspace — open all JS/TS files so the server has full project
      // context for cross-file references, workspace symbols, etc.
      try {
        await this._indexWorkspace(rootPath);
      } catch (e) {
        // Non-fatal — server can still work without full indexing
        console.error(`LSP workspace indexing failed: ${e.message}`);
      }

      // Small delay after indexing to let the server process files
      await new Promise(r => setTimeout(r, 500));

      // Force TypeScript server to reload projects (required for workspace/symbol)
      try {
        await this.request('workspace/executeCommand', {
          command: 'typescript.reloadProjects',
          arguments: [],
        });
      } catch {
        // Non-fatal — server may not support this command
      }

      this.isInitialized = true;
      return result;
    } catch (e) {
      await this._cleanupProcess();
      throw e;
    }
  }

  /**
   * Index the workspace — discover and open all JS/TS source files.
   * This gives the language server full project context for cross-file
   * references, workspace symbols, go-to-definition across modules, etc.
   * @param {string} rootPath - Workspace root directory
   * @returns {Promise<void>}
   */
  async _indexWorkspace(rootPath) {
    const exts = new Set(['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx']);
    const skipDirs = new Set([
      'node_modules', 'dist', 'build', '.git', '.next', 'out',
      '__pycache__', '.bun', 'vendor',
    ]);
    const files = [];

    const walk = (dir) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (skipDirs.has(entry.name)) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile() && exts.has(path.extname(entry.name))) {
            files.push(fullPath);
          }
        }
      } catch {
        // Skip unreadable directories
      }
    };

    walk(rootPath);

    // Also open tsconfig.json if present — required for TS server project context
    const tsconfigPath = path.join(rootPath, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      files.unshift(tsconfigPath);
    }

    // Open each file with the language server
    const openPromises = files.map(async (filePath) => {
      const ext = path.extname(filePath);
      let langId = 'javascript';
      if (['.ts', '.tsx'].includes(ext)) langId = 'typescript';
      else if (['.jsx'].includes(ext)) langId = 'javascriptreact';
      else if (['.tsx'].includes(ext)) langId = 'typescriptreact';
      else if (ext === '.json') langId = 'json';

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const uri = pathToUri(filePath);
        await this.didOpen(uri, content, langId);
      } catch {
        // Skip files that can't be read
      }
    });

    // Open files in batches to avoid overwhelming the server
    const batchSize = 50;
    for (let i = 0; i < openPromises.length; i += batchSize) {
      await Promise.allSettled(openPromises.slice(i, i + batchSize));
    }
  }

  /**
   * Internal initialize — sends the initialize request.
   */
  async _doInitialize(config, rootPath) {
    const result = await this.request('initialize', {
      processId: process.pid,
      rootUri: pathToUri(rootPath),
      capabilities: this._getClientCapabilities(),
      initializationOptions: {
        ...config.initializationOptions,
        // Explicitly set project root for TypeScript server
        projectRoot: rootPath,
      },
      workspaceFolders: rootPath ? [
        { uri: pathToUri(rootPath), name: 'workspace' }
      ] : null,
    });

    this.capabilities = result.capabilities;

    // Store per-request timeout if provided
    if (config.timeoutMs) {
      this.requestTimeoutMs = config.timeoutMs;
    }

    return result;
  }

  /**
   * Set up stdout/stderr/exit handlers for the language server process.
   */
  _setupStdioHandlers() {
    if (!this.process) return;

    let buffer = '';

    // Handle stdout — JSON-RPC messages
    this.process.stdout.on('data', (chunk) => {
      buffer += chunk.toString();

      // Process complete messages from buffer
      while (buffer.length > 0) {
        // Look for Content-Length header
        const headerMatch = buffer.match(HEADER_REGEX);
        if (!headerMatch) {
          // Not a valid header start — skip to next potential header
          const nextHeader = buffer.indexOf('Content-Length:');
          if (nextHeader === -1) {
            // No more headers in buffer — discard everything
            buffer = '';
          } else {
            buffer = buffer.slice(nextHeader);
          }
          return;
        }

        const contentLength = parseInt(headerMatch[1], 10);
        const headerEnd = buffer.indexOf(SEPARATOR + SEPARATOR);

        if (headerEnd === -1) {
          // Haven't seen the double-CRLF yet — wait for more data
          return;
        }

        const bodyStart = headerEnd + SEPARATOR.length * 2;
        const bodyEnd = bodyStart + contentLength;

        if (buffer.length < bodyEnd) {
          // Not enough data for the full body — wait
          return;
        }

        // Extract the JSON body
        const body = buffer.slice(bodyStart, bodyEnd);
        buffer = buffer.slice(bodyEnd);

        // Parse the message
        try {
          const message = JSON.parse(body);
          this._handleMessage(message);
        } catch (e) {
          // Malformed JSON — log and skip
          if (this._stderrLines < this._maxStderrLines) {
            this._stderrOutput += `Malformed LSP message: ${e.message}\n`;
            this._stderrLines++;
          }
        }
      }
    });

    // Handle stderr — server logs
    this.process.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (this._stderrLines < this._maxStderrLines) {
        this._stderrOutput += text;
        this._stderrLines = (this._stderrOutput.match(/\n/g) || []).length;
      }
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      this._cleanupPendingRequests(
        `Language server exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`
      );
      this.isInitialized = false;
      this.process = null;
    });

    // Handle process error
    this.process.on('error', (err) => {
      this._cleanupPendingRequests(`Process error: ${err.message}`);
      this.isInitialized = false;
    });
  }

  /**
   * Handle an incoming JSON-RPC message.
   */
  _handleMessage(message) {
    if (this.isShuttingDown) return;

    // Response to a request (has both 'id' and 'result')
    if ('id' in message && 'result' in message) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);
        pending.resolve(message.result);
      }
      return;
    }

    // Error response (has both 'id' and 'error')
    if ('id' in message && 'error' in message) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);
        const errInfo = message.error;
        const err = new LspError(
          errInfo.message || 'Unknown error',
          errInfo.code || -1,
          errInfo.data
        );
        pending.reject(err);
      }
      return;
    }

    // Notification from server (has 'method' but no 'id')
    if ('method' in message && !('id' in message)) {
      // Handle publishDiagnostics specially — cache diagnostics
      if (message.method === 'publishDiagnostics') {
        const { uri, diagnostics } = message.params || {};
        this._handlePublishDiagnostics(uri, diagnostics);
      }
      // Call custom notification handler if set
      if (this.onNotification) {
        try {
          this.onNotification(message.method, message.params);
        } catch (e) {
          // Notification handlers should not throw
        }
      }
      return;
    }

    // Request from server (has both 'method' and 'id') — not commonly used
    // but handle it gracefully by responding with MethodNotFound
    if ('method' in message && 'id' in message) {
      this._sendMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: 'Method not found',
        },
      });
    }
  }

  /**
   * Send a JSON-RPC request and return the result.
   * @param {string} method - LSP method name
   * @param {object} [params] - Request parameters
   * @returns {Promise<any>} Response result
   */
  async request(method, params) {
    if (!this.process) {
      throw new Error('Client not initialized or process not available');
    }

    const id = ++this.requestId;
    const message = { jsonrpc: '2.0', id, method, params: params || null };

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request '${method}' timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
    });

    this._sendMessage(message);
    return promise;
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   * @param {string} method - LSP method name
   * @param {object} [params] - Notification parameters
   */
  async notification(method, params) {
    if (!this.process) {
      throw new Error('Client not initialized or process not available');
    }

    const message = { jsonrpc: '2.0', method, params: params || null };
    this._sendMessage(message);
  }

  /**
   * Send a JSON-RPC message to the server's stdin.
   */
  _sendMessage(message) {
    if (!this.process || !this.process.stdin) return;

    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}${SEPARATOR}${SEPARATOR}`;
    this.process.stdin.write(header + body);
  }

  /**
   * Get the client capabilities for the initialize request.
   */
  _getClientCapabilities() {
    return {
      textDocument: {
        synchronization: {
          dynamicRegistration: false,
          didSave: true,
          willSave: false,
          willSaveWaitUntil: false,
        },
        completion: {
          dynamicRegistration: false,
          completionItem: {
            snippetSupport: true,
            commitCharactersSupport: true,
            documentationFormat: ['markdown', 'plaintext'],
            deprecatedSupport: true,
          },
        },
        hover: {
          dynamicRegistration: false,
          contentFormat: ['markdown', 'plaintext'],
        },
        signatureHelp: {
          dynamicRegistration: false,
          signatureInformation: {
            documentationFormat: ['markdown', 'plaintext'],
          },
        },
        definition: {
          dynamicRegistration: false,
          linkSupport: true,
        },
        references: {
          dynamicRegistration: false,
        },
        documentSymbol: {
          dynamicRegistration: false,
          symbolKind: {
            valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
              11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
              21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
              31, 32, 33, 34, 35, 36, 37],
          },
        },
        codeAction: {
          dynamicRegistration: false,
          codeActionLiteralSupport: {
            codeActionKind: {
              valueSet: [
                '', 'quickfix', 'refactor', 'refactor.extract',
                'refactor.inline', 'refactor.move', 'refactor.rewrite',
                'source', 'source.organizeImports',
              ],
            },
          },
        },
        formatting: {
          dynamicRegistration: false,
        },
        rename: {
          dynamicRegistration: false,
          prepareSupport: true,
        },
        publishDiagnostics: {
          relatedInformation: true,
          tagSupport: { valueSet: [1, 2] },
        },
      },
      workspace: {
        symbol: {
          dynamicRegistration: false,
          symbolKind: {
            valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
              11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
              21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
              31, 32, 33, 34, 35, 36, 37],
          },
        },
        applyEdit: true,
        workspaceEdit: {
          documentChanges: true,
        },
      },
    };
  }

  /**
   * Open a document in the language server.
   * @param {string} uri - Document URI
   * @param {string} content - Document content
   * @param {string} languageId - Language identifier
   * @param {number} [version] - Document version (defaults to auto-increment)
   */
  async didOpen(uri, content, languageId, version) {
    if (!this.isInitialized) {
      throw new Error('Client not initialized');
    }

    const docVersion = version || this.documentStore.put(uri, content, languageId);

    await this.notification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: docVersion,
        text: content,
      },
    });
  }

  /**
   * Send document changes to the language server.
   * Uses full document sync (replaces entire content).
   * @param {string} uri - Document URI
   * @param {string} newContent - New document content
   */
  async didChange(uri, newContent) {
    if (!this.isInitialized) {
      throw new Error('Client not initialized');
    }

    const docVersion = this.documentStore.updateContent(uri, newContent);
    if (docVersion === undefined) {
      throw new Error(`Document not found: ${uri}`);
    }

    await this.notification('textDocument/didChange', {
      textDocument: {
        uri,
        version: docVersion,
      },
      contentChanges: [{
        text: newContent,
      }],
    });
  }

  /**
   * Close a document in the language server.
   * @param {string} uri - Document URI
   */
  async didClose(uri) {
    if (!this.isInitialized) {
      throw new Error('Client not initialized');
    }

    this.documentStore.delete(uri);

    await this.notification('textDocument/didClose', {
      textDocument: {
        uri,
      },
    });
  }

  /**
   * Get the language server's capabilities.
   * @returns {object|null}
   */
  getCapabilities() {
    return this.capabilities;
  }

  /**
   * Check if the client is initialized and ready.
   * @returns {boolean}
   */
  isReady() {
    return this.isInitialized && this.process !== null && this.process.connected;
  }

  /**
   * Get the server's textDocumentSync capability.
   * @returns {string|null} Sync kind or null
   */
  getDocumentSyncKind() {
    if (!this.capabilities) return null;
    const sync = this.capabilities.textDocumentSync;
    if (!sync) return null;
    if (typeof sync === 'number') return sync; // 0=none, 1=full, 2=incremental
    return sync.kind || sync; // May be an object with kind property
  }

  /**
   * Gracefully shutdown the language server.
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (!this.isInitialized || this.isShuttingDown) return;

    this.isShuttingDown = true;

    try {
      if (this.process && this.process.stdin) {
        // Send shutdown request
        try {
          await this.request('shutdown', null);
        } catch {
          // Server may have already started shutting down
        }

        // Send exit notification
        try {
          await this.notification('exit', null);
        } catch {
          // Non-fatal
        }
      }
    } finally {
      await this._cleanupProcess();
    }
  }

  /**
   * Force kill the language server process.
   */
  async forceKill() {
    await this._cleanupProcess(true);
  }

  /**
   * Internal cleanup — kill process and reject pending requests.
   * @param {boolean} [force] - Force kill instead of graceful shutdown
   */
  async _cleanupProcess(force) {
    this.isShuttingDown = true;
    this._cleanupPendingRequests(force ? 'Process killed' : 'Client shutdown');

    if (this.process) {
      // Clear stdin to prevent more writes
      if (this.process.stdin) {
        try {
          this.process.stdin.destroy();
        } catch {
          // Ignore destroy errors
        }
      }

      if (force) {
        this.process.kill('SIGKILL');
      } else {
        this.process.kill('SIGTERM');
        // Give it a moment, then force kill
        setTimeout(() => {
          if (this.process && this.process.exitCode === null) {
            try {
              this.process.kill('SIGKILL');
            } catch {
              // Already dead
            }
          }
        }, 2000);
      }

      this.process = null;
    }

    this.isInitialized = false;
    this.isShuttingDown = false;
  }

  /**
   * Reject all pending requests with a common error.
   */
  _cleanupPendingRequests(reason) {
    for (const [id, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error(reason || 'Connection lost'));
    }
    this.pendingRequests.clear();
  }

  /**
   * Get stderr output from the server (for debugging).
   * @returns {string}
   */
  getStderr() {
    return this._stderrOutput || '';
  }

  /**
   * Handle publishDiagnostics notification from the server.
   * Caches diagnostics by URI for later retrieval.
   * @param {string} uri - Document URI
   * @param {object[]} diagnostics - Array of diagnostic objects
   */
  _handlePublishDiagnostics(uri, diagnostics) {
    if (diagnostics && Array.isArray(diagnostics) && diagnostics.length > 0) {
      this._diagnosticsCache.set(uri, diagnostics);
    } else {
      // Empty or null diagnostics means clear diagnostics for this URI
      this._diagnosticsCache.delete(uri);
    }
  }

  /**
   * Get cached diagnostics for a document URI.
   * @param {string} uri - Document URI
   * @returns {object[] | null} Diagnostics array or null if not cached
   */
  getDiagnostics(uri) {
    return this._diagnosticsCache.get(uri) || null;
  }

  /**
   * Clear diagnostics cache for a specific URI.
   * @param {string} uri - Document URI
   */
  clearDiagnostics(uri) {
    this._diagnosticsCache.delete(uri);
  }

  /**
   * Clear all diagnostics cache.
   */
  clearAllDiagnostics() {
    this._diagnosticsCache.clear();
  }

  /**
   * Get the number of cached document URIs with diagnostics.
   * @returns {number}
   */
  getDiagnosticsCount() {
    return this._diagnosticsCache.size;
  }

  /**
   * Restart the language server process.
   */
  async restart(config) {
    await this._cleanupProcess(true);
    this.isShuttingDown = false;
    this._stderrOutput = '';
    this._stderrLines = 0;
    return this.initialize(config);
  }
}
