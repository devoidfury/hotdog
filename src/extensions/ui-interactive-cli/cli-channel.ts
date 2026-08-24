import readline from "node:readline";
import { Channel, ChannelSessionManager } from "../../core/channel.ts";
import type { OutputEvent } from "../../core/context/output.ts";
import type { CliOutputSink } from "../../utils/cli/cli.ts";

export interface CliChannelOptions {
  sessionManager: ChannelSessionManager;
  sessionId: string;
  sink: CliOutputSink;
  rl: readline.Interface;
  onQuit?: () => void;
}

export class CliChannel extends Channel {
  #sink: CliOutputSink;
  #rl: readline.Interface;
  #onQuit: (() => void) | undefined;
  #unsubscribers: Map<string, () => void>;

  constructor(options: CliChannelOptions) {
    super({ sessionManager: options.sessionManager });
    this.#sink = options.sink;
    this.#rl = options.rl;
    this.#onQuit = options.onQuit;
    this.#unsubscribers = new Map();

    this.attach(options.sessionId);
  }

  protected write(event: OutputEvent): void {
    this.#sink.emit(event);
  }

  async *read(): AsyncIterable<string> {
    return this.#rl[Symbol.asyncIterator]();
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
    // readline.close() is idempotent — safe to call multiple times
    this.#rl.close();
  }

  protected override async handleQuit(): Promise<void> {
    this.#rl.close();
    if (this.#onQuit) {
      this.#onQuit();
    }
  }

  get readline(): readline.Interface {
    return this.#rl;
  }

  get sink(): CliOutputSink {
    return this.#sink;
  }
}
