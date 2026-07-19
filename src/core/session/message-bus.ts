// Message Bus — owns the agent run loop.
// Uses an async generator to yield messages, eliminating the manual
// deferred lifecycle management. Event-driven: enqueue() wakes the
// generator instead of polling.

import { formatError, isExpectedError, LlmError } from "../error.ts";
import { OUTPUT_EVENT, OutputEvent } from "../context/output.ts";
import { HOOKS } from "../hooks.ts";
import { parseCommand, ACTIONS, ParsedCommand, type CommandRegistryLike } from "../commands.ts";

/** Minimal SessionManager interface for message bus usage. */
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
  run(text: string): Promise<unknown>;
  resetCancel(): void;
  cancel(): void;
  commandRegistry: CommandRegistryLike | undefined;
  executeCommand(cmd: ParsedCommand): Promise<unknown>;
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

/**
 * An event-driven message bus that owns the agent run loop.
 * Uses SessionManager for agent access.
 * No polling — enqueue() resolves a per-iteration deferred.
 *
 * Cancellation uses an AbortController instead of a boolean flag.
 * cancel() aborts the controller, signaling the generator to exit.
 * interrupt() does NOT abort the controller — the bus continues
 * waiting for new input. This eliminates the race condition where
 * the agent's _cancelled flag was cleared in the finally block of
 * _processMessage, allowing a cancelled request to be retried.
 */
export class MessageBus {
  #sessionManager: MessageBusSessionManager;
  #sink: Sink;
  #queue: string[];
  #isRunning: boolean;
  #abortController: AbortController;
  #waiter: { resolve: () => void } | null;
  #broadcastCallback: ((msg: Record<string, unknown>) => void) | undefined;

  /**
   * @param options
   * @param options.sessionManager
   * @param options.sink
   * @param options.broadcastCallback - Optional callback to broadcast events to all clients
   */
  constructor({ sessionManager, sink, broadcastCallback }: MessageBusOptions) {
    this.#sessionManager = sessionManager;
    this.#sink = sink;
    this.#broadcastCallback = broadcastCallback;
    this.#queue = [];
    this.#isRunning = false;
    // AbortController for the run loop. cancel() aborts it, signaling
    // the generator to exit. interrupt() does NOT abort it.
    this.#abortController = new AbortController();
    // Single waiter slot: { resolve } or null. Created per generator
    // iteration, cleared synchronously after await.
    this.#waiter = null;
  }

  /**
   * Enqueue a message for processing.
   * If the generator is waiting, this wakes it immediately.
   */
  enqueue(text: string): void {
    this.#queue.push(text);
    this._wakeWaiter();
  }

  /**
   * Cancel the run loop. Aborts the controller so the generator exits,
   * and cancels the agent's active request. The bus cannot process
   * further messages after cancel() — create a new bus or call reset().
   */
  cancel(): void {
    this.#abortController.abort();
    const agent = this.#sessionManager.getAgent();
    if (agent) agent.cancel();
    this._wakeWaiter();
  }

  /**
   * Interrupt the current agent processing and clear the queue.
   * Unlike cancel(), this does NOT end the run loop — the bus
   * continues waiting for new input after the interruption.
   * Used by Ctrl-C in interactive mode.
   */
  interrupt(): void {
    const agent = this.#sessionManager.getAgent();
    if (agent) agent.cancel();
    this.#queue = [];
    this._wakeWaiter();
  }

  /**
   * Reset the bus after cancellation. Creates a fresh AbortController
   * so the bus can be used again. The queue is preserved.
   */
  reset(): void {
    this.#abortController = new AbortController();
  }

  /**
   * Check if the bus has been cancelled.
   * @returns Whether the bus has been cancelled.
   */
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

  // ── Test-only accessors ─────────────────────────────────────────────────

  /** @internal Exposed for testing. */
  get queue(): string[] {
    return this.#queue;
  }
  set queue(v: string[]) {
    this.#queue = v;
  }

  /** @internal Exposed for testing. */
  get isRunning(): boolean {
    return this.#isRunning;
  }
  set isRunning(v: boolean) {
    this.#isRunning = v;
  }

  /** @internal Exposed for testing. */
  get abortController(): AbortController {
    return this.#abortController;
  }

  /** @internal Exposed for testing. */
  get waiter(): { resolve: () => void } | null {
    return this.#waiter;
  }
  set waiter(v: { resolve: () => void } | null) {
    this.#waiter = v;
  }

  /**
   * Run the dispatch loop. Drains messages sequentially.
   * Blocks indefinitely until cancelled.
   */
  async run(): Promise<void> {
    for await (const text of this._messages(false)) {
      await this._processMessage(text);
    }
  }

  /**
   * Run the dispatch loop, draining remaining messages after cancellation.
   * Exits once cancelled and the queue is empty.
   */
  async runUntilCancelled(): Promise<void> {
    for await (const text of this._messages(true)) {
      await this._processMessage(text);
    }
  }

  /**
   * Wake a pending waiter, if any. Idempotent — safe to call
   * even if no waiter is waiting.
   */
  _wakeWaiter(): void {
    if (this.#waiter) {
      const resolve = this.#waiter.resolve;
      this.#waiter = null;
      resolve();
    }
  }

  /**
   * Async generator that yields messages until cancellation.
   *
   * Each iteration:
   *   1. Drains all currently queued messages synchronously
   *   2. If cancelled (and not drain mode), exits
   *   3. Otherwise, waits for the next enqueue or cancel event
   *
   * In drain mode (runUntilCancelled), cancellation is also checked
   * after draining so any messages queued after cancellation are
   * still processed before exit.
   *
   * Uses the AbortController signal for cancellation instead of a
   * boolean flag. The waiter promise is scoped to this iteration —
   * _wakeWaiter nulls #waiter synchronously after await.
   *
   * @param drain — If true, process remaining queued
   *   messages after cancellation before exiting.
   */
  async *_messages(drain: boolean = false): AsyncGenerator<string> {
    const signal = this.#abortController.signal;
    while (true) {
      // Drain all currently queued messages synchronously
      while (this.#queue.length > 0) {
        if (signal.aborted && !drain) break;
        yield this.#queue.shift()!;
      }

      // Check exit conditions after draining
      if (signal.aborted) {
        if (!drain) break;
        // Drain mode: if queue is empty after cancellation, exit.
        // Otherwise loop back to drain remaining items.
        if (this.#queue.length === 0) break;
        continue;
      }

      // Wait for the next message or cancellation.
      // The promise is scoped to this iteration — _wakeWaiter nulls
      // #waiter synchronously after await, so there's no lifecycle leak.
      const promise = new Promise<void>((resolve) => {
        this.#waiter = { resolve };
      });
      await promise;
      this.#waiter = null;
    }
  }

  /**
   * Emit a SESSION_STATE event and broadcast it to all clients.
   * This ensures all connected clients receive working state changes,
   * not just clients attached to this session.
   */
  #emitSessionState(key: string, value: unknown, sessionId?: string): void {
    const event: OutputEvent = {
      type: OUTPUT_EVENT.SESSION_STATE,
      key,
      value,
      sessionId,
    };
    this.#sink.emit(event);

    // Broadcast to all connected clients so sidebars update everywhere
    if (this.#broadcastCallback) {
      this.#broadcastCallback({
        type: "sessionState",
        key,
        value,
        sessionId,
      });
    }
  }

  /**
   * Process a single message: run the input hook pipeline,
   * then hand off to the agent.
   *
   * Resets the agent's cancel flag at the start (before processing)
   * instead of at the end. This eliminates the race condition where
   * the flag was cleared in the finally block, potentially allowing
   * a user-initiated cancel to be silently swallowed between:
   *   1. agent.run() throws Cancelled
   *   2. finally block calls agent.cancel(false)
   *   3. user hits Ctrl+C again
   *   4. agent.cancel(false) from step 2 wins, flag is false
   *
   * The flag is now only reset when a new message is about to be
   * processed, which is the correct point: the agent is ready for
   * new work.
   */
  async _processMessage(text: string): Promise<void> {
    this.#isRunning = true;
    const agent = this.#sessionManager.getAgent();
    if (!agent) {
      this.#isRunning = false;
      this.#emitSessionState("working", false);
      return;
    }

    // Signal that the agent is now working.
    // Include sessionId so the frontend can track per-session working state.
    const agentSid = (agent as { sessionId?: string }).sessionId;
    this.#emitSessionState("working", true, agentSid);

    // Reset the agent's cancel flag before processing.
    // This clears any leftover cancelled state from the previous
    // message (e.g., interrupt) so the agent is ready for new work.
    agent.resetCancel();

    // Input hook — sequential, handlers can transform or short-circuit.
    // Actions: { action: "continue" } | { action: "transform", text } | { action: "handled" }
    const inputData = { text, source: "interactive", agent };
    let inputHandled = false;
    if (agent?.hooks) {
      const inputResult = await agent.hooks.runHookPipeline(
        HOOKS.INPUT,
        inputData,
        { shouldStop: (result: unknown) => (result as { action?: string })?.action === "handled" },
      );
      if ((inputResult as { stopped?: boolean }).stopped) inputHandled = true;
      text = (inputResult as { data?: { text: string } }).data?.text ?? text;
    }

    // If input was handled by a hook, skip agent processing
    if (inputHandled) {
      this.#isRunning = false;
      this.#emitSessionState("working", false, agentSid);
      return;
    }

    try {
      await agent.run(text);
    } catch (e: unknown) {
      // Suppress cancellation errors on interrupt — the UI already
      // prints an "Interrupted" message, so the full error is noise.
      const isCancellation =
        (e instanceof LlmError && e.type === "cancelled") ||
        (e as Error).name === "AbortError" ||
        LlmError.isCancelled(e);

      if (!isCancellation) {
        this.#sink.emit({
          type: OUTPUT_EVENT.COMMAND_RESULT,
          content: isExpectedError(e) ? (e as Error).message : formatError(e),
        });
      }
    }

    this.#isRunning = false;

    // Signal that the agent is done working so the UI can hide the spinner
    // Include sessionId so the frontend can track per-session working state.
    this.#emitSessionState("working", false, agentSid);
  }

  /**
   * Execute a command through the agent.
   */
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
    const r = result as { action?: number; content?: string; error?: string } | undefined;

    if (r) {
      // Bitflags: multiple actions can fire simultaneously.
      // PROMPT — enqueue the rendered content as a user message so the
      // agent's normal run loop processes it and sends it to the LLM.
      if (r.action && (r.action & ACTIONS.PROMPT) && r.content) {
        this.enqueue(r.content);
      }

      // ERROR — display the error message to the user.
      if (r.action && (r.action & ACTIONS.ERROR) && r.error) {
        this.#sink.emit({
          type: OUTPUT_EVENT.COMMAND_RESULT,
          content: r.error,
        });
      }

      // DISPLAY — show the result content as a command response.
      if (r.action && (r.action & ACTIONS.DISPLAY) && r.content) {
        this.#sink.emit({
          type: OUTPUT_EVENT.COMMAND_RESULT,
          content: r.content,
        });
      }

      // Backward compat — handler returned error/content without action field.
      // These only trigger when action is absent (null/undefined), not when
      // it's explicitly set to 0 (which is a valid "no action" bitflag).
      if (r.action == null && r.error) {
        this.#sink.emit({
          type: OUTPUT_EVENT.COMMAND_RESULT,
          content: r.error,
        });
      }
      if (r.action == null && r.content) {
        this.#sink.emit({
          type: OUTPUT_EVENT.COMMAND_RESULT,
          content: r.content,
        });
      }
    }
    return r?.action;
  }
}
