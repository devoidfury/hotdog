// Message Bus — owns the agent run loop.
// Uses an async generator to yield messages, eliminating the manual
// deferred lifecycle management. Event-driven: enqueue() wakes the
// generator instead of polling.

import { formatError, isExpectedError, LlmError } from "../error.js";
import { OUTPUT_EVENT } from "../context/output.js";
import { HOOKS } from "../hooks.js";
import { parseCommand } from "../commands.js";

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
  /**
   * @param {Object} options
   * @param {import("./index.js").SessionManager} options.sessionManager
   * @param {import("../context/output.js").OutputSink} options.sink
   */
  constructor({ sessionManager, sink }) {
    this._sessionManager = sessionManager;
    this._sink = sink;
    this._queue = [];
    this._isRunning = false;
    // AbortController for the run loop. cancel() aborts it, signaling
    // the generator to exit. interrupt() does NOT abort it.
    this._abortController = new AbortController();
    // Single waiter slot: { resolve } or null. Created per generator
    // iteration, cleared synchronously after await.
    this._waiter = null;
  }

  /**
   * Enqueue a message for processing.
   * If the generator is waiting, this wakes it immediately.
   */
  enqueue(text) {
    this._queue.push(text);
    this._wakeWaiter();
  }

  /**
   * Cancel the run loop. Aborts the controller so the generator exits,
   * and cancels the agent's active request. The bus cannot process
   * further messages after cancel() — create a new bus or call reset().
   */
  cancel() {
    this._abortController.abort();
    const agent = this._sessionManager.getAgent();
    if (agent) agent.cancel();
    this._wakeWaiter();
  }

  /**
   * Interrupt the current agent processing and clear the queue.
   * Unlike cancel(), this does NOT end the run loop — the bus
   * continues waiting for new input after the interruption.
   * Used by Ctrl-C in interactive mode.
   */
  interrupt() {
    const agent = this._sessionManager.getAgent();
    if (agent) agent.cancel();
    this._queue = [];
    this._wakeWaiter();
  }

  /**
   * Reset the bus after cancellation. Creates a fresh AbortController
   * so the bus can be used again. The queue is preserved.
   */
  reset() {
    this._abortController = new AbortController();
  }

  /**
   * Check if the bus has been cancelled.
   * @returns {boolean}
   */
  get isCancelled() {
    return this._abortController.signal.aborted;
  }

  isIdle() {
    return !this._isRunning && this._queue.length === 0 && !this._abortController.signal.aborted;
  }

  get sessionManager() {
    return this._sessionManager;
  }

  get agent() {
    return this._sessionManager.getAgent();
  }

  /**
   * Run the dispatch loop. Drains messages sequentially.
   * Blocks indefinitely until cancelled.
   */
  async run() {
    for await (const text of this._messages(false)) {
      await this._processMessage(text);
    }
  }

  /**
   * Run the dispatch loop, draining remaining messages after cancellation.
   * Exits once cancelled and the queue is empty.
   */
  async runUntilCancelled() {
    for await (const text of this._messages(true)) {
      await this._processMessage(text);
    }
  }

  /**
   * Wake a pending waiter, if any. Idempotent — safe to call
   * even if no waiter is waiting.
   */
  _wakeWaiter() {
    if (this._waiter) {
      const resolve = this._waiter.resolve;
      this._waiter = null;
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
   * _wakeWaiter nulls _waiter synchronously after await.
   *
   * @param {boolean} drain — If true, process remaining queued
   *   messages after cancellation before exiting.
   */
  async * _messages(drain = false) {
    const signal = this._abortController.signal;
    while (true) {
      // Drain all currently queued messages synchronously
      while (this._queue.length > 0) {
        if (signal.aborted && !drain) break;
        yield this._queue.shift();
      }

      // Check exit conditions after draining
      if (signal.aborted) {
        if (!drain) break;
        // Drain mode: if queue is empty after cancellation, exit.
        // Otherwise loop back to drain remaining items.
        if (this._queue.length === 0) break;
        continue;
      }

      // Wait for the next message or cancellation.
      // The promise is scoped to this iteration — _wakeWaiter nulls
      // _waiter synchronously after await, so there's no lifecycle leak.
      const promise = new Promise((resolve) => {
        this._waiter = { resolve };
      });
      await promise;
      this._waiter = null;
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
  async _processMessage(text) {
    this._isRunning = true;
    const agent = this._sessionManager.getAgent();

    // Reset the agent's cancel flag before processing.
    // This clears any leftover cancelled state from the previous
    // message (e.g., interrupt) so the agent is ready for new work.
    if (agent) agent.resetCancel();

    // Input hook — sequential, handlers can transform or short-circuit.
    // Actions: { action: "continue" } | { action: "transform", text } | { action: "handled" }
    const inputData = { text, source: "interactive", agent };
    let inputHandled = false;
    if (agent?._hooks) {
      const inputResult = await agent._hooks.runHookPipeline(
        HOOKS.INPUT,
        inputData,
        { shouldStop: (result) => result?.action === "handled" },
      );
      if (inputResult.stopped) inputHandled = true;
      text = inputResult.data.text;
    }

    // If input was handled by a hook, skip agent processing
    if (inputHandled) {
      this._isRunning = false;
      this._sink.emit({ type: OUTPUT_EVENT.SESSION_STATE, key: "working", value: false });
      return;
    }

    try {
      await agent.run(text);
    } catch (e) {
      // Suppress cancellation errors on interrupt — the UI already
      // prints an "Interrupted" message, so the full error is noise.
      const isCancellation =
        e instanceof LlmError && e.type === "cancelled" ||
        e.name === "AbortError" ||
        LlmError.isCancelled(e);

      if (!isCancellation) {
        this._sink.emit({
          type: OUTPUT_EVENT.COMMAND_RESULT,
          content: isExpectedError(e) ? e.message : formatError(e),
        });
      }
    }

    this._isRunning = false;

    // Signal that the agent is done working so the UI can hide the spinner
    this._sink.emit({ type: OUTPUT_EVENT.SESSION_STATE, key: "working", value: false });
  }

  /**
   * Execute a command through the agent.
   */
  async executeCommand(cmdText) {
    const agent = this._sessionManager.getAgent();
    const cmd = parseCommand(cmdText, agent?.getCommandRegistry());

    if (!agent) {
      this._sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: "No agent available.",
      });
      return;
    }

    const result = await agent.executeCommand(cmd);

    if (result && result.error) {
      this._sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: result.error,
      });
    } else if (result && result.content) {
      this._sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: result.content,
      });
    }
  }
}
