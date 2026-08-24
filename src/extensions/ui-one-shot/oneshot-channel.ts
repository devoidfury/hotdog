import { Channel, ChannelSessionManager } from "../../core/channel.ts";
import { OutputEvent } from "../../core/context/output.ts";
import { CliOutputSink } from "../../utils/cli/cli.ts";

export interface OneShotChannelOptions {
  sessionManager: ChannelSessionManager;
  sessionId: string;
  sink: CliOutputSink;
}

export class OneShotChannel extends Channel {
  #sink: CliOutputSink;
  #events: OutputEvent[];
  #unsubscribers: Map<string, () => void>;

  constructor(options: OneShotChannelOptions) {
    super({ sessionManager: options.sessionManager });
    this.#sink = options.sink;
    this.#events = [];
    this.#unsubscribers = new Map();

    this.attach(options.sessionId);
  }

  protected write(event: OutputEvent): void {
    this.#sink.emit(event);
    this.#events.push(event);
  }

  // No further input in one-shot mode — the single prompt is enqueued up front
  async *read(): AsyncIterable<string> {
    return;
  }

  protected _subscribe(sessionId: string): void {
    const unsubscribe = this.sessionManager.onSessionEvents(sessionId, (event: OutputEvent) => {
      this.write(event);
    });
    this.#unsubscribers.set(sessionId, unsubscribe);
  }

  protected _unsubscribe(sessionId: string): void {
    const unsubscribe = this.#unsubscribers.get(sessionId);
    if (unsubscribe) {
      unsubscribe();
      this.#unsubscribers.delete(sessionId);
    }
  }

  protected _cleanup(): void {
    // No resources to release
  }

  get events(): OutputEvent[] {
    return this.#events;
  }

  get sink(): CliOutputSink {
    return this.#sink;
  }
}
