// Shared utilities for the WebUI frontend.
// Re-exports reactiveState/effect from the shared utils so the UI doesn't
// duplicate the atom implementation.

export { reactiveState, effect, type Atom } from "../../../utils/reactive-state.ts";


// ── Formatting & sanitisation ───────────────────────────────────────────────

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

export function shortId(sessionId: string | null | undefined): string {
  return sessionId ? sessionId.slice(0, 8) : "???";
}

export function sanitize(str: string | null | undefined): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&#34;")
    .replace(/'/g, "&#39;");
}

export function escapeJson(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}


// ── Question answer resolution ──────────────────────────────────────────────
// Pure helper shared by the interactive question card (message-list.ts) and
// its unit tests. Mirrors the CLI's answer-selection semantics: free text
// wins over option selection, which wins over the default.

export interface QuestionField {
  key?: string;
  prompt?: string;
  options?: string[];
  default?: string;
  required?: boolean;
  allowOther?: boolean;
}

export interface QuestionSelection {
  text: string;
  selectedOption: string | null;
}

export interface QuestionResolution {
  value: string;
  error: string | null;
}

/**
 * Resolve a single question's answer from the user's selections.
 *
 * Rules:
 * - With options and allowOther (default): free text is accepted as-is;
 *   otherwise the selected option, then the default, then empty.
 * - With options and allowOther === false: only option text is accepted;
 *   free text that doesn't match an option is rejected.
 * - Without options: free text, then the default, then empty.
 * - required (default true) rejects an empty final value.
 */
export function resolveQuestionAnswer(
  q: QuestionField,
  sel: QuestionSelection,
): QuestionResolution {
  const text = sel.text.trim();
  const options = q.options || [];
  const allowOther = q.allowOther !== false;
  const defaultValue = q.default ?? "";
  let value = "";
  let error: string | null = null;

  if (options.length > 0 && !allowOther) {
    if (text !== "" && !options.includes(text)) {
      error = `Must be one of: ${options.join(", ")}`;
    } else if (text !== "") {
      value = text;
    } else if (sel.selectedOption) {
      value = sel.selectedOption;
    } else if (defaultValue && options.includes(defaultValue)) {
      value = defaultValue;
    }
  } else if (options.length > 0) {
    value = text !== "" ? text : (sel.selectedOption ?? defaultValue);
  } else {
    value = text !== "" ? text : defaultValue;
  }

  if (!error && q.required !== false && value === "") {
    error = "This question is required.";
  }

  return { value, error };
}
