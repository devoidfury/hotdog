// The `hotdog rpc` connection: a Channel whose writes are JSONL records on
// stdout and whose input is JSONL command records on stdin. Everything the
// CLI's readline drives (steering sends, slash commands, cancel, interrupt)
// rides the base Channel/SessionManager path, so the machine interface and a
// human at a terminal cannot diverge.
//
// v1 scope: one attached session per connection (the hello names it); the
// multi-session hub story stays with the webui's WebSocket protocol. The
// question seam is mounted (AGENT_TOOL_CONTEXT in index.ts), so the question
// tool and user-gate approvals round-trip as `ask` records / `answer`
// commands instead of failing closed.

import { Channel, type ChannelSessionManager } from "@core/channel.ts";
import type { OutputEvent } from "@core/context/output.ts";
import {
  markAnswersUnanswered,
  type QuestionDef,
  type QuestionSeam,
} from "@core/context/input.ts";
import {
  askRecord,
  errorRecord,
  eventRecord,
  helloRecord,
  parseCommandLine,
  replyRecord,
  type RpcCommand,
} from "./protocol.ts";

/**
 * Blocks on `collectAnswers` until a matching `answer` command lands, the run
 * is cancelled (honest unanswered stamp, never silent defaults), or the
 * connection settles everything (shutdown/EOF).
 */
export class RpcQuestionSeam implements QuestionSeam {
  #pending = new Map<string, (answers: Record<string, unknown>) => void>();
  #n = 0;
  #emitAsk: (askId: string, questions: QuestionDef[]) => void;

  constructor(emitAsk: (askId: string, questions: QuestionDef[]) => void) {
    this.#emitAsk = emitAsk;
  }

  isInteractive(): boolean {
    return true;
  }

  collectAnswers(
    questions: QuestionDef[],
    signal?: AbortSignal | null,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted) {
      return Promise.resolve(markAnswersUnanswered({}, "run cancelled"));
    }
    const askId = `a${++this.#n}`;
    return new Promise<Record<string, unknown>>((resolve) => {
      const settle = (answers: Record<string, unknown>) => {
        this.#pending.delete(askId);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(answers);
      };
      const onAbort = () => settle(markAnswersUnanswered({}, "run cancelled"));
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(askId, settle);
      this.#emitAsk(askId, questions);
    });
  }

  /** Resolve a pending ask. False = unknown/completed askId. */
  answer(askId: string, answers: Record<string, unknown>): boolean {
    const settle = this.#pending.get(askId);
    if (!settle) return false;
    settle(answers);
    return true;
  }

  /** Release every held ask (cancel-all on shutdown/EOF) as unanswered. */
  settleAllUnanswered(reason: string): void {
    for (const askId of Array.from(this.#pending.keys())) {
      this.answer(askId, markAnswersUnanswered({}, reason));
    }
  }

  pendingAskIds(): string[] {
    return Array.from(this.#pending.keys());
  }
}

export interface RpcServerOptions {
  sessionManager: ChannelSessionManager;
  sessionId: string;
  writeLine: (line: string) => void;
  model?: string;
}

export class RpcServer extends Channel {
  #writeLine: (line: string) => void;
  #seam: RpcQuestionSeam;
  #seq = 0;
  #subscriptions = new Map<string, () => void>();
  #finished: Promise<void>;
  // Synchronously assigned in the Promise executor below; the no-op keeps
  // the definite-assignment analysis honest.
  #finish: () => void = () => {};

  constructor(options: RpcServerOptions) {
    super({ sessionManager: options.sessionManager });
    this.#writeLine = options.writeLine;
    this.#seam = new RpcQuestionSeam((askId, questions) => {
      this.#writeLine(JSON.stringify(askRecord(askId, questions, this.currentSessionId)) + "\n");
    });
    this.#finished = new Promise<void>((resolve) => {
      this.#finish = resolve;
    });
    this.attach(options.sessionId);
    this.currentSessionId = options.sessionId;
  }

  get seam(): RpcQuestionSeam {
    return this.#seam;
  }

  hello(model?: string): void {
    this.#writeLine(JSON.stringify(helloRecord(this.currentSessionId ?? "", model)) + "\n");
  }

  /**
   * Read command records until stdin closes or a shutdown completes. The
   * stdin loop and the quit path race: `/quit` (a slash command, so it can
   * arrive mid-loop) resolves `#finished` while the iterator still blocks on
   * a read, letting the process exit without waiting for a line.
   */
  async run(reader: AsyncIterable<string>): Promise<void> {
    const loop = (async () => {
      for await (const line of reader) {
        if (this.isClosed) return;
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (await this.handleLine(trimmed)) return;
      }
    })();
    await Promise.race([loop, this.#finished]);
    this.#seam.settleAllUnanswered("connection closed");
    this.close();
  }

  /** Handle one command record. Returns true when the connection is done. */
  async handleLine(line: string): Promise<boolean> {
    const parsed = parseCommandLine(line);
    if (!parsed.ok) {
      if (parsed.id !== null) {
        this.#write(JSON.stringify(replyRecord(parsed.id, false, { error: parsed.error })) + "\n");
      } else {
        this.#write(JSON.stringify(errorRecord(parsed.error)) + "\n");
      }
      return false;
    }
    return await this.handleCommandRecord(parsed.command);
  }

  async handleCommandRecord(command: RpcCommand): Promise<boolean> {
    const { id } = command;
    switch (command.cmd) {
      case "prompt": {
        // Base Channel.send: "/"-prefixed text runs as a slash command,
        // everything else requests steering (queued normally at idle).
        await this.send(command.text ?? "");
        this.#write(JSON.stringify(replyRecord(id, true)) + "\n");
        return false;
      }
      case "cancel": {
        const target = command.session ?? this.currentSessionId;
        if (target) this.sessionManager.cancel(target);
        this.#write(JSON.stringify(replyRecord(id, true)) + "\n");
        return false;
      }
      case "interrupt": {
        const target = command.session ?? this.currentSessionId;
        if (target) this.sessionManager.interrupt(target);
        this.#write(JSON.stringify(replyRecord(id, true)) + "\n");
        return false;
      }
      case "status": {
        const sessions = this.sessionManager.sessionIds().map((sid) => {
          const info = this.sessionManager.getSessionInfo(sid);
          return info ? { ...info } : { id: sid };
        });
        this.#write(
          JSON.stringify(
            replyRecord(id, true, {
              data: {
                current: this.currentSessionId,
                sessions,
                pendingAsks: this.#seam.pendingAskIds(),
              },
            }),
          ) + "\n",
        );
        return false;
      }
      case "answer": {
        const ok = this.#seam.answer(command.askId ?? "", command.answers ?? {});
        this.#write(
          JSON.stringify(
            replyRecord(id, ok, ok ? undefined : { error: `unknown or completed ask: ${command.askId}` }),
          ) + "\n",
        );
        return false;
      }
      case "shutdown": {
        // The ack must be on the wire before the close, so reply first.
        this.#writeLine(JSON.stringify(replyRecord(id, true)) + "\n");
        this.close();
        return true;
      }
    }
  }

  // Base handleQuit() (a `/quit` slash command) calls close(); the override
  // below resolves the run loop, so no quit wiring is needed here.
  override close(): void {
    if (this.isClosed) return;
    super.close();
    this.#finish();
  }

  /** Input arrives through run(), not the base read() contract: yields nothing. */
  async *read(): AsyncIterable<string> {
    return;
  }

  protected write(event: OutputEvent): void {
    this.emitEvent(event, this.currentSessionId);
  }

  private emitEvent(event: OutputEvent, sessionId: string | null): void {
    this.#writeLine(JSON.stringify(eventRecord(event, ++this.#seq, sessionId)) + "\n");
  }

  // Session-tagged subscriptions: the base Channel hands write() an untagged
  // event, but machine clients route on `session`, so each subscription
  // captures its own id. (v1 attaches one session; the tagging is what makes
  // multi-attach honest if that ever grows.)
  protected override _subscribe(sessionId: string): void {
    const unsubscribe = this.sessionManager.onSessionEvents(sessionId, (event: OutputEvent) => {
      this.emitEvent(event, sessionId);
    });
    this.#subscriptions.set(sessionId, unsubscribe);
  }

  protected override _unsubscribe(sessionId: string): void {
    const unsubscribe = this.#subscriptions.get(sessionId);
    if (unsubscribe) {
      unsubscribe();
      this.#subscriptions.delete(sessionId);
    }
  }

  protected _cleanup(): void {
    // Nothing beyond detach-driven unsubscription (handled above).
  }

  #write(line: string): void {
    this.#writeLine(line);
  }
}
