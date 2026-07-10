// Marker mangler — injection prevention for protected XML markers.
//
// Randomly aliases protected marker names before sending to the model,
// and reverses the transformation on output.

const PROTECTED_PREFIXES = [
  "tool-call",
  "tool_call",
  "function",
  "skill",
  "file-include",
  "system-notice",
  "previous-context-summary",
  "thinking",
  "reasoning",
  "task-result",
];

const ALIAS_LENGTH = 16;
const ALIAS_CHARS = "abcdefghijkmnopqrstuvwxyz23456789";

/**
 * Generate a random alias suffix.
 * @private
 * @returns Random alias string.
 */
function generateAlias(): string {
  let result = "";
  for (let i = 0; i < ALIAS_LENGTH; i++) {
    result += ALIAS_CHARS[Math.floor(Math.random() * ALIAS_CHARS.length)];
  }
  return result;
}

/**
 * Build the mapping from protected prefixes to random aliases.
 * @private
 * @returns Mapping from original names to aliases.
 */
function buildMappings(): Map<string, string> {
  const seen = new Set<string>();
  const mappings = new Map<string, string>();
  for (const prefix of PROTECTED_PREFIXES) {
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    mappings.set(prefix, `m_${generateAlias()}`);
  }
  return mappings;
}

/**
 * Escape regex special characters.
 * @private
 * @param str - String to escape.
 * @returns Escaped string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class MarkerMangler {
  _mappings: Map<string, string>;
  _reverse: Map<string, string>;

  /**
   * @param options
   * @param options.preserveCase - Preserve case when mangling
   */
  constructor(options: { preserveCase?: boolean } = {}) {
    this._mappings = buildMappings();
    this._reverse = new Map<string, string>();
    for (const [k, v] of this._mappings) {
      this._reverse.set(v, k);
    }
  }

  /**
   * Escape protected marker names in text before sending to the model.
   * @param text - Text to escape.
   * @returns Escaped text.
   */
  escape(text: string | null | undefined) {
    if (!text) return text;
    return this._transform(text, this._mappings);
  }

  /**
   * Unescape escaped marker names in text received from the model.
   * @param text - Text to unescape.
   * @returns Unescaped text.
   */
  unescape(text: string | null | undefined) {
    if (!text) return text;
    return this._transform(text, this._reverse);
  }

  /**
   * Core transformation logic.
   * @private
   * @param text - Text to transform.
   * @param nameMap - Mapping from original names to aliases.
   * @returns Transformed text.
   */
  _transform(text: string, nameMap: Map<string, string>): string {
    let result = text;

    for (const [origName, newName] of nameMap) {
      const escaped = escapeRegex(origName);

      // Opening tag: <name>, <name attr=, <name /
      result = result.replace(
        new RegExp(`(<)(${escaped})([>\\s/])`, "g"),
        `\$1${newName}\$3`,
      );

      // Closing tag: </name>, </name attr=, </name /
      result = result.replace(
        new RegExp(`(</)(${escaped})([>\\s/])`, "g"),
        `\$1${newName}\$3`,
      );

      // Partial/unclosed at end: <name or </name
      result = result.replace(
        new RegExp(`(<)(${escaped})$`, "gm"),
        `\$1${newName}`,
      );
      result = result.replace(
        new RegExp(`(</)(${escaped})$`, "gm"),
        `\$1${newName}`,
      );

      // Prefix match: <name-something> (e.g. <m_abc123-extra>)
      result = result.replace(
        new RegExp(`(<)(${escaped})(-[^>\\s]*)([>\\s/])`, "g"),
        `\$1${newName}\$3\$4`,
      );
      result = result.replace(
        new RegExp(`(</)(${escaped})(-[^>\\s]*)([>\\s/])`, "g"),
        `\$1${newName}\$3\$4`,
      );
    }

    return result;
  }

  /**
   * Escape user input before adding to conversation context.
   * @param text - User input text.
   * @returns Escaped text.
   */
  escapeInput(text: string) {
    return this.escape(text);
  }

  /**
   * Escape tool output before adding to conversation context.
   * @param text - Tool output text.
   * @returns Escaped text.
   */
  escapeToolOutput(text: string) {
    return this.escape(text);
  }

  /**
   * Unescape model output before displaying to user or writing to files.
   * @param text - Model output text.
   * @returns Unescaped text.
   */
  unescapeOutput(text: string) {
    return this.unescape(text);
  }

  /**
   * Unescape tool call arguments before executing the tool.
   * @param text - Tool call arguments.
   * @returns Unescaped arguments.
   */
  unescapeToolInput(text: string) {
    return this.unescape(text);
  }
}

/**
 * Create a new MarkerMangler instance.
 *
 * @returns New marker mangler.
 */
export function createMarkerMangler(): MarkerMangler {
  return new MarkerMangler();
}
