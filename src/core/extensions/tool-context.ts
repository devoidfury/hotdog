import { Workspace } from "@utils/workspace.ts";

/**
 * Default tool context keys and their types.
 * Extensions can extend this interface for their own keys.
 */
export interface DefaultToolContext extends Record<string, unknown> {
  agent: unknown; // Agent — avoid circular import
  /**
   * Env a spawned child must carry because a network policy demands it
   * (today: the fetch-policy proxy vars). Set by the host on both planes --
   * inline from the spawn-env provider, worker-plane from the invoke frame --
   * and merged by spawning tools LAST, over their config env: a child must
   * not be able to buy its way out of the policy. Tools that spawn nothing
   * ignore it.
   */
  spawnEnv?: Record<string, string>;
  isSessionRestoring: boolean;
  /** Multi-root workspace boundary; relative paths resolve against roots[0]. */
  workspace: Workspace;
  taskManager?: unknown;
  sessionCore?: unknown;
  /**
   * Run-scoped cancellation, set by the ToolExecutor (inline) and by the
   * pooled runner (worker plane). Optional: tools behave as before when no
   * host offered one (standalone callers). Long-running tools should abort
   * their work when it fires.
   */
  abortSignal?: AbortSignal;
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

  constructor(initialData: Record<string, unknown> = {}) {
    this.#data = new Map(Object.entries(initialData) as [keyof T, T[keyof T]][]);
  }

  set<K extends keyof T>(key: K, value: T[K]): this {
    this.#data.set(key, value);
    return this;
  }

  get<K extends keyof T>(key: K): T[K] | undefined {
    return this.#data.get(key) as T[K] | undefined;
  }

  has(key: string): boolean {
    return this.#data.has(key as keyof T);
  }

  delete(key: string): boolean {
    return this.#data.delete(key as keyof T);
  }

  keys(): (keyof T & string)[] {
    return Array.from(this.#data.keys()) as (keyof T & string)[];
  }

  toJSON(): Partial<Record<keyof T, unknown>> {
    return Object.fromEntries(this.#data) as Partial<Record<keyof T, unknown>>;
  }

  mount(data: Record<string, unknown>): this {
    for (const [key, value] of Object.entries(data) as [keyof T, T[keyof T]][]) {
      this.#data.set(key, value);
    }
    return this;
  }
}
