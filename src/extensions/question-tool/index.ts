// The tool emits a QUESTION event via the agent's sink so the UI can display
// the questions, then delegates answer collection to the Input interface
// carried in the tool context. This keeps the tool independent of any
// specific UI (readline, TUI, etc.).

import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";
import type { ToolMetadata } from "../../core/extensions/tool-registry.ts";
import { NoopInput } from "../../core/context/input.ts";
import { isPromise } from "../../utils/promise.ts";
import { HOOKS } from "../../core/hooks.ts";
import {
  CoreContext,
  ExtensionInstance,
  ToolContext,
} from "../../core/extensions/types.ts";

interface Question {
  key?: string;
  prompt?: string;
  question?: string;
  options?: string[];
  choices?: string[];
  required?: boolean;
  default?: string;
  allow_other?: boolean;
  allowOther?: boolean;
}

interface QuestionAnswers {
  [key: string]: unknown;
}

interface InputInterface {
  collectAnswers(questions: Question[]): Promise<QuestionAnswers> | QuestionAnswers;
  isInteractive(): boolean;
}

interface Agent {
  emitOutput(type: string, data: unknown): void;
}

function ensureKey(question: Question, index: number): string {
  // Treat an explicit empty string as a provided key, hence the "in" check.
  if ("key" in question && question.key !== undefined) return question.key;
  const prompt = question.prompt || question.question || "";
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return slug || `question_${index}`;
}

export class QuestionTool {
  static readonly TOOL_NAME = "question";
  metadata: ToolMetadata = { sideEffects: false, difficulty: 2 };

  toToolDef() {
    return toolDef(
      QuestionTool.TOOL_NAME,
      "Ask the user one or more questions. Supports required/optional questions, options (enum-style choices), free-text answers, and defaults. The agent loop pauses, asks the user, collects answers, and resumes with the answers as the tool result.",
      {
        properties: {
          questions: param(
            "array",
            "List of questions to ask. Each question must have a 'key' (unique identifier) and 'prompt' (the question text). Optional fields: 'options' (array of allowed answers), 'required' (boolean, default true), 'default' (default value), 'allow_other' (boolean, default true — when false, enforces strict selection from options).",
            {
              items: {
                type: "object",
                properties: {
                  key: {
                    type: "string",
                    description: "Unique identifier for this question. Answers are returned keyed by this value.",
                  },
                  prompt: {
                    type: "string",
                    description: "The question to ask the user.",
                  },
                  options: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional list of allowed answers. When provided, the user can select by number or type the option text.",
                  },
                  required: {
                    type: "boolean",
                    description: "Whether this question must be answered. Defaults to true.",
                  },
                  default: {
                    type: "string",
                    description: "Default value if user provides no input.",
                  },
                  allow_other: {
                    type: "boolean",
                    description: "When false, enforces strict selection from options. Defaults to true (free text accepted alongside option selection).",
                  },
                },
                required: ["key", "prompt"],
              },
            },
          ),
        },
        required: ["questions"],
      },
    );
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(
      input,
      (args: Record<string, unknown>) => {
        const qs = args.questions as Question[] | undefined;
        return `asking ${Array.isArray(qs) ? qs.length : 0} question(s)...`;
      },
      { fallback: "asking questions...", returnRawOnParseError: false },
    );
  }

  async execute(input: string | Record<string, unknown> | null, ctx: ToolContext): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args) {
      return ToolResult.err("Error parsing question arguments");
    }

    const questions = (args.questions as Question[]) || [];

    if (questions.length === 0) {
      return ToolResult.err("At least one question is required");
    }

    // Accept legacy field aliases (question/prompt, choices/options) and
    // snake_case keys from callers that predate the current schema.
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q) continue;

      q.key = ensureKey(q, i);

      if (q.key === "") {
        return ToolResult.err("Question key cannot be empty");
      }

      if (!q.prompt && q.question) {
        q.prompt = q.question;
      }

      if (!q.options && q.choices) {
        q.options = q.choices;
      }

      if ("allow_other" in q && !("allowOther" in q)) {
        q.allowOther = q.allow_other;
      }

      if (!q.prompt) {
        return ToolResult.err(`Question "${q.key}" is missing a prompt`);
      }
    }

    const agent = ctx?.get("agent") as Agent | undefined;
    if (agent) {
      agent.emitOutput("question", { questions });
    }

    const inputInterface: InputInterface = (ctx?.get("input") as InputInterface) || new NoopInput();

    let answers: QuestionAnswers = inputInterface.collectAnswers(questions) as QuestionAnswers;
    if (isPromise(answers)) {
      answers = (await answers) as QuestionAnswers;
    }

    const mode = inputInterface.isInteractive() ? "interactive" : "non-interactive";

    return ToolResult.ok(JSON.stringify(answers, null, 2)).withEntries({
      status: "success",
      mode,
      questions_asked: String(questions.length),
      questions_answered: String(Object.keys(answers).length),
    });
  }
}

// ── Extension Entry Point ───────────────────────────────────────────────────

export function create(_core: CoreContext): ExtensionInstance {
  const questionTool = new QuestionTool();

  return {
    hooks: {
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        registry.register("question", questionTool);
      },
    },

    // Exposed for external use.
    QuestionTool,
  };
}
