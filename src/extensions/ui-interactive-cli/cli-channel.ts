// CliChannel — Channel implementation for the interactive CLI.
// Renders events with colors to stdout/stderr and reads from readline.

import readline from "node:readline";
import { Channel, ChannelSessionManager } from "../../core/channel.ts";
import { OUTPUT_EVENT, OutputEvent } from "../../core/context/output.ts";
import { CliOutputSink } from "../../utils/cli/cli.ts";

// ── CliChannel ──────────────────────────────────────────────────────────────

export interface CliChannelOptions {
  sessionManager: ChannelSessionManager;
  sessionId: string;
  sink: CliOutputSink;
  rl: readline.Interface;
  onQuit?: () => void;
}

/**
 * Channel implementation for the interactive CLI.
 * Uses CliOutputSink for colored output and readline for input.
 */
export class CliChannel extends Channel {
  #sink: CliOutputSink;
  #rl: readline.Interface;
  #onQuit: (() => void) | undefined;
  #unsubscribers: Map<string, () => void>;

  /**
   * @param options
   * @param options.sessionManager — SessionManager instance
   * @param options.sessionId — Session ID to attach to
   * @param options.sink — CliOutputSink for formatted output
   * @param options.rl — readline interface for input
   * @param options.onQuit — Optional callback when /quit is handled
   */
  constructor(options: CliChannelOptions) {
    super({ sessionManager: options.sessionManager });
    this.#sink = options.sink;
    this.#rl = options.rl;
    this.#onQuit = options.onQuit;
    this.#unsubscribers = new Map();

    // Attach to the given session
    this.attach(options.sessionId);
  }

  // ── Abstract Protocol Methods ───────────────────────────────────────────

  /**
   * Format and deliver an event using CliOutputSink.
   */
  protected write(event: OutputEvent): void {
    this.#sink.emit(event);
  }

  /**
   * Read raw input from readline.
   * Yields lines as the user types them.
   */
  async *read(): AsyncIterable<string> {
    return this.#rl[Symbol.asyncIterator]();
  }

  /**
   * Wire session events to this channel via the sink.
   */
  protected _subscribe(sessionId: string): void {
    const unsubscribe = this.sessionManager.onSessionEvents(sessionId, (event: OutputEvent) => {
      this.write(event);
    });
    this.#unsubscribers.set(sessionId, unsubscribe);
  }

  /**
   * Remove the wire from a session.
   */
  protected _unsubscribe(sessionId: string): void {
    const unsubscribe = this.#unsubscribers.get(sessionId);
    if (unsubscribe) {
      unsubscribe();
      this.#unsubscribers.delete(sessionId);
    }
  }

  /**
   * Release readline resources on close.
   */
  protected _cleanup(): void {
    // readline.close() is idempotent — safe to call multiple times
    this.#rl.close();
  }

  // ── Override command handlers ────────────────────────────────────────────

  /** Handle /quit — close readline and call onQuit callback. */
  protected override async handleQuit(): Promise<void> {
    this.#rl.close();
    if (this.#onQuit) {
      this.#onQuit();
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Get the readline interface.
   */
  get readline(): readline.Interface {
    return this.#rl;
  }

  /**
   * Get the output sink.
   */
  get sink(): CliOutputSink {
    return this.#sink;
  }
}
