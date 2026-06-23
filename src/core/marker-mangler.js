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

/** Generate a random alias suffix. */
function generateAlias() {
  let result = "";
  for (let i = 0; i < ALIAS_LENGTH; i++) {
    result += ALIAS_CHARS[Math.floor(Math.random() * ALIAS_CHARS.length)];
  }
  return result;
}

/** Build the mapping from protected prefixes to random aliases. */
function buildMappings() {
  const seen = new Set();
  const mappings = new Map();
  for (const prefix of PROTECTED_PREFIXES) {
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    mappings.set(prefix, `m_${generateAlias()}`);
  }
  return mappings;
}

/** Escape regex special characters. */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class MarkerMangler {
  constructor() {
    this._mappings = buildMappings();
    this._reverse = new Map();
    for (const [k, v] of this._mappings) {
      this._reverse.set(v, k);
    }
  }

  /** Escape protected marker names in text before sending to the model. */
  escape(text) {
    if (!text) return text;
    return this._transform(text, this._mappings);
  }

  /** Unescape escaped marker names in text received from the model. */
  unescape(text) {
    if (!text) return text;
    return this._transform(text, this._reverse);
  }

  /** Core transformation logic. */
  _transform(text, nameMap) {
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

  /** Escape user input before adding to conversation context. */
  escapeInput(text) {
    return this.escape(text);
  }

  /** Escape tool output before adding to conversation context. */
  escapeToolOutput(text) {
    return this.escape(text);
  }

  /** Unescape model output before displaying to user or writing to files. */
  unescapeOutput(text) {
    return this.unescape(text);
  }

  /** Unescape tool call arguments before executing the tool. */
  unescapeToolInput(text) {
    return this.unescape(text);
  }
}

export function createMarkerMangler() {
  return new MarkerMangler();
}
