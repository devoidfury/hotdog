// Document store — in-memory document state management for LSP.

export class DocumentStore {
  constructor() {
    /** @type {Map<string, { content: string, languageId: string, version: number }>} */
    this.documents = new Map();
    this.versionCounter = 0;
  }

  /**
   * Register a document with its content.
   * @param {string} uri - Document URI
   * @param {string} content - Document content
   * @param {string} languageId - Language identifier
   * @returns {number} The document version
   */
  put(uri, content, languageId) {
    this.versionCounter++;
    this.documents.set(uri, {
      content,
      languageId,
      version: this.versionCounter,
    });
    return this.versionCounter;
  }

  /**
   * Get document by URI.
   * @param {string} uri - Document URI
   * @returns {{ content: string, languageId: string, version: number } | undefined}
   */
  get(uri) {
    return this.documents.get(uri);
  }

  /**
   * Remove a document.
   * @param {string} uri - Document URI
   */
  delete(uri) {
    this.documents.delete(uri);
  }

  /**
   * Check if a document is registered.
   * @param {string} uri - Document URI
   * @returns {boolean}
   */
  has(uri) {
    return this.documents.has(uri);
  }

  /**
   * Update document content.
   * @param {string} uri - Document URI
   * @param {string} newContent - New content
   * @returns {number} The new version, or undefined if document doesn't exist
   */
  updateContent(uri, newContent) {
    const doc = this.documents.get(uri);
    if (doc) {
      this.versionCounter++;
      doc.content = newContent;
      doc.version = this.versionCounter;
      return this.versionCounter;
    }
    return undefined;
  }

  /**
   * Get all registered URIs.
   * @returns {string[]}
   */
  keys() {
    return Array.from(this.documents.keys());
  }

  /**
   * Get all documents as entries.
   * @returns {[string, { content: string, languageId: string, version: number }][]}
   */
  getAll() {
    return Array.from(this.documents.entries());
  }

  /**
   * Get the number of registered documents.
   * @returns {number}
   */
  size() {
    return this.documents.size;
  }

  /**
   * Clear all documents.
   */
  clear() {
    this.documents.clear();
    this.versionCounter = 0;
  }

  /**
   * Update a document's language ID without changing content.
   * @param {string} uri - Document URI
   * @param {string} languageId - New language ID
   */
  updateLanguageId(uri, languageId) {
    const doc = this.documents.get(uri);
    if (doc) {
      doc.languageId = languageId;
    }
  }
}
