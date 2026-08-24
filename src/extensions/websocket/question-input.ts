// Resolves question-tool calls for WebSocket-hosted agents: a pending
// question per session, resolved when a client answers (C2S.questionAnswer),
// when the timeout elapses (per questionStrategy), or when the session is
// cancelled/deleted.
//
// Strategy semantics:
//   wait    -- hold until a client answers (no timeout timer)
//   default -- after questionTimeoutSecs, resolve with defaults
//   cancel  -- after questionTimeoutSecs, interrupt the session (which
//              cancels the pending question with defaults)

import type { QuestionDef } from "../../core/context/input.ts";

export type QuestionStrategy = "wait" | "default" | "cancel";

export interface QuestionPolicy {
  strategy: QuestionStrategy;
  timeoutSecs: number;
}

export interface QuestionBridgeHooks {
  getPolicy(sessionId: string): QuestionPolicy;
  hasChannels(sessionId: string): boolean;
  interrupt(sessionId: string): void;
}

interface PendingQuestion {
  questions: QuestionDef[];
  resolve: (answers: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Input interface consumed by the question tool. */
export interface QuestionInput {
  isInteractive(): boolean;
  collectAnswers(questions: QuestionDef[]): Promise<Record<string, unknown>>;
}

export class WebSocketQuestionBridge {
  #pending = new Map<string, PendingQuestion>();
  #inputs = new Map<string, QuestionInput>();
  #hooks: QuestionBridgeHooks;

  constructor(hooks: QuestionBridgeHooks) {
    this.#hooks = hooks;
  }

  inputFor(sessionId: string): QuestionInput {
    let input = this.#inputs.get(sessionId);
    if (!input) {
      input = {
        isInteractive: () => this.#hooks.hasChannels(sessionId),
        collectAnswers: (questions) => this.collect(sessionId, questions),
      };
      this.#inputs.set(sessionId, input);
    }
    return input;
  }

  /**
   * Block until the client answers, the timeout elapses, or cancel()
   * is called. A stale pending question for the same session is
   * resolved with defaults first so it cannot hang.
   */
  collect(
    sessionId: string,
    questions: QuestionDef[],
  ): Promise<Record<string, unknown>> {
    this.cancel(sessionId);

    return new Promise((resolve) => {
      const entry: PendingQuestion = { questions, resolve, timer: null };
      const { strategy, timeoutSecs } = this.#hooks.getPolicy(sessionId);

      if (strategy !== "wait" && timeoutSecs > 0) {
        entry.timer = setTimeout(() => {
          if (this.#pending.get(sessionId) !== entry) return; // already done
          this.#pending.delete(sessionId);
          if (strategy === "cancel") this.#hooks.interrupt(sessionId);
          resolve(WebSocketQuestionBridge.defaults(questions));
        }, timeoutSecs * 1000);
      }

      this.#pending.set(sessionId, entry);
    });
  }

  answer(sessionId: string, answers: Record<string, unknown>): boolean {
    const entry = this.#pending.get(sessionId);
    if (!entry) return false;
    this.#pending.delete(sessionId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(answers);
    return true;
  }

  /** Resolve the pending question with defaults (interrupt/delete). */
  cancel(sessionId: string): boolean {
    const entry = this.#pending.get(sessionId);
    if (!entry) return false;
    this.#pending.delete(sessionId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(WebSocketQuestionBridge.defaults(entry.questions));
    return true;
  }

  dropSession(sessionId: string): void {
    this.cancel(sessionId);
    this.#inputs.delete(sessionId);
  }

  hasPending(sessionId: string): boolean {
    return this.#pending.has(sessionId);
  }

  /** Drop all pending questions and timers (server shutdown, tests). */
  clear(): void {
    for (const entry of this.#pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.#pending.clear();
    this.#inputs.clear();
  }

  static defaults(questions: QuestionDef[]): Record<string, unknown> {
    const answers: Record<string, unknown> = {};
    for (const q of questions) {
      answers[q.key] = q.default ?? "";
    }
    return answers;
  }
}
