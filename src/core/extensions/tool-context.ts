import { Workspace } from "@utils/workspace.ts";

/** A nested call's arguments: the wire JSON string, a parsed object, or null. */
export type NestedCallInput = string | Record<string, unknown> | null;

export interface NestedCallOptions {
  /** Attribution id ("<parentCallId>/<n>") carried on hook payloads and output events. */
  parentToolCallId?: string;
  /** Extra per-call cancellation; the run-scoped signal on the context still applies. */
  signal?: AbortSignal;
}

export interface NestedCallResult {
  ok: boolean;            // false for blocked/denied/failed/unavailable calls; never throws
  output: string;
  hint?: string;
  error?: string;
  meta?: Array<[string, string]>;
}

/**
 * Runs exactly one tool call through the full executor pipeline (availability,
 * TOOL_BEFORE_EXECUTE, context mounts, the fail-closed TOOL_CALL gate,
 * validation, execution including the worker-plane fork, TOOL_AFTER_EXECUTE /
 * TOOL_RESULT, the result cap, TOOL_METRICS) and returns the finalized result
 * to the caller instead of appending it to the conversation.
 */
export type ExecuteToolCall = (
  name: string,
  input: NestedCallInput,
  opts?: NestedCallOptions,
) => Promise<NestedCallResult>;

/**
 * Default tool context keys and their types.
 * Extensions can extend this interface for their own keys.
 */
export interface DefaultToolContext extends Record<string, unknown> {
  agent: unknown; // Agent — avoid circular import
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
  /**
   * Nested-call dispatcher, mounted by ToolExecutor on every call context:
   * dispatch one further call as if the model had made it, under this call's
   * attribution. Hand-built contexts (test doubles) may leave it unmounted;
   * `ctx.get()` answers undefined there.
   */
  executeToolCall: ExecuteToolCall;
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
