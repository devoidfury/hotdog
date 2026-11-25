import { Channel, ChannelSessionManager } from "@core/channel.ts";
import { OutputEvent } from "@core/context/output.ts";
import { CliOutputSink } from "@utils/cli/cli.ts";
import type { JsonlEventWriter } from "../ui-rpc/protocol.ts";

/** A one-shot turn writes to a human sink (CliOutputSink) or to the machine
 *  event writer; both satisfy emit(event), and nothing else is used here. */
export type OneShotSink = CliOutputSink | JsonlEventWriter;

export interface OneShotChannelOptions {
  sessionManager: ChannelSessionManager;
  sessionId: string;
  sink: OneShotSink;
}

export class OneShotChannel extends Channel {
  #sink: OneShotSink;

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

  get sink(): OneShotSink {
    return this.#sink;
  }
}
