// MessageLog — a controlled wrapper around the agent's message array.

import { Message } from "./message.ts";

export class MessageLog {
  #messages: Message[];

  /**
   * @param messages - Initial messages.
   */
  constructor(messages: Message[] = []) {
    this.#messages = [...messages];
  }

  /**
   * Push a message onto the log.
   */
  push(msg: Message): number {
    if (!(msg instanceof Message)) {
      throw new TypeError(
        `MessageLog.push() requires a Message instance, got ${typeof msg}`,
      );
    }
    this.#messages.push(msg);
    return this.#messages.length;
  }

  /**
   * Replace the entire message array.
   * All elements must be Message instances.
   */
  replace(messages: Message[]): void {
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
    this.#messages = [...messages];
  }

  /**
   * Clear all messages.
   */
  clear(): void {
    this.#messages = [];
  }

  /** Number of messages. */
  get length(): number {
    return this.#messages.length;
  }

  /**
   * Get message at index.
   */
  at(index: number): Message | undefined {
    return this.#messages[index];
  }

  /**
   * Return a defensive copy of the message array.
   * Consumers cannot mutate the internal state via this reference.
   */
  getAll(): Message[] {
    return [...this.#messages];
  }

  /**
   * Messages with role === 'system'.
   */
  getSystem(): Message[] {
    return [...this.#messages.filter((m) => m.role === "system")];
  }

  /**
   * Messages with role !== 'system'.
   */
  getNonSystem(): Message[] {
    return [...this.#messages.filter((m) => m.role !== "system")];
  }

  /**
   * Get the most recent N messages.
   */
  getRecent(n: number): Message[] {
    return [...this.#messages.slice(-n)];
  }

  /**
   * Slice a portion of the message array.
   */
  slice(start?: number, end?: number): Message[] {
    return [...this.#messages.slice(start, end)];
  }

  /**
   * Build the full message array for an LLM call, prepending the system prompt.
   */
  buildMessages(systemPrompt?: string | null): Message[] {
    if (systemPrompt) {
      return [
        new Message({ role: "system", content: systemPrompt }),
        ...this.#messages,
      ];
    }
    return [...this.#messages];
  }

  /**
   * Serialize all messages to JSON-compatible objects.
   */
  toJSON(): Record<string, unknown>[] {
    return this.#messages.map((m) => m.toJSON());
  }

  /**
   * Allow `for (const msg of log)` iteration.
   */
  [Symbol.iterator](): Iterator<Message> {
    return this.getAll()[Symbol.iterator]();
  }
}
