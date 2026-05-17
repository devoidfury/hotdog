// Input events, parsing, and the Input trait for collecting user responses.

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
 */
export class NoopInput {
  isInteractive() {
    return false;
  }

  collectAnswers(questions) {
    const answers = {};
    for (const q of questions) {
      answers[q.key] = q.default || '';
    }
    return answers;
  }
}
