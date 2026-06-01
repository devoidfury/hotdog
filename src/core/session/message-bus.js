// Message Bus — owns the agent run loop.
// Uses SessionManager for agent access.
// Extracted from main.js to allow extensions to import it independently.

import { formatError, isExpectedError } from "../context/error.js";
import { OUTPUT_EVENT } from "../context/output.js";
import { HOOKS } from "../hooks.js";
import { parseCommand } from "../commands.js";

/**
 * A simple message bus that owns the agent run loop.
 * Uses SessionManager for agent access.
 */
export class MessageBus {
  /**
   * @param {Object} options
   * @param {import("../core/session.js").SessionManager} options.sessionManager
   * @param {import("../context/output.js").OutputSink} options.sink
   */
  constructor({ sessionManager, sink }) {
    this._sessionManager = sessionManager;
    this._sink = sink;
    this._queue = [];
    this._isRunning = false;
    this._cancelled = false;
  }

  enqueue(text) {
    this._queue.push(text);
  }

  cancel() {
    this._cancelled = true;
    const agent = this._sessionManager.getAgent();
    if (agent) agent.cancel();
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
   */
  async run() {
    await this._dispatchLoop(false);
  }

  /**
   * Run the dispatch loop, draining remaining messages after cancellation.
   */
  async runUntilCancelled() {
    await this._dispatchLoop(true);
  }

  async _dispatchLoop(drain) {
    if (drain && this._cancelled && this._queue.length === 0) return;

    while (true) {
      let text = this._queue.shift();
      if (text === undefined) {
        if (this._cancelled) {
          if (!drain) break;
          await this._sleep(50);
          continue;
        }
        await this._sleep(50);
        continue;
      }

      if (this._cancelled) {
        if (!drain) break;
      }

      this._isRunning = true;
      const agent = this._sessionManager.getAgent();
      if (agent) agent.cancel(false);

      // Input hook — sequential, handlers can transform or short-circuit.
      // Actions: { action: "continue" } | { action: "transform", text } | { action: "handled" }
      const inputData = { text, source: "interactive", agent };
      let inputHandled = false;
      if (agent?._hooks) {
        const { stopped, data: finalData } = await agent._hooks.emitAsyncSeqUntil(
          HOOKS.INPUT,
          inputData,
          (result) => result?.action === "handled",
        );
        if (stopped) inputHandled = true;
        text = finalData.text;
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

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Execute a slash command through the agent.
   */
  async executeCommand(cmdText) {
    const agent = this._sessionManager.getAgent();
    const cmd = parseCommand(cmdText, agent?.getSlashCommandRegistry());

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
