// MCP elicitation -> the question seam.
//
// A stdio MCP server can send server-initiated requests mid-tool-call, the
// useful one being `elicitation/create` (payment confirmations, credential
// prompts, out-of-band approvals). This module converts one into the harness
// question shape and presents it through the SAME input seam the question
// tool uses -- including the "question" output event carrying the active
// tool call's id. That is the durability move: the session-log extension
// writes question_asked against that tool_call_id, so a held elicitation
// re-presents after a restart exactly like a question-tool call, and the
// answer lands as that call's real tool result.
//
// Spec note (2025-06-18+ form mode): result is
//   { action: "accept", content? } | { action: "decline" } | { action: "cancel" }
// "decline" = nobody could be asked / mode unsupported; "cancel" = the run
// was interrupted (or no tool call was active to attach the ask to).

import { logger } from "@utils/logger.ts";
import { formatError } from "@core/error.ts";
import type { QuestionDef } from "@core/context/input.ts";
import type { ToolContext } from "@core/extensions/tool-context.ts";

export type ElicitResult =
  | { action: "accept"; content?: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

/** Answers the server's elicitation/create request with the human's verdict. */
export type ElicitationHandler = (params: Record<string, unknown>) => Promise<ElicitResult>;

/** The input interface consumed by the question tool; same contract here. */
interface InputInterface {
  collectAnswers(questions: QuestionDef[], signal?: AbortSignal | null): Promise<Record<string, unknown>>;
  isInteractive(): boolean;
}

interface AgentLike {
  emitOutput(type: string, data: unknown): void;
  runAbortController?: AbortController | null;
  abortSignal?: AbortSignal | null;
}

/** Per-field facts needed to turn string answers back into typed content. */
interface FieldSpec {
  type: string;
  /** Original enum/oneOf values, indexed parallel to the rendered options. */
  enumValues?: unknown[];
}

interface ConvertedElicitation {
  questions: QuestionDef[];
  fields: Map<string, FieldSpec>;
  /** True when requestedSchema declares no fields: the ask is a pure confirmation. */
  confirmation: boolean;
}

const YES_WORDS = new Set(["yes", "y", "true", "1", "accept", "confirm", "ok"]);
const NO_WORDS = new Set(["no", "n", "false", "0", "decline", "deny", "cancel"]);

function stringifyDefault(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : String(value);
}

/** Extract (values, labels) from a property's enum or oneOf/const form. */
function extractEnum(def: Record<string, unknown>): { values: unknown[]; labels: string[] } | null {
  if (Array.isArray(def.enum)) {
    const values = def.enum as unknown[];
    const names = Array.isArray(def.enumNames) ? (def.enumNames as unknown[]) : null;
    return {
      values,
      labels: values.map((v, i) => (names && names[i] !== undefined ? String(names[i]) : String(v))),
    };
  }
  if (Array.isArray(def.oneOf) || Array.isArray(def.anyOf)) {
    const variants = (def.oneOf || def.anyOf) as Array<Record<string, unknown>>;
    const values = variants.map((v) => (v && "const" in v ? v.const : undefined));
    if (values.some((v) => v === undefined)) return null;
    return {
      values,
      labels: variants.map((v, i) => (v?.title ? String(v.title) : String(values[i]))),
    };
  }
  return null;
}

/** Convert elicitation/create params to question defs; null when unsupportable. */
export function elicitationToQuestions(
  params: Record<string, unknown>,
): ConvertedElicitation | null {
  // Form mode only: url-mode elicitations need an out-of-band browser flow.
  if (params.mode !== undefined && params.mode !== "form") return null;
  const message = typeof params.message === "string" ? params.message : "";
  const schema = params.requestedSchema;
  if (schema !== undefined && (typeof schema !== "object" || schema === null || Array.isArray(schema))) {
    return null;
  }
  const schemaRecord = (schema as Record<string, unknown>) || {};
  const properties = schemaRecord.properties as Record<string, unknown> | undefined;
  const required = Array.isArray(schemaRecord.required) ? (schemaRecord.required as unknown[]) : [];

  const fields = new Map<string, FieldSpec>();
  const questions: QuestionDef[] = [];

  const propEntries = properties ? Object.entries(properties) : [];
  for (const [name, rawDef] of propEntries) {
    if (typeof name !== "string" || !rawDef || typeof rawDef !== "object") continue;
    const def = rawDef as Record<string, unknown>;
    const type = typeof def.type === "string" ? def.type : "string";

    const suffix =
      typeof def.description === "string" && def.description
        ? def.description
        : typeof def.title === "string" && def.title
          ? def.title
          : propEntries.length > 1
            ? name
            : "";
    const question: QuestionDef = {
      key: name,
      prompt: [message, suffix].filter(Boolean).join(" -- ") || name,
      required: required.includes(name),
    };

    const spec: FieldSpec = { type };
    const en = extractEnum(def);
    if (en) {
      spec.enumValues = en.values;
      question.options = en.labels;
      // MCP enums are closed sets: strict selection at the seam. (Answers
      // arriving outside the seam -- e.g. a resume sweep -- still coerce to
      // free text for the server's own validation; see coerceAnswer.)
      question.allowOther = false;
    } else if (type === "boolean") {
      question.options = ["true", "false"];
      question.allowOther = false;
    }

    const defDefault = stringifyDefault(def.default);
    if (defDefault !== undefined) question.default = defDefault;

    fields.set(name, spec);
    questions.push(question);
  }

  if (questions.length === 0) {
    // A fieldless schema is a confirmation: one yes/no question, no content.
    if (!message) return null;
    questions.push({
      key: "confirm",
      prompt: message,
      options: ["yes", "no"],
      allowOther: false,
      required: true,
    });
    return { questions, fields, confirmation: true };
  }

  return { questions, fields, confirmation: false };
}

/** Map a raw answer to the field's schema type; undefined = omit the field. */
function coerceAnswer(raw: unknown, spec: FieldSpec): unknown {
  if (raw === undefined || raw === null) return undefined;
  const text = typeof raw === "string" ? raw.trim() : raw;
  if (text === "") return undefined;

  if (spec.enumValues) {
    // Labels render as String(value); match on the label, else pass the free
    // text through for the server's own validation.
    const asText = String(text);
    for (const value of spec.enumValues) {
      if (String(value) === asText) return value;
    }
    return text;
  }
  switch (spec.type) {
    case "boolean": {
      const lower = String(text).toLowerCase();
      if (YES_WORDS.has(lower)) return true;
      if (NO_WORDS.has(lower)) return false;
      return undefined;
    }
    case "number":
    case "integer": {
      const n = Number(text);
      return Number.isFinite(n) ? n : undefined;
    }
    default:
      // "string" and the array/object ceiling: the raw text rides through and
      // the server's schema validation is the authority.
      return typeof text === "string" || typeof text === "number" || typeof text === "boolean"
        ? text
        : String(text);
  }
}

/** Build elicitation content from answers; keys absent from the schema drop. */
export function answersToContent(
  answers: Record<string, unknown>,
  fields: Map<string, FieldSpec>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const [name, spec] of fields) {
    const value = coerceAnswer(answers[name], spec);
    if (value !== undefined) content[name] = value;
  }
  return content;
}

/**
 * Build the per-tool-call elicitation handler from the tool context. The
 * handler mirrors the question tool: emit the "question" event (durability),
 * collect through the mounted input seam, race run + agent abort. No
 * interactive seam (unmounted, or a defaults-answering seam): decline
 * immediately so the server is not left waiting on a human who does not
 * exist.
 *
 * ATTRIBUTION: the prompt is third-party text crossing into the human trust
 * boundary -- the same seam harness-issued questions ride. Every prompt is
 * prefixed `[mcp:<server>]` so "Your session expired, re-enter your API key"
 * from a hostile stdio server cannot masquerade as a harness prompt. The
 * prefix lives in the question_asked record too, so forensics sees the
 * source after the fact.
 */
export function createElicitationHandler(
  ctx: ToolContext | undefined,
  serverName: string,
): ElicitationHandler {
  return async (params) => {
    const converted = elicitationToQuestions(params);
    if (!converted) return { action: "decline" };

    // Stamp the third-party source into every prompt BEFORE the durability
    // event: the human sees it, the question_asked record keeps it, and the
    // post-restart re-presentation cannot lose it.
    for (const q of converted.questions) q.prompt = `[mcp:${serverName}] ${q.prompt}`;

    const input = ctx?.get("input") as InputInterface | undefined;
    if (!input) {
      logger.warn("[mcp] elicitation requested but no input seam is mounted; declining");
      return { action: "decline" };
    }
    // A seam that reports non-interactive answers from defaults (NoopInput
    // style). The server authors those defaults, so accepting through one
    // would auto-approve whatever it pre-filled -- a payment confirmation
    // resolved by the machine that requested it. Decline instead.
    if (!input.isInteractive()) {
      logger.warn("[mcp] elicitation requested but the input seam is non-interactive; declining");
      return { action: "decline" };
    }

    const agent = ctx?.get("agent") as AgentLike | undefined;
    const toolCallId = ctx?.get("toolCallId") as string | undefined;
    if (agent) {
      // Same event shape as the question tool: session-log records it as
      // question_asked under this tool_call_id, replay re-presents it.
      agent.emitOutput("question", {
        questions: converted.questions,
        server: serverName,
        ...(typeof toolCallId === "string" && toolCallId ? { toolCallId } : {}),
      });
    }

    // Cancel reaches the wait the same way it reaches a held question: the
    // run-scoped signal on the context plus the agent-level interrupt.
    const signals: AbortSignal[] = [];
    const runSignal =
      (ctx?.get("abortSignal") as AbortSignal | null | undefined) ?? agent?.runAbortController?.signal ?? null;
    if (runSignal) signals.push(runSignal);
    if (agent?.abortSignal) signals.push(agent.abortSignal);
    if (signals.some((s) => s.aborted)) return { action: "cancel" };

    const collect = Promise.resolve().then(() => input.collectAnswers(converted.questions, runSignal));
    const cleanups: Array<() => void> = [];
    const aborted = signals.length
      ? new Promise<"aborted">((resolve) => {
          for (const s of signals) {
            const onAbort = () => resolve("aborted");
            s.addEventListener("abort", onAbort, { once: true });
            cleanups.push(() => s.removeEventListener("abort", onAbort));
          }
        })
      : null;

    let outcome: unknown;
    try {
      outcome = await (aborted ? Promise.race([collect, aborted]) : collect);
    } catch (e: unknown) {
      logger.error(`[mcp] elicitation input failed: ${formatError(e)}`);
      return { action: "cancel" };
    } finally {
      for (const cleanup of cleanups) cleanup();
    }

    if (outcome === "aborted") {
      collect.catch(() => {});
      return { action: "cancel" };
    }

    const answers = (outcome as Record<string, unknown>) || {};
    if (converted.confirmation) {
      const verdict = String(answers.confirm ?? "").trim().toLowerCase();
      if (YES_WORDS.has(verdict)) return { action: "accept", content: {} };
      if (NO_WORDS.has(verdict)) return { action: "decline" };
      // Empty/garbage on a required confirmation: cancel (dismissed), never
      // silently accept.
      return { action: "cancel" };
    }

    return { action: "accept", content: answersToContent(answers, converted.fields) };
  };
}
