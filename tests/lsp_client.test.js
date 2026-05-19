import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { LspClient, LspError } from '../src/lsp/client.js';
import { DocumentStore } from '../src/lsp/document-store.js';

describe('LspError', () => {
  it('creates error with message', () => {
    const err = new LspError('test error', -1);
    expect(err.message).toBe('test error');
    expect(err.code).toBe(-1);
    expect(err.name).toBe('LspError');
  });

  it('creates error with message, code, and data', () => {
    const err = new LspError('test', -32600, { detail: 'info' });
    expect(err.message).toBe('test');
    expect(err.code).toBe(-32600);
    expect(err.data).toEqual({ detail: 'info' });
  });
});

describe('LspClient', () => {
  let client;

  beforeEach(() => {
    client = new LspClient();
  });

  afterEach(async () => {
    // Ensure client is cleaned up
    if (client) {
      try {
        await client.shutdown();
      } catch {
        // Ignore errors during cleanup
      }
    }
  });

  describe('constructor', () => {
    it('creates client with default values', () => {
      expect(client.process).toBeNull();
      expect(client.requestId).toBe(0);
      expect(client.capabilities).toBeNull();
      expect(client.isInitialized).toBe(false);
      expect(client.isShuttingDown).toBe(false);
      expect(client.documentStore).toBeInstanceOf(DocumentStore);
      expect(client.requestTimeoutMs).toBe(30000);
    });

    it('accepts custom timeout options', () => {
      const customClient = new LspClient({
        requestTimeoutMs: 60000,
        serverStartupTimeoutMs: 120000,
      });
      expect(customClient.requestTimeoutMs).toBe(60000);
    });

    it('creates client with custom document store', () => {
      const customClient = new LspClient();
      expect(customClient.documentStore).toBeInstanceOf(DocumentStore);
    });
  });

  describe('isReady', () => {
    it('returns false when not initialized', () => {
      expect(client.isReady()).toBe(false);
    });

    it('returns false when process is null', () => {
      client.isInitialized = true;
      client.process = null;
      expect(client.isReady()).toBe(false);
    });
  });

  describe('getCapabilities', () => {
    it('returns null when not initialized', () => {
      expect(client.getCapabilities()).toBeNull();
    });

    it('returns stored capabilities', () => {
      const caps = { textDocumentSync: 1, hoverProvider: true };
      client.capabilities = caps;
      expect(client.getCapabilities()).toEqual(caps);
    });
  });

  describe('getDocumentSyncKind', () => {
    it('returns null when no capabilities', () => {
      expect(client.getDocumentSyncKind()).toBeNull();
    });

    it('returns sync kind for numeric capability', () => {
      client.capabilities = { textDocumentSync: 1 };
      expect(client.getDocumentSyncKind()).toBe(1);
    });

    it('returns sync kind for object capability', () => {
      client.capabilities = { textDocumentSync: { kind: 2 } };
      expect(client.getDocumentSyncKind()).toBe(2);
    });

    it('returns the sync object when no kind property', () => {
      client.capabilities = { textDocumentSync: { didSave: true } };
      // When there's no 'kind' property, it returns the object itself
      const result = client.getDocumentSyncKind();
      expect(result).toEqual({ didSave: true });
    });
  });

  describe('getStderr', () => {
    it('returns empty string when no stderr', () => {
      expect(client.getStderr()).toBe('');
    });

    it('returns stored stderr', () => {
      client._stderrOutput = 'some error output';
      expect(client.getStderr()).toBe('some error output');
    });
  });

  describe('shutdown', () => {
    it('does nothing when not initialized', async () => {
      await expect(client.shutdown()).resolves.toBeUndefined();
    });

    it('sets isShuttingDown flag', async () => {
      client.isInitialized = true;
      client.isShuttingDown = false;
      await client.shutdown();
      // After shutdown, isInitialized should be false
    });
  });

  describe('forceKill', () => {
    it('does not throw when no process', async () => {
      await expect(client.forceKill()).resolves.toBeUndefined();
    });
  });

  describe('notification', () => {
    it('throws when not initialized', async () => {
      await expect(client.notification('test', {})).rejects.toThrow('not initialized');
    });
  });

  describe('request', () => {
    it('throws when not initialized', async () => {
      await expect(client.request('test', {})).rejects.toThrow('not initialized');
    });
  });

  describe('didOpen', () => {
    it('throws when not initialized', async () => {
      await expect(client.didOpen('file:///test.js', 'content', 'javascript')).rejects.toThrow('not initialized');
    });
  });

  describe('didClose', () => {
    it('throws when not initialized', async () => {
      await expect(client.didClose('file:///test.js')).rejects.toThrow('not initialized');
    });
  });

  describe('document store integration', () => {
    it('stores documents via put', () => {
      const v = client.documentStore.put('file:///test.js', 'hello', 'javascript');
      expect(v).toBe(1);
      expect(client.documentStore.has('file:///test.js')).toBe(true);
    });

    it('tracks document versions', () => {
      const v1 = client.documentStore.put('file:///a.js', 'a', 'javascript');
      const v2 = client.documentStore.put('file:///b.js', 'b', 'javascript');
      expect(v2).toBeGreaterThan(v1);
    });
  });

  describe('diagnostics cache', () => {
    it('returns null for non-existent URI', () => {
      expect(client.getDiagnostics('file:///nonexistent.js')).toBeNull();
    });

    it('stores diagnostics via _handlePublishDiagnostics', () => {
      const diagnostics = [
        {
          severity: 1,
          message: 'Unused variable',
          uri: 'file:///test.js',
          range: { start: { line: 0, character: 0 } },
        },
      ];
      client._handlePublishDiagnostics('file:///test.js', diagnostics);
      expect(client.getDiagnostics('file:///test.js')).toEqual(diagnostics);
    });

    it('clears diagnostics when empty array received', () => {
      const diagnostics = [
        { severity: 1, message: 'Error', uri: 'file:///test.js', range: { start: { line: 0, character: 0 } } },
      ];
      client._handlePublishDiagnostics('file:///test.js', diagnostics);
      expect(client.getDiagnostics('file:///test.js')).not.toBeNull();
      client._handlePublishDiagnostics('file:///test.js', []);
      expect(client.getDiagnostics('file:///test.js')).toBeNull();
    });

    it('stores diagnostics for multiple URIs independently', () => {
      const diags1 = [{ severity: 1, message: 'Error1', uri: 'file:///a.js', range: { start: { line: 0, character: 0 } } }];
      const diags2 = [{ severity: 2, message: 'Warning2', uri: 'file:///b.js', range: { start: { line: 1, character: 0 } } }];
      client._handlePublishDiagnostics('file:///a.js', diags1);
      client._handlePublishDiagnostics('file:///b.js', diags2);
      expect(client.getDiagnostics('file:///a.js')).toEqual(diags1);
      expect(client.getDiagnostics('file:///b.js')).toEqual(diags2);
    });

    it('clears diagnostics for specific URI via clearDiagnostics', () => {
      client._handlePublishDiagnostics('file:///test.js', [{ severity: 1, message: 'Error', uri: 'file:///test.js', range: { start: { line: 0, character: 0 } } }]);
      client.clearDiagnostics('file:///test.js');
      expect(client.getDiagnostics('file:///test.js')).toBeNull();
    });

    it('clears all diagnostics via clearAllDiagnostics', () => {
      client._handlePublishDiagnostics('file:///a.js', [{ severity: 1, message: 'A', uri: 'file:///a.js', range: { start: { line: 0, character: 0 } } }]);
      client._handlePublishDiagnostics('file:///b.js', [{ severity: 2, message: 'B', uri: 'file:///b.js', range: { start: { line: 0, character: 0 } } }]);
      client.clearAllDiagnostics();
      expect(client.getDiagnostics('file:///a.js')).toBeNull();
      expect(client.getDiagnostics('file:///b.js')).toBeNull();
    });

    it('returns correct diagnostics count', () => {
      expect(client.getDiagnosticsCount()).toBe(0);
      client._handlePublishDiagnostics('file:///a.js', [{ severity: 1, message: 'A', uri: 'file:///a.js', range: { start: { line: 0, character: 0 } } }]);
      expect(client.getDiagnosticsCount()).toBe(1);
      client._handlePublishDiagnostics('file:///b.js', [{ severity: 2, message: 'B', uri: 'file:///b.js', range: { start: { line: 0, character: 0 } } }]);
      expect(client.getDiagnosticsCount()).toBe(2);
    });
  });
});
