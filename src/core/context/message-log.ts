import { Message } from "./message.ts";

export class MessageLog {
  #messages: Message[];

  constructor(messages: Message[] = []) {
    this.#messages = [...messages];
  }

  push(msg: Message): number {
    if (!(msg instanceof Message)) {
      throw new TypeError(
        `MessageLog.push() requires a Message instance, got ${typeof msg}`,
      );
    }
    this.#messages.push(msg);
    return this.#messages.length;
  }

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

  clear(): void {
    this.#messages = [];
  }

  get length(): number {
    return this.#messages.length;
  }

  at(index: number): Message | undefined {
    return this.#messages[index];
  }

  /** Defensive copy; callers cannot mutate internal state through it. */
  getAll(): Message[] {
    return [...this.#messages];
  }

  getSystem(): Message[] {
    return [...this.#messages.filter((m) => m.role === "system")];
  }

  getNonSystem(): Message[] {
    return [...this.#messages.filter((m) => m.role !== "system")];
  }

  getRecent(n: number): Message[] {
    return [...this.#messages.slice(-n)];
  }

  slice(start?: number, end?: number): Message[] {
    return [...this.#messages.slice(start, end)];
  }

  buildMessages(systemPrompt?: string | null): Message[] {
    if (systemPrompt) {
      return [
        new Message({ role: "system", content: systemPrompt, source: "system" }),
        ...this.#messages,
      ];
    }
    return [...this.#messages];
  }

  toJSON(): Record<string, unknown>[] {
    return this.#messages.map((m) => m.toJSON());
  }

  [Symbol.iterator](): Iterator<Message> {
    return this.getAll()[Symbol.iterator]();
  }
}
