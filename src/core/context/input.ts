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
