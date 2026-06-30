// MessageLog — a controlled wrapper around the agent's message array.

import { Message } from "./message.js";

export class MessageLog {
  /**
   * @param {Message[]} [messages] - Initial messages.
   */
  constructor(messages = []) {
    /** @type {Message[]} */
    this._messages = [...messages];
  }

  /**
   * Push a message onto the log.
   * @param {Message} msg - Must be a Message instance.
   * @returns {number} New length.
   */
  push(msg) {
    if (!(msg instanceof Message)) {
      throw new TypeError(
        `MessageLog.push() requires a Message instance, got ${typeof msg}`,
      );
    }
    this._messages.push(msg);
    return this._messages.length;
  }

  /**
   * Replace the entire message array.
   * All elements must be Message instances.
   * @param {Message[]} messages
   */
  replace(messages) {
    if (!Array.isArray(messages)) {
      throw new TypeError(
        `MessageLog.replace() requires an array, got ${typeof messages}`,
      );
    }
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!(m instanceof Message)) {
        throw new TypeError(
          `MessageLog.replace() requires all elements to be Message instances, ` +
            `element ${i} is ${typeof m}`,
        );
      }
    }
    this._messages = [...messages];
  }

  /**
   * Clear all messages.
   */
  clear() {
    this._messages = [];
  }

  /** Number of messages. */
  get length() {
    return this._messages.length;
  }

  /**
   * Get message at index.
   * @param {number} index
   * @returns {Message|undefined}
   */
  at(index) {
    return this._messages[index];
  }

  /**
   * Return a defensive copy of the message array.
   * Consumers cannot mutate the internal state via this reference.
   * @returns {Message[]}
   */
  getAll() {
    return [...this._messages];
  }

  /**
   * Messages with role === 'system'.
   * @returns {Message[]}
   */
  getSystem() {
    return this._messages.filter((m) => m.role === "system");
  }

  /**
   * Messages with role !== 'system'.
   * @returns {Message[]}
   */
  getNonSystem() {
    return this._messages.filter((m) => m.role !== "system");
  }

  /**
   * Get the most recent N messages.
   * @param {number} n
   * @returns {Message[]}
   */
  getRecent(n) {
    return this._messages.slice(-n);
  }

  /**
   * Slice a portion of the message array.
   * @param {number} [start]
   * @param {number} [end]
   * @returns {Message[]}
   */
  slice(start, end) {
    return this._messages.slice(start, end);
  }

  /**
   * Build the full message array for an LLM call, prepending the system prompt.
   * @param {string|null} [systemPrompt] - The system prompt string, or null.
   * @returns {Message[]} A new array (system message + context messages).
   */
  buildMessages(systemPrompt) {
    if (systemPrompt) {
      return [
        new Message({ role: "system", content: systemPrompt }),
        ...this._messages,
      ];
    }
    return [...this._messages];
  }

  /**
   * Serialize all messages to JSON-compatible objects.
   * @returns {Array<Object>}
   */
  toJSON() {
    return this._messages.map((m) => m.toJSON());
  }

  /**
   * Allow `for (const msg of log)` iteration.
   * @returns {Iterator<Message>}
   */
  [Symbol.iterator]() {
    return this.getAll()[Symbol.iterator]();
  }
}
