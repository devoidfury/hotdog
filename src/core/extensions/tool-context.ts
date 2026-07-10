// ToolContext — shared context container for tool execution.

/**
 * Shared context container backed by a Map.
 */
export class ToolContext {
  #data: Map<string, unknown>;

  /**
   * @param initialData - Optional initial data.
   */
  constructor(initialData: Record<string, unknown> = {}) {
    this.#data = new Map(Object.entries(initialData));
  }

  /**
   * Mount (set) a property on the shared context.
   */
  set(key: string, value: unknown): this {
    this.#data.set(key, value);
    return this;
  }

  /**
   * Get a property from the shared context.
   */
  get(key: string): unknown {
    return this.#data.get(key);
  }

  /**
   * Check if a property exists on the shared context.
   */
  has(key: string): boolean {
    return this.#data.has(key);
  }

  /**
   * Delete a property from the shared context.
   */
  delete(key: string): boolean {
    return this.#data.delete(key);
  }

  /**
   * Get all mounted keys.
   */
  keys(): string[] {
    return Array.from(this.#data.keys());
  }

  /**
   * Get a snapshot of all mounted data as a plain object.
   */
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.#data);
  }

  /**
   * Mount multiple properties at once.
   */
  mount(data: Record<string, unknown>): this {
    for (const [key, value] of Object.entries(data)) {
      this.#data.set(key, value);
    }
    return this;
  }
}
