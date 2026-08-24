// Marker mangler — injection prevention for protected XML markers.
//
// Randomly aliases protected marker names before sending to the model,
// and reverses the transformation on output.

// Core-owned protected prefixes: markers no ToolFormat owns. Format-specific
// element names (e.g. the XML format's tool/output/error) enter the union via
// ToolFormat.markers, assembled at session entry points and passed to the
// constructor or addPrefixes().
export const CORE_PROTECTED_PREFIXES = [
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
// Rejection bound: largest byte value keeping `byte % ALIAS_CHARS.length`
// unbiased (256 is not a multiple of 34, so a raw modulo would skew low values).
const ALIAS_BYTE_MAX = 256 - (256 % ALIAS_CHARS.length);

function generateAlias(): string {
  const buf = new Uint8Array(ALIAS_LENGTH);
  const chars: string[] = [];
  while (chars.length < ALIAS_LENGTH) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < ALIAS_BYTE_MAX) {
        chars.push(ALIAS_CHARS[b % ALIAS_CHARS.length]!);
      }
      if (chars.length === ALIAS_LENGTH) break;
    }
  }
  return chars.join("");
}

/**
 * Build a regex that matches a mangler alias literal
 * (m_ + exactly one alias body, i.e. ALIAS_LENGTH alias chars).
 *
 * A fresh regex is returned per call so global-flag lastIndex state is
 * never shared between callers. The match must not be embedded in a longer
 * identifier (lookbehind) nor be a prefix of a longer alias-char run
 * (lookahead), so only exact alias-length runs count.
 */
export function buildAliasPattern(): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9_])m_[${ALIAS_CHARS}]{${ALIAS_LENGTH}}(?![a-z0-9])`,
    "g",
  );
}

function buildMappings(prefixes: readonly string[]): Map<string, string> {
  const seen = new Set<string>();
  const mappings = new Map<string, string>();
  for (const prefix of prefixes) {
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    mappings.set(prefix, `m_${generateAlias()}`);
  }
  return mappings;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class MarkerMangler {
  #mappings: Map<string, string>;
  #reverse: Map<string, string>;

  /**
   * @param prefixes - Protected marker prefixes to alias. Defaults to the
   *   core list (CORE_PROTECTED_PREFIXES) so existing call sites keep working;
   *   session entry points pass the derived union (core + active ToolFormat
   *   markers + model/provider controlTokens).
   */
  constructor(prefixes: readonly string[] = CORE_PROTECTED_PREFIXES) {
    this.#mappings = buildMappings(prefixes);
    this.#reverse = new Map<string, string>();
    for (const [k, v] of this.#mappings) {
      this.#reverse.set(v, k);
    }
  }

  /**
   * Add prefixes mid-session (e.g. on model switch when the token set grows).
   * Existing aliases are untouched; only new prefixes get fresh aliases.
   */
  addPrefixes(newOnes: readonly string[]): void {
    for (const prefix of newOnes) {
      if (!prefix || this.#mappings.has(prefix)) continue;
      const alias = `m_${generateAlias()}`;
      this.#mappings.set(prefix, alias);
      this.#reverse.set(alias, prefix);
    }
  }

  protectedPrefixes(): string[] {
    return Array.from(this.#mappings.keys());
  }

  /** Escape protected marker names in text before sending to the model. */
  escape(text: string | null | undefined) {
    if (!text) return text;
    return this.#transform(text, this.#mappings);
  }

  /** Unescape escaped marker names in text received from the model. */
  unescape(text: string | null | undefined) {
    if (!text) return text;
    return this.#transform(text, this.#reverse);
  }

  #transform(text: string, nameMap: Map<string, string>): string {
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
}

