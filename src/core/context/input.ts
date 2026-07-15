// Input events, parsing, and the Input interface for collecting user responses.
// The Input interface decouples question/answer collection from the tool itself.
// The UI (CLI, TUI, etc.) provides its own implementation.

// Input event types
export const INPUT_EVENT = {
  TEXT: "text",
  COMMAND: "command",
} as const;

export type InputEventType = (typeof INPUT_EVENT)[keyof typeof INPUT_EVENT];

export interface InputEvent {
  type: InputEventType;
  value: string;
}

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
 * Parse raw input text into a typed InputEvent.
 *
 * Returns { type: 'command', value } if the input starts with '/',
 * otherwise { type: 'text', value }.
 */
export function parseInput(input: string): InputEvent {
  const trimmed = input.trim();
  if (trimmed.startsWith("/")) {
    const cmd = trimmed.slice(1).trim();
    if (cmd.length === 0) {
      return { type: INPUT_EVENT.TEXT, value: trimmed };
    }
    return { type: INPUT_EVENT.COMMAND, value: cmd };
  }
  return { type: INPUT_EVENT.TEXT, value: trimmed };
}

/**
 * No-op input implementation that silently returns defaults.
 * Used in non-interactive modes (CI, pipes, one-shot).
 */
export class NoopInput {
  /**
   * Check if input is interactive.
   * @returns Always false.
   */
  isInteractive(): boolean {
    return false;
  }

  /**
   * Collect answers for a set of questions, returning defaults.
   */
  collectAnswers(questions: QuestionDef[]): Record<string, unknown> {
    const answers: Record<string, unknown> = {};
    for (const q of questions) {
      answers[q.key] = q.default ?? "";
    }
    return answers;
  }
}
