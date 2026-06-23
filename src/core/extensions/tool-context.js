// ToolContext — shared context container for tool execution.

/**
 * Shared context container backed by a Map.
 * Accepts optional initial data in the constructor for backward
 * compatibility (tests and direct instantiation).
 */
export class ToolContext {
  constructor(initialData = {}) {
    this._data = new Map(Object.entries(initialData));
  }

  /**
   * Mount (set) a property on the shared context.
   */
  set(key, value) {
    this._data.set(key, value);
    return this;
  }

  /**
   * Get a property from the shared context.
   */
  get(key) {
    return this._data.get(key);
  }

  /**
   * Check if a property exists on the shared context.
   */
  has(key) {
    return this._data.has(key);
  }

  /**
   * Delete a property from the shared context.
   */
  delete(key) {
    this._data.delete(key);
  }

  /**
   * Get all mounted keys.
   */
  keys() {
    return Array.from(this._data.keys());
  }

  /**
   * Get a snapshot of all mounted data as a plain object.
   */
  toJSON() {
    return Object.fromEntries(this._data);
  }

  /**
   * Mount multiple properties at once.
   */
  mount(data) {
    for (const [key, value] of Object.entries(data)) {
      this._data.set(key, value);
    }
    return this;
  }
}
