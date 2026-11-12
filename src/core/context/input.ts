// The Input interface decouples question/answer collection from the tool itself;
// the UI (CLI, TUI, etc.) provides its own implementation.

/**
 * Canonical question shape, shared by the QUESTION output event, session replay buffers, and every Input implementation. 
 * The question-tool is the sole producer and normalizes all legacy aliases (snake_case allow_other, question/choices) into this form before emitting.
 */
export interface QuestionDef {
  key: string;
  prompt: string;
  options?: string[];
  required?: boolean;
  default?: string;
  allowOther?: boolean;
}

/**
 * The question seam: the one route from an extension to the human. The
 * interactive UI mounts an implementation on the tool context
 * (`toolCtx.get("input")`), reachable from the `tool:call` gate and the
 * `tool:result` pipeline; callers fail closed when it is absent.
 */
export interface QuestionSeam {
  isInteractive(): boolean;
  /** `signal` is the run's abort: the input bails out of its prompt loop and releases readline when the run is cancelled. */
  collectAnswers(
    questions: QuestionDef[],
    signal?: AbortSignal | null,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}

/**
 * No-op input implementation that silently returns defaults.
 * Used in non-interactive modes (CI, pipes, one-shot).
 */
export class NoopInput implements QuestionSeam {
  constructor() {}

  isInteractive(): boolean {
    return false;
  }

  collectAnswers(questions: QuestionDef[]): Record<string, unknown> {
    const answers: Record<string, unknown> = {};
    for (const q of questions) {
      answers[q.key] = q.default ?? "";
    }
    return answers;
  }
}
