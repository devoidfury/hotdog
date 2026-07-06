const CAMEL_CASE_REGEX = /[_-]([a-z])/g;
const FLAG_PREFIX_REGEX = /^-+/;

const _camelTransform = (_, c) => c.toUpperCase();
/**
 * Convert snake_case or kebab-case string to camelCase.
 * Replaces underscores and hyphens with spaces, then capitalizes the first letter.
 *
 * @param {string} str - The string to convert.
 * @returns {string} The camelCase version of the input.
 */
export function camelCase(str) {
  return str.replace(CAMEL_CASE_REGEX, _camelTransform);
}

/**
 * Parse a CLI flag key, removing hyphens and converting to camelCase.
 * Used to map long flag names (e.g., "show-token-use") to object keys (e.g., "showTokenUse").
 *
 * @param {string} str - Flag string (may start with hyphens).
 * @returns {string} The camelCase key.
 */
export function parseCliFlagKey(str) {
  return camelCase(str.replace(FLAG_PREFIX_REGEX, ""));
}
