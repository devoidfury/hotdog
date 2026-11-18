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
 * The question seam: the one route from an extension to the human. The
 * interactive UI mounts an implementation on the tool context
 * (`toolCtx.get("input")`), reachable from the `tool:call` gate and the
 * `tool:result` pipeline; callers fail closed when it is absent.
 */
export interface QuestionSeam {
  isInteractive(): boolean;
  /** `signal` is the run's abort: the input bails out of its prompt loop and releases readline when the run is cancelled. */
  collectAnswers(
    questions: QuestionDef[],
    signal?: AbortSignal | null,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}

/**
 * Honesty marker (D10): a Symbol-keyed, NON-ENUMERABLE property stamped on the
 * answers object by an input implementation whose resolution is NOT a real
 * answer (a worker's manager-gone release, a terminal cancel of a held worker
 * question). The value is the honest reason string. Non-enumerable means it
 * rides no JSON, no spread, no key iteration -- the answers object stays an
 * ordinary `Record<string, unknown>` for every existing consumer, and the
 * question seam's published signature is untouched. A mounted input that
 * resolves with a real answer never stamps it; the question tool checks it
 * (see `unansweredReason`) and renders `mode: "unanswered"` instead of
 * presenting defaults as a reply.
 */
export const QUESTION_UNANSWERED: unique symbol = Symbol("hotdog.questionUnanswered");

/** Stamp the marker (returns the same object for call-site fluency). */
export function markAnswersUnanswered(
  answers: Record<string, unknown>,
  reason: string,
): Record<string, unknown> {
  Object.defineProperty(answers, QUESTION_UNANSWERED, {
    value: reason,
    enumerable: false,
    configurable: true,
  });
  return answers;
}

/** Read the marker: the reason string, or null when this WAS a real answer. */
export function unansweredReason(answers: unknown): string | null {
  if (!answers || typeof answers !== "object") return null;
  const reason = (answers as Record<PropertyKey, unknown>)[QUESTION_UNANSWERED];
  return typeof reason === "string" ? reason : null;
}

/**
 * Followup-answer provenance marker (Symbol-keyed, non-enumerable -- same
 * idiom as QUESTION_UNANSWERED). A follow-up text resolved the pending
 * question (the worker-row grammar: the delegating manager's task_followup,
 * or a steering line the host routes through the same seam), so NOBODY sat
 * at the question's own channel. The websocket bridge stamps it on
 * answerWithText; the question tool checks it and labels the result entry
 * `mode: "followup-answer"` instead of claiming "interactive" just because
 * a watcher happened to be attached (isInteractive() is channel-driven).
 */
export const QUESTION_FOLLOWUP_ANSWER: unique symbol = Symbol("hotdog.questionFollowupAnswer");

/** Stamp the marker (returns the same object for call-site fluency). */
export function markAnswersFollowup(
  answers: Record<string, unknown>,
): Record<string, unknown> {
  Object.defineProperty(answers, QUESTION_FOLLOWUP_ANSWER, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return answers;
}

/** Read the marker: true only when a followup text WAS the answer. */
export function followupAnswered(answers: unknown): boolean {
  if (!answers || typeof answers !== "object") return false;
  return (answers as Record<PropertyKey, unknown>)[QUESTION_FOLLOWUP_ANSWER] === true;
}

/**
 * No-op input implementation that silently returns defaults.
 * Used in non-interactive modes (CI, pipes, one-shot).
 */
export class NoopInput implements QuestionSeam {
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
