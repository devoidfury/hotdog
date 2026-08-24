import { formatError, isExpectedError, LlmError } from "../error.ts";
import { OUTPUT_EVENT, OutputEvent } from "../context/output.ts";
import { contentToText, type MessageSource } from "../context/message.ts";
import { HOOKS, isInputTransform, type InputHookResult } from "../hooks.ts";
import { parseCommand, ACTIONS, ParsedCommand, type CommandRegistryLike } from "../commands.ts";
import type { CommandResult } from "../extensions/registries.ts";

export interface MessageBusSessionManager {
  getAgent(): MessageBusAgent | undefined;
}

/** Minimal Agent interface for message bus usage. */
export interface MessageBusAgent {
  hooks: {
    runHookPipeline(
      hookName: string,
      data: unknown,
      opts?: { shouldStop?: (result: unknown) => boolean },
    ): Promise<unknown>;
  };
  run(
    content: string | Array<Record<string, unknown>>,
    images?: unknown,
    opts?: { source?: MessageSource },
  ): Promise<unknown>;
  resetCancel(): void;
  cancel(): void;
  commandRegistry?: CommandRegistryLike | null;
  executeCommand(cmd: ParsedCommand): Promise<CommandResult | null>;
}

/**
 * A queued bus message. `content` is plain text or content parts (so harness
 * messages can carry `untrusted` parts, mangled only at the wire); `source`
 * carries provenance to the agent.
 */
export interface BusQueueItem {
  content: string | Array<Record<string, unknown>>;
  source?: MessageSource;
}

export interface Sink {
  emit(event: OutputEvent): void;
}

export interface MessageBusOptions {
  sessionManager: MessageBusSessionManager;
  sink: Sink;
  /** Optional callback to broadcast events to all connected clients. */
  broadcastCallback?: (msg: Record<string, unknown>) => void;
}

// Owns the agent run loop; no polling -- enqueue() resolves a per-iteration deferred.
export class MessageBus {
  #sessionManager: MessageBusSessionManager;
  #sink: Sink;
  #queue: BusQueueItem[];
  #isRunning: boolean;
  #abortController: AbortController;
  #waiter: { resolve: () => void } | null;
  #broadcastCallback: ((msg: Record<string, unknown>) => void) | undefined;

  constructor({ sessionManager, sink, broadcastCallback }: MessageBusOptions) {
    this.#sessionManager = sessionManager;
    this.#sink = sink;
    this.#broadcastCallback = broadcastCallback;
    this.#queue = [];
    this.#isRunning = false;
    // cancel() aborts it; interrupt() does NOT -- the bus keeps waiting for input.
    this.#abortController = new AbortController();
    this.#waiter = null;
  }

  enqueue(content: string | Array<Record<string, unknown>>, opts?: { source?: MessageSource }): void {
    this.#queue.push({ content, source: opts?.source });
    this._wakeWaiter();
  }

  /** Ends the run loop; the bus is unusable afterwards unless reset(). */
  cancel(): void {
    this.#abortController.abort();
    const agent = this.#sessionManager.getAgent();
    if (agent) agent.cancel();
    this._wakeWaiter();
  }

  /** Cancels the active request and clears the queue, but keeps the run loop alive (Ctrl-C). */
  interrupt(): void {
    const agent = this.#sessionManager.getAgent();
    if (agent) agent.cancel();
    this.#queue = [];
    this._wakeWaiter();
  }

  /** Makes a cancelled bus usable again; the queue is preserved. */
  reset(): void {
    this.#abortController = new AbortController();
  }

  get isCancelled(): boolean {
    return this.#abortController.signal.aborted;
  }

  isIdle(): boolean {
    return (
      !this.#isRunning &&
      this.#queue.length === 0 &&
      !this.#abortController.signal.aborted
    );
  }

  get sessionManager(): MessageBusSessionManager {
    return this.#sessionManager;
  }

  get agent(): MessageBusAgent | undefined {
    return this.#sessionManager.getAgent();
  }

  /** @internal */
  get queue(): string[] {
    return this.#queue.map((item) => contentToText(item.content));
  }
  set queue(v: Array<string | BusQueueItem>) {
    this.#queue = v.map((item) => (typeof item === "string" ? { content: item } : item));
  }

  /** @internal */
  get isRunning(): boolean {
    return this.#isRunning;
  }
  set isRunning(v: boolean) {
    this.#isRunning = v;
  }

  /** @internal */
  get abortController(): AbortController {
    return this.#abortController;
  }

  /** @internal */
  get waiter(): { resolve: () => void } | null {
    return this.#waiter;
  }
  set waiter(v: { resolve: () => void } | null) {
    this.#waiter = v;
  }

  /** Blocks until cancelled. */
  async run(): Promise<void> {
    for await (const item of this._messages(false)) {
      await this._processMessage(item);
    }
  }

  /** Like run(), but drains the queue after cancellation before exiting. */
  async runUntilCancelled(): Promise<void> {
    for await (const item of this._messages(true)) {
      await this._processMessage(item);
    }
  }

  _wakeWaiter(): void {
    if (this.#waiter) {
      const resolve = this.#waiter.resolve;
      this.#waiter = null;
      resolve();
    }
  }

  /** Yields queued messages; drains remaining ones after cancellation when drain is set. */
  async *_messages(drain: boolean = false): AsyncGenerator<BusQueueItem> {
    const signal = this.#abortController.signal;
    while (true) {
      while (this.#queue.length > 0) {
        if (signal.aborted && !drain) break;
        yield this.#queue.shift()!;
      }

      if (signal.aborted) {
        if (!drain) break;
        // Drain mode: exit only once the queue is empty after cancellation.
        if (this.#queue.length === 0) break;
        continue;
      }

      const promise = new Promise<void>((resolve) => {
        this.#waiter = { resolve };
      });
      await promise;
      this.#waiter = null;
    }
  }

  /** Broadcasts to all clients, not just those attached to this session. */
  #emitSessionState(key: string, value: unknown, sessionId?: string): void {
    const event: OutputEvent = {
      type: OUTPUT_EVENT.SESSION_STATE,
      key,
      value,
      sessionId,
    };
    this.#sink.emit(event);

    if (this.#broadcastCallback) {
      this.#broadcastCallback({
        type: "sessionState",
        key,
        value,
        sessionId,
      });
    }
  }

  /** Runs the input hook pipeline, then hands off to the agent. */
  async _processMessage(item: string | BusQueueItem): Promise<void> {
    // Accept a bare string (tests / simple callers) or a full queue item.
    const source: MessageSource | undefined = typeof item === "string" ? undefined : item.source;
    let content: string | Array<Record<string, unknown>> =
      typeof item === "string" ? item : item.content;
    this.#isRunning = true;
    const agent = this.#sessionManager.getAgent();
    if (!agent) {
      this.#isRunning = false;
      this.#emitSessionState("working", false);
      return;
    }

    // sessionId lets the frontend track per-session working state.
    const agentSid = (agent as { sessionId?: string }).sessionId;
    this.#emitSessionState("working", true, agentSid);

    // Reset before processing so a leftover cancel from an interrupt can't swallow this run.
    agent.resetCancel();

    // Hooks see flattened text; the structured content (with its trust
    // parts) is what reaches the agent.
    const inputData = { text: contentToText(content), source: "interactive", origin: source, agent };
    let inputHandled = false;
    if (agent?.hooks) {
      const inputResult = await agent.hooks.runHookPipeline(
        HOOKS.INPUT,
        inputData,
        { shouldStop: (result: unknown) => (result as { action?: string })?.action === "handled" },
      );
      if ((inputResult as { stopped?: boolean }).stopped) inputHandled = true;
      const lastResult = (inputResult as { lastResult?: unknown }).lastResult;
      const transformed = lastResult as InputHookResult | undefined;
      if (isInputTransform(transformed)) {
        // A transform flattens the content. If the item carried structured
        // (harness) content, the result must not inherit the harness
        // exemption: wrap it as an untrusted part so the wire mangles it.
        content = Array.isArray(content)
          ? [{ type: "untrusted", text: transformed.text }]
          : transformed.text;
      }
    }

    if (inputHandled) {
      this.#isRunning = false;
      this.#emitSessionState("working", false, agentSid);
      return;
    }

    try {
      await agent.run(content, undefined, source ? { source } : undefined);
    } catch (e: unknown) {
      // Suppress cancellation errors on interrupt — the UI already
      // prints an "Interrupted" message, so the full error is noise.
      const isCancellation =
        (e instanceof LlmError && e.type === "cancelled") ||
        (e instanceof Error && e.name === "AbortError") ||
        LlmError.isCancelled(e);

      if (!isCancellation) {
        this.#sink.emit({
          type: OUTPUT_EVENT.COMMAND_RESULT,
          content: isExpectedError(e) ? (e as Error).message : formatError(e),
        });
      }
    }

    this.#isRunning = false;
    this.#emitSessionState("working", false, agentSid);
  }

  async executeCommand(cmdText: string): Promise<number | undefined> {
    const agent = this.#sessionManager.getAgent();
    const cmd = parseCommand(cmdText, agent?.commandRegistry);

    if (!agent) {
      this.#sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: "No agent available.",
      });
      return;
    }

    const result = await agent.executeCommand(cmd);

    if (!result) {
      return;
    }

    // Bitflags: multiple actions can fire simultaneously.
    // PROMPT enqueues the content as a user message so the normal run loop sends it to the LLM.
    if (result.action && (result.action & ACTIONS.PROMPT) && result.content) {
      this.enqueue(result.content);
    }

    if (result.action && (result.action & ACTIONS.ERROR) && result.error) {
      this.#sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: result.error,
      });
    }

    if (result.action && (result.action & ACTIONS.DISPLAY) && result.content) {
      this.#sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: result.content,
      });
    }

    // Backward compat: action absent means error/content are the payload.
    // Only triggers when action is null/undefined, not 0 (a valid "no action" bitflag).
    if (result.action == null && result.error) {
      this.#sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: result.error,
      });
    }
    if (result.action == null && result.content) {
      this.#sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: result.content,
      });
    }

    return result.action;
  }
}
