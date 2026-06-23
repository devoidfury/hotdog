// Message Bus — owns the agent run loop.
// Uses SessionManager for agent access.
// Event-driven: enqueue() resolves a deferred Promise instead of polling.

import { formatError, isExpectedError } from "../error.js";
import { OUTPUT_EVENT } from "../context/output.js";
import { HOOKS } from "../hooks.js";
import { parseCommand } from "../commands.js";

/**
 * An event-driven message bus that owns the agent run loop.
 * Uses SessionManager for agent access.
 * No polling — enqueue() resolves a deferred Promise.
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
    this._cancelled = false;
    // Deferred: resolves when a message is enqueued or cancelled.
    this._deferred = null;
    this._deferredResolve = null;
  }

  /**
   * Enqueue a message for processing.
   * If the dispatch loop is waiting, this wakes it immediately.
   */
  enqueue(text) {
    this._queue.push(text);
    // Wake the dispatch loop if it's waiting on a deferred
    if (this._deferredResolve) {
      const resolve = this._deferredResolve;
      this._deferred = null;
      this._deferredResolve = null;
      resolve();
    }
  }

  cancel() {
    this._cancelled = true;
    const agent = this._sessionManager.getAgent();
    if (agent) agent.cancel();
    // Also wake the loop so it can observe the cancellation immediately
    if (this._deferredResolve) {
      const resolve = this._deferredResolve;
      this._deferred = null;
      this._deferredResolve = null;
      resolve();
    }
  }

  isIdle() {
    return !this._isRunning && this._queue.length === 0;
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
    await this._dispatchLoop(false);
  }

  /**
   * Run the dispatch loop, draining remaining messages after cancellation.
   * Exits once cancelled and the queue is empty.
   */
  async runUntilCancelled() {
    await this._dispatchLoop(true);
  }

  /**
   * Wait for a message to arrive or cancellation.
   * Returns when either happens — the caller checks _queue and _cancelled.
   */
  async _waitForMessage() {
    // If there's already something to process or we're cancelled, return immediately
    if (this._queue.length > 0 || this._cancelled) return;

    // Create a deferred and wait for enqueue() or cancel() to resolve it
    this._deferred = new Promise((resolve) => {
      this._deferredResolve = resolve;
    });
    await this._deferred;
    this._deferred = null;
    this._deferredResolve = null;
  }

  async _dispatchLoop(drain) {
    if (drain && this._cancelled && this._queue.length === 0) return;

    while (true) {
      let text = this._queue.shift();

      if (text === undefined) {
        // Queue is empty — check for exit conditions
        if (this._cancelled) {
          if (!drain) break;
          // drain mode: wait for more messages that might have been enqueued
          // during processing, then exit when truly empty
          await this._waitForMessage();
          if (this._queue.length === 0) break;
          continue;
        }

        // Event-driven wait — no polling
        await this._waitForMessage();
        continue;
      }

      // Message was cancelled before we got to it
      if (this._cancelled) {
        if (!drain) break;
        // drain mode: keep processing remaining queued messages
      }

      this._isRunning = true;
      const agent = this._sessionManager.getAgent();
      if (agent) agent.cancel(false);

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
        if (agent) agent.cancel(false);
        this._cancelled = false;
        this._isRunning = false;
        continue;
      }

      try {
        await agent.run(text);
      } catch (e) {
        if (isExpectedError(e)) {
          this._sink.emit({
            type: OUTPUT_EVENT.COMMAND_RESULT,
            content: e.message,
          });
        } else {
          this._sink.emit({
            type: OUTPUT_EVENT.COMMAND_RESULT,
            content: formatError(e),
          });
        }
      }

      if (agent) agent.cancel(false);
      this._cancelled = false;
      this._isRunning = false;

      if (drain && this._queue.length === 0) break;
    }
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
