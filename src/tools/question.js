// Question tool — ask the user questions and collect answers.

import readline from 'node:readline';
import { toolDef, param, toolResult } from './registry.js';

export class QuestionTool {
  static TOOL_NAME = 'question';
  static FIRST_USE_HELP = `Ask the user questions and collect answers. Returns a JSON object mapping question keys to answers.`;

  static tryNewFromContext(ctx) {
    return new QuestionTool();
  }

  toToolDef() {
    return toolDef(
      QuestionTool.TOOL_NAME,
      'Ask the user questions. Returns answers as JSON.',
      {
        properties: {
          questions: param('array', 'Array of question definitions.'),
        },
        required: ['questions'],
      }
    );
  }

  callDisplay(input) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    return `question: ${args.questions?.length || 0} question(s)`;
  }

  firstUseHelp() {
    return QuestionTool.FIRST_USE_HELP;
  }

  async execute(input, ctx) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    const questions = args.questions || [];
    const answers = {};

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    for (const q of questions) {
      const prompt = `${q.prompt}${q.default ? ` [${q.default}]` : ''}: `;
      const answer = await new Promise((resolve) => {
        rl.question(prompt, (answer) => {
          resolve(answer.trim() || q.default || '');
        });
      });
      answers[q.key] = answer;
    }

    rl.close();
    return toolResult(JSON.stringify(answers, null, 2));
  }
}
