// Question tool — ask the user questions and collect answers.
// Port of hotdog/src/tools/question/mod.rs
//
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
import { NoopInput } from "../../core/context/input.js";

import { HOOKS } from "../../core/hooks.js";

/**
 * Generate a key from the prompt if one is not provided.
 * Returns null if key is explicitly empty (caller should reject).
 */
function ensureKey(question, index) {
  // If key was explicitly provided (even as empty string), use it as-is.
  // The caller is responsible for rejecting empty keys.
  if ("key" in question) return question.key;
  // Derive a key from the prompt text
  const prompt = question.prompt || question.question || "";
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return slug || `question_${index}`;
}

export class QuestionTool {
  static TOOL_NAME = "question";

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

  callDisplay(input) {
    return defaultCallDisplay(
      input,
      (args) => `asking ${args.questions?.length || 0} question(s)...`,
      { fallback: "asking questions...", returnRawOnParseError: false },
    );
  }

  async execute(input, ctx) {
    const args = parseToolInput(input);
    if (!args) {
      return ToolResult.err("Error parsing question arguments");
    }

    const questions = args.questions || [];

    if (questions.length === 0) {
      return ToolResult.err("At least one question is required");
    }

    // Normalize questions: ensure keys, handle field aliases
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];

      // Ensure key
      q.key = ensureKey(q, i);

      if (q.key === "") {
        return ToolResult.err("Question key cannot be empty");
      }

      // Handle field alias: 'question' -> 'prompt'
      if (!q.prompt && q.question) {
        q.prompt = q.question;
      }

      // Handle field alias: 'choices' -> 'options'
      if (!q.options && q.choices) {
        q.options = q.choices;
      }

      // Handle snake_case -> camelCase for allow_other
      if ("allow_other" in q && !("allowOther" in q)) {
        q.allowOther = q.allow_other;
      }

      // Ensure prompt exists
      if (!q.prompt) {
        return ToolResult.err(`Question "${q.key}" is missing a prompt`);
      }
    }

    // Get the agent from context to emit the QUESTION event
    const agent = ctx?.get("agent");
    if (agent) {
      agent._emitOutput("question", { questions });
    }

    // Get the input interface from context, fall back to NoopInput
    const inputInterface = ctx?.get("input") || new NoopInput();

    // Collect answers via the input interface (may be async)
    let answers = inputInterface.collectAnswers(questions);
    if (answers && typeof answers.then === "function") {
      answers = await answers;
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

/**
 * Create the question-tool extension.
 *
 * @param {Object} core - The core object.
 * @returns {Object} The extension instance.
 */
export function create(core) {
  const questionTool = new QuestionTool();

  return {
    hooks: {
      /**
       * Register the question tool.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        registry.register("question", questionTool);
      },
    },

    // Expose for external use
    QuestionTool,
  };
}
