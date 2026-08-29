// The Input interface decouples question/answer collection from the tool itself;
// the UI (CLI, TUI, etc.) provides its own implementation.

export interface QuestionDef {
  key: string;
  prompt?: string;
  options?: string[];
  default?: unknown;
  required?: boolean;
  allowOther?: boolean;
  allow_other?: boolean;
}

/**
 * No-op input implementation that silently returns defaults.
 * Used in non-interactive modes (CI, pipes, one-shot).
 */
export class NoopInput {
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
