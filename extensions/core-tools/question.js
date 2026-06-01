// Question tool — ask the user questions and collect answers.

import readline from "node:readline";
import { toolDef, param, ToolResult, toolResult } from "./registry.js";

export class QuestionTool {
  static TOOL_NAME = "question";

  toToolDef() {
    return toolDef(
      QuestionTool.TOOL_NAME,
      "Ask the user questions. Returns answers as JSON.",
      {
        properties: {
          questions: param("array", "Array of question definitions."),
        },
        required: ["questions"],
      },
    );
  }

  callDisplay(input) {
    const args = typeof input === "string" ? JSON.parse(input) : input;
    return `question: ${args.questions?.length || 0} question(s)`;
  }

  async execute(input, ctx) {
    const args = typeof input === "string" ? JSON.parse(input) : input;
    const questions = args.questions || [];
    const answers = {};

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    for (const q of questions) {
      const prompt = `${q.prompt}${q.default ? ` [${q.default}]` : ""}: `;
      const answer = await new Promise((resolve) => {
        rl.question(prompt, (answer) => {
          resolve(answer.trim() || q.default || "");
        });
      });
      answers[q.key] = answer;
    }

    rl.close();
    return ToolResult.ok(JSON.stringify(answers, null, 2)).withEntries({
      answer_count: String(Object.keys(answers).length),
    });
  }
}
