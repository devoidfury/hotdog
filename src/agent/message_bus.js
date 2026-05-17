// The message bus — single dispatcher that owns the agent run loop.
//
// Replaces per-UI run loops. Both CLI and future TUI enqueue text without
// blocking; the bus drains sequentially: dequeue → agent.run() → emit events → repeat.

import { MessageQueue } from "./message_queue.js";
import { OUTPUT_EVENT } from "../context/output.js";
import { formatError, isExpectedError } from "../context/error.js";

/**
 * The message bus — a single dispatcher that owns the agent run loop.
 *
 * Uses SessionManager for agent access, enabling profile switching and
// multi-session support.
 */
export class MessageBus {
  /**
   * @param {object} options
   * @param {import("./session_manager.js").SessionManager} options.sessionManager - Session manager for agent access
   * @param {import("../context/output.js").OutputSink} options.sink - Output sink for events
   * @param {Function} [options.wakeUpCallback] - Optional callback for task wake-up
   * @param {Function} [options.onMessageProcessed] - Optional callback called after each message is processed
   * @param {import("../marker_mangler.js").MarkerMangler} [options.markerMangler] - Optional marker mangler for injection prevention
   */
  constructor({ sessionManager, sink, wakeUpCallback, onMessageProcessed, markerMangler }) {
    this._sessionManager = sessionManager;
    this._sink = sink;
    this._queue = new MessageQueue();
    this._isRunning = false;
    this._cancelled = false;
    this._wakeUpCallback = wakeUpCallback;
    this._drainAfterCancel = false;
    this._onMessageProcessed = onMessageProcessed;
    this._markerMangler = markerMangler;
  }

  /**
   * Queue a text message for dispatch. Non-blocking.
   *
   * Note: This does NOT emit a UserMessage event. The UI layer is responsible
   * for rendering the user message (to avoid double-rendering with readline echo).
   */
  enqueue(text) {
    this._queue.push(text);
  }

  /**
   * Cancel the currently running agent dispatch. Safe from any thread.
   */
  cancel() {
    this._cancelled = true;
    const agent = this._sessionManager.getAgent();
    if (agent) {
      agent.cancel();
    }
  }

  /**
   * Set drain-after-cancel mode.
   * When true, the bus processes remaining queued messages before exiting.
   * When false (default), the bus exits immediately on cancellation.
   */
  setDrainAfterCancel(drain) {
    this._drainAfterCancel = drain;
  }

  /**
   * Check if the bus is idle (no active run and empty queue).
   */
  isIdle() {
    return !this._isRunning && this._queue.isEmpty();
  }

  /**
   * Get the output sink for emitting events.
   */
  get sink() {
    return this._sink;
  }

  /**
   * Get the session manager.
   */
  get sessionManager() {
    return this._sessionManager;
  }

  /**
   * Get the session ID for this bus.
   */
  get sessionId() {
    return this._sessionManager.sessionId();
  }

  /**
   * Get the current agent.
   */
  get agent() {
    return this._sessionManager.getAgent();
  }

  /**
   * Execute a prompt command and enqueue the rendered result for processing.
   *
   * Returns the rendered text on success, or throws on failure.
   */
  async executePromptAndEnqueue(cmd) {
    const agent = this._sessionManager.getAgent();
    if (!agent) throw new Error("No agent available");

    const result = agent.executePrompt(cmd);
    if (result.success) {
      this.enqueue(result.prompt || "");
      return result.prompt || "";
    }
    throw new Error(result.error);
  }

  /**
   * Run the dispatch loop. Drains messages sequentially:
   * dequeue → agent.run() → emit events → repeat.
   *
   * This is a long-lived async method that blocks until the cancellation
   * token is signalled (e.g., SIGINT / Ctrl-C). When cancelled, it drains
   * any remaining queued messages (if drainAfterCancel is true) and then
   * exits cleanly.
   */
  async run() {
    await this._dispatchLoop(false);
  }

  /**
   * Run the dispatch loop, draining remaining messages after cancellation.
   * Used for one-shot mode with multiple prompts.
   */
  async runUntilCancelled() {
    await this._dispatchLoop(true);
  }

  /**
   * Shared dispatch loop for run() and runUntilCancelled().
   *
   * @param {boolean} drain - If true, process remaining queued messages before exiting on cancel.
   */
  async _dispatchLoop(drain) {
    // Fast path: exit immediately if already cancelled with empty queue
    if (drain && this._cancelled && this._queue.isEmpty()) {
      return;
    }

    while (true) {
      // Wait for a message to be available
      const text = this._queue.shift();
      if (text === undefined) {
        // No messages in queue — check cancellation before sleeping
        if (this._cancelled) {
          if (!drain) break;
          // In drain mode, sleep briefly and retry to see if more messages arrive
          await this._sleep(50);
          continue;
        }
        // Not cancelled — wait for new messages
        await this._sleep(50);
        continue;
      }

      // Check cancellation before processing (task completion messages may arrive after cancel)
      if (this._cancelled) {
        if (!drain) break;
        // In drain mode, continue processing remaining messages
      }

      // Mark as running
      this._isRunning = true;

      // Reset cancellation for this turn and give the token to the agent
      const agent = this._sessionManager.getAgent();
      if (agent) {
        agent.cancel(false);
      }

      try {
        // Execute the agent run (this handles tool calls internally)
        await agent.run(text);
      } catch (e) {
        // Suppress error message for cancelled agents (user already saw the interrupt message)
        if (isExpectedError(e)) {
          // Expected errors: emit message only, no stack
          this._sink.emit({
            type: OUTPUT_EVENT.COMMAND_RESULT,
            content: e.message,
          });
        } else {
          // Unexpected errors: include full stack for debugging
          this._sink.emit({
            type: OUTPUT_EVENT.COMMAND_RESULT,
            content: formatError(e),
          });
        }
      }

      // Reset cancellation for this turn so subsequent runs work
      if (agent) {
        agent.cancel(false);
      }
      this._cancelled = false;
      this._isRunning = false;

      // In drain mode, if the queue is now empty, we're done — exit the loop
      if (drain && this._queue.isEmpty()) {
        break;
      }

      // Notify listener that message processing is complete
      if (this._onMessageProcessed) {
        this._onMessageProcessed();
      }
    }
  }

  /**
   * Wire up the task wake-up callback.
   *
   * When the meta profile is used, this wires up the mechanism
   * that pushes a wake-up message to the queue when delegated tasks complete.
   */
  wireTaskWakeUp() {
    if (!this._wakeUpCallback) return;

    const bus = this;
    const agent = this._sessionManager.getAgent();
    agent?.taskManager?.setWakeUpCallback((taskId, result) => {
      const escaped = this._markerMangler?.escapeMarkers(result) ?? result;
      const message = `<m_59gt7zdgkjzdeshe subagent="${taskId}">${escaped}</m_59gt7zdgkjzdeshe>`;
      bus.enqueue(message);
    });
  }

  /**
   * Sleep for the given number of milliseconds.
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
