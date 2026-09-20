// Question answer resolution -- the single source of truth for how a
// question's answer is decided from the user's input: free text vs option
// selection vs default, strict options (allowOther === false), and the
// required check. Both the interactive CLI prompt loop and the WebUI
// question card call this; each UI keeps only its own I/O around it.

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
 *   free text that doesn't match an option is rejected. A default outside
 *   the options is not applied (it contradicts the strictness).
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
