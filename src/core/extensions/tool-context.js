// ToolContext — shared context container for tool execution.
// A flat object that extensions mount their own properties onto.
// Core knows nothing about property names; each extension owns its own keys.

/**
 * Shared context container.
 * Accepts optional initial data in the constructor for backward
 * compatibility (tests and direct instantiation).
 */
export class ToolContext {
  constructor(initialData = {}) {
    Object.defineProperty(this, "_data", {
      value: { ...initialData },
      writable: false,
      enumerable: false,
    });
  }

  /**
   * Mount (set) a property on the shared context.
   */
  set(key, value) {
    this._data[key] = value;
    return this;
  }

  /**
   * Get a property from the shared context.
   */
  get(key) {
    return this._data[key];
  }

  /**
   * Check if a property exists on the shared context.
   */
  has(key) {
    return key in this._data;
  }

  /**
   * Delete a property from the shared context.
   */
  delete(key) {
    delete this._data[key];
  }

  /**
   * Get all mounted keys.
   */
  keys() {
    return Object.keys(this._data);
  }

  /**
   * Get a snapshot of all mounted data.
   */
  toJSON() {
    return { ...this._data };
  }

  /**
   * Mount multiple properties at once.
   */
  mount(data) {
    for (const [key, value] of Object.entries(data)) {
      this._data[key] = value;
    }
    return this;
  }
}
