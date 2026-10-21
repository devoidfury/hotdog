import readline from "node:readline";
import { Channel, ChannelSessionManager } from "@core/channel.ts";
import type { OutputEvent } from "@core/context/output.ts";
import type { CliOutputSink } from "@utils/cli/cli.ts";

export interface CliChannelOptions {
  sessionManager: ChannelSessionManager;
  sessionId: string;
  sink: CliOutputSink;
  /**
   * The readline interface for the legacy input path. The stage-3b editor
   * path (split renderer) delivers input through the editor submit handler
   * and quits via onQuit, so it constructs the channel without one: `read()`
   * then yields nothing (the core Channel contract still requires the
   * method), and the close/quit paths skip the readline teardown because
   * there is no readline interface to tear down.
   */
  rl?: readline.Interface | null;
  onQuit?: () => void;
}

export class CliChannel extends Channel {
  #sink: CliOutputSink;
  #rl: readline.Interface | null;
  #onQuit: (() => void) | undefined;

  constructor(options: CliChannelOptions) {
    super({ sessionManager: options.sessionManager });
    this.#sink = options.sink;
    this.#rl = options.rl ?? null;
    this.#onQuit = options.onQuit;
    this.attach(options.sessionId);
  }

  protected write(event: OutputEvent): void {
    this.#sink.emit(event);
  }

  async *read(): AsyncIterable<string> {
    if (!this.#rl) return;
    // `return` in an async generator only sets the completion value; delegate
    // so callers actually receive the readline lines.
    yield* this.#rl[Symbol.asyncIterator]();
  }

  protected _cleanup(): void {
    // readline.close() is idempotent — safe to call multiple times
    this.#rl?.close();
  }

  protected override async handleQuit(): Promise<void> {
    this.#rl?.close();
    if (this.#onQuit) {
      this.#onQuit();
    }
  }

  get readline(): readline.Interface | null {
    return this.#rl;
  }

  get sink(): CliOutputSink {
    return this.#sink;
  }
}
