import { Channel, ChannelSessionManager } from "@core/channel.ts";
import { OutputEvent } from "@core/context/output.ts";
import { CliOutputSink } from "@utils/cli/cli.ts";

export interface OneShotChannelOptions {
  sessionManager: ChannelSessionManager;
  sessionId: string;
  sink: CliOutputSink;
}

export class OneShotChannel extends Channel {
  #sink: CliOutputSink;

  constructor(options: OneShotChannelOptions) {
    super({ sessionManager: options.sessionManager });
    this.#sink = options.sink;
    this.attach(options.sessionId);
  }

  protected write(event: OutputEvent): void {
    this.#sink.emit(event);
  }

  // No further input in one-shot mode — the single prompt is enqueued up front
  async *read(): AsyncIterable<string> {
    return;
  }

  protected _cleanup(): void {
    // No resources to release
  }

  get sink(): CliOutputSink {
    return this.#sink;
  }
}
