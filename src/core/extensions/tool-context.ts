// ToolContext — shared context container for tool execution.

import { Workspace } from "../../utils/workspace.ts";

/**
 * Default tool context keys and their types.
 * Extensions can extend this interface for their own keys.
 */
export interface DefaultToolContext extends Record<string, unknown> {
  agent: unknown; // Agent — avoid circular import
  isSessionRestoring: boolean;
  cwdBoundary: string | null;
  workspaceRoot: string | null;
  workspace: Workspace | null;
  taskManager?: unknown;
  sessionCore?: unknown;
}

/**
 * Shared context container backed by a Map.
 *
 * Typed via a generic parameter. Example:
 *
 *   interface MyContext extends DefaultToolContext {
 *     myService: MyService;
 *   }
 *
 *   const ctx = new ToolContext<MyContext>();
 *   ctx.set("myService", serviceInstance);
 *   const svc = ctx.get("myService"); // typed as MyService
 */
export class ToolContext<T extends Record<string, unknown> = DefaultToolContext> {
  #data: Map<keyof T, T[keyof T]>;

  /**
   * @param initialData - Optional initial data.
   */
  constructor(initialData: Record<string, unknown> = {}) {
    this.#data = new Map(Object.entries(initialData) as [keyof T, T[keyof T]][]);
  }

  /**
   * Mount (set) a property on the shared context.
   */
  set<K extends keyof T>(key: K, value: T[K]): this {
    this.#data.set(key, value);
    return this;
  }

  /**
   * Get a property from the shared context.
   */
  get<K extends keyof T>(key: K): T[K] | undefined {
    return this.#data.get(key) as T[K] | undefined;
  }

  /**
   * Check if a property exists on the shared context.
   */
  has(key: string): boolean {
    return this.#data.has(key as keyof T);
  }

  /**
   * Delete a property from the shared context.
   */
  delete(key: string): boolean {
    return this.#data.delete(key as keyof T);
  }

  /**
   * Get all mounted keys.
   */
  keys(): (keyof T & string)[] {
    return Array.from(this.#data.keys()) as (keyof T & string)[];
  }

  /**
   * Get a snapshot of all mounted data as a plain object.
   */
  toJSON(): Partial<Record<keyof T, unknown>> {
    return Object.fromEntries(this.#data) as Partial<Record<keyof T, unknown>>;
  }

  /**
   * Mount multiple properties at once.
   */
  mount(data: Record<string, unknown>): this {
    for (const [key, value] of Object.entries(data) as [keyof T, T[keyof T]][]) {
      this.#data.set(key, value);
    }
    return this;
  }
}
