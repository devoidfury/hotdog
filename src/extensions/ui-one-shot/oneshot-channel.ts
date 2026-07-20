// OneShotChannel — Channel implementation for one-shot prompt mode.
// Single prompt, collects events, then exits.

import { Channel, ChannelSessionManager } from "../../core/channel.ts";
import { OUTPUT_EVENT, OutputEvent } from "../../core/context/output.ts";
import { CliOutputSink } from "../../utils/cli/cli.ts";

// ── OneShotChannel ──────────────────────────────────────────────────────────

export interface OneShotChannelOptions {
  sessionManager: ChannelSessionManager;
  sessionId: string;
  sink: CliOutputSink;
}

/**
 * Channel implementation for one-shot mode.
 * No interactive input — single prompt, collect events, exit.
 */
export class OneShotChannel extends Channel {
  #sink: CliOutputSink;
  #events: OutputEvent[];
  #unsubscribers: Map<string, () => void>;

  /**
   * @param options
   * @param options.sessionManager — SessionManager instance
   * @param options.sessionId — Session ID to attach to
   * @param options.sink — CliOutputSink for formatted output
   */
  constructor(options: OneShotChannelOptions) {
    super({ sessionManager: options.sessionManager });
    this.#sink = options.sink;
    this.#events = [];
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
    this.#events.push(event);
  }

  /**
   * Read raw input — empty (no input after initial prompt).
   */
  async *read(): AsyncIterable<string> {
    // No input in one-shot mode
    return;
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
   * No cleanup needed.
   */
  protected _cleanup(): void {
    // No resources to clean up
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Get the collected events.
   */
  get events(): OutputEvent[] {
    return this.#events;
  }

  /**
   * Get the output sink.
   */
  get sink(): CliOutputSink {
    return this.#sink;
  }
}
