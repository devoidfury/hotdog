// Input events, parsing, and the Input interface for collecting user responses.
// The Input interface decouples question/answer collection from the tool itself.
// The UI (CLI, TUI, etc.) provides its own implementation.

// Input event types
export const INPUT_EVENT = {
  TEXT: 'text',
  COMMAND: 'command',
};

/**
 * Parse raw input text into a typed InputEvent.
 *
 * Returns { type: 'command', value } if the input starts with '/',
 * otherwise { type: 'text', value }.
 *
 * @param {string} input - Raw user input.
 * @returns {{type: 'text'|'command', value: string}} Parsed input event.
 */
export function parseInput(input) {
  const trimmed = input.trim();
  if (trimmed.startsWith('/')) {
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
   * @returns {boolean} Always false.
   */
  isInteractive() {
    return false;
  }

  /**
   * Collect answers for a set of questions, returning defaults.
   * @param {Array<{key: string, default?: any}>} questions - Question definitions.
   * @returns {Object} Answers object with default values.
   */
  collectAnswers(questions) {
    const answers = {};
    for (const q of questions) {
      answers[q.key] = q.default || '';
    }
    return answers;
  }
}
