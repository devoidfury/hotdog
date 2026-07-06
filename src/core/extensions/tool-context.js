// ToolContext — shared context container for tool execution.

/**
 * Shared context container backed by a Map.
 * Accepts optional initial data in the constructor for backward
 * compatibility (tests and direct instantiation).
 */
export class ToolContext {
  /**
   * @param {Object} [initialData] - Optional initial data.
   */
  constructor(initialData = {}) {
    this._data = new Map(Object.entries(initialData));
  }

  /**
   * Mount (set) a property on the shared context.
   * @param {string} key - Property key.
   * @param {*} value - Property value.
   * @returns {ToolContext} This context for chaining.
   */
  set(key, value) {
    this._data.set(key, value);
    return this;
  }

  /**
   * Get a property from the shared context.
   * @param {string} key - Property key.
   * @returns {*} Property value or undefined.
   */
  get(key) {
    return this._data.get(key);
  }

  /**
   * Check if a property exists on the shared context.
   * @param {string} key - Property key.
   * @returns {boolean} True if property exists.
   */
  has(key) {
    return this._data.has(key);
  }

  /**
   * Delete a property from the shared context.
   * @param {string} key - Property key.
   * @returns {boolean} True if property was deleted.
   */
  delete(key) {
    return this._data.delete(key);
  }

  /**
   * Get all mounted keys.
   * @returns {string[]} Array of keys.
   */
  keys() {
    return Array.from(this._data.keys());
  }

  /**
   * Get a snapshot of all mounted data as a plain object.
   * @returns {Object} Plain object with all mounted data.
   */
  toJSON() {
    return Object.fromEntries(this._data);
  }

  /**
   * Mount multiple properties at once.
   * @param {Object} data - Object with key-value pairs.
   * @returns {ToolContext} This context for chaining.
   */
  mount(data) {
    for (const [key, value] of Object.entries(data)) {
      this._data.set(key, value);
    }
    return this;
  }
}
