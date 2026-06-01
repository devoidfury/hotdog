import { describe, it, expect, beforeEach } from 'bun:test';
import { DocumentStore } from '../../ext/lsp/document-store.js';

describe('DocumentStore', () => {
  let store;

  beforeEach(() => {
    store = new DocumentStore();
  });

  describe('put', () => {
    it('stores a document', () => {
      store.put('file:///test.js', 'console.log(1);', 'javascript');
      expect(store.has('file:///test.js')).toBe(true);
    });

    it('assigns a version number', () => {
      const v1 = store.put('file:///a.js', 'a', 'javascript');
      const v2 = store.put('file:///b.js', 'b', 'javascript');
      expect(v1).toBe(1);
      expect(v2).toBe(2);
    });

    it('stores language ID', () => {
      store.put('file:///test.py', 'print(1)', 'python');
      const doc = store.get('file:///test.py');
      expect(doc.languageId).toBe('python');
    });
  });

  describe('get', () => {
    it('returns stored document', () => {
      store.put('file:///test.js', 'hello', 'javascript');
      const doc = store.get('file:///test.js');
      expect(doc.content).toBe('hello');
      expect(doc.languageId).toBe('javascript');
    });

    it('returns undefined for non-existent document', () => {
      expect(store.get('file:///missing.js')).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('removes a document', () => {
      store.put('file:///test.js', 'hello', 'javascript');
      store.delete('file:///test.js');
      expect(store.has('file:///test.js')).toBe(false);
    });

    it('handles deleting non-existent document', () => {
      expect(() => store.delete('file:///missing.js')).not.toThrow();
    });
  });

  describe('has', () => {
    it('returns true for stored documents', () => {
      store.put('file:///test.js', 'hello', 'javascript');
      expect(store.has('file:///test.js')).toBe(true);
    });

    it('returns false for non-existent documents', () => {
      expect(store.has('file:///missing.js')).toBe(false);
    });
  });

  describe('updateContent', () => {
    it('updates document content', () => {
      store.put('file:///test.js', 'hello', 'javascript');
      store.updateContent('file:///test.js', 'world');
      const doc = store.get('file:///test.js');
      expect(doc.content).toBe('world');
    });

    it('increments version on update', () => {
      const v1 = store.put('file:///test.js', 'a', 'javascript');
      const v2 = store.updateContent('file:///test.js', 'b');
      expect(v2).toBeGreaterThan(v1);
    });

    it('returns undefined for non-existent document', () => {
      expect(store.updateContent('file:///missing.js', 'x')).toBeUndefined();
    });
  });

  describe('keys', () => {
    it('returns all URIs', () => {
      store.put('file:///a.js', 'a', 'javascript');
      store.put('file:///b.ts', 'b', 'typescript');
      const keys = store.keys();
      expect(keys).toContain('file:///a.js');
      expect(keys).toContain('file:///b.ts');
      expect(keys.length).toBe(2);
    });

    it('returns empty array when no documents', () => {
      expect(store.keys().length).toBe(0);
    });
  });

  describe('getAll', () => {
    it('returns all document entries', () => {
      store.put('file:///test.js', 'hello', 'javascript');
      const entries = store.getAll();
      expect(entries.length).toBe(1);
      expect(entries[0][0]).toBe('file:///test.js');
      expect(entries[0][1].content).toBe('hello');
    });
  });

  describe('size', () => {
    it('returns correct count', () => {
      expect(store.size()).toBe(0);
      store.put('file:///a.js', 'a', 'javascript');
      expect(store.size()).toBe(1);
      store.put('file:///b.ts', 'b', 'typescript');
      expect(store.size()).toBe(2);
    });
  });

  describe('clear', () => {
    it('removes all documents', () => {
      store.put('file:///a.js', 'a', 'javascript');
      store.put('file:///b.ts', 'b', 'typescript');
      store.clear();
      expect(store.size()).toBe(0);
      expect(store.keys().length).toBe(0);
    });
  });

  describe('updateLanguageId', () => {
    it('changes language ID without changing content', () => {
      store.put('file:///test.js', 'hello', 'javascript');
      store.updateLanguageId('file:///test.js', 'typescript');
      const doc = store.get('file:///test.js');
      expect(doc.languageId).toBe('typescript');
      expect(doc.content).toBe('hello');
    });
  });
});
