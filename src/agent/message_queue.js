// Simple FIFO message queue for pending prompts.
// Single-threaded — no locks needed.

export class MessageQueue {
  constructor() {
    this._items = [];
  }

  /** Enqueue a message. */
  push(msg) {
    this._items.push(msg);
  }

  /** Dequeue the next message. Returns undefined if empty. */
  shift() {
    return this._items.shift();
  }

  /** Check if the queue is empty. */
  isEmpty() {
    return this._items.length === 0;
  }
}
