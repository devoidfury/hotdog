const CAMEL_CASE_REGEX = /[_-]([a-z])/g;
const FLAG_PREFIX_REGEX = /^-+/;

const _camelTransform = (_: string, c: string): string => c.toUpperCase();

/**
 * Convert snake_case or kebab-case string to camelCase.
 * Replaces underscores and hyphens with spaces, then capitalizes the first letter.
 */
export function camelCase(str: string): string {
  return str.replace(CAMEL_CASE_REGEX, _camelTransform);
}

/**
 * Parse a CLI flag key, removing hyphens and converting to camelCase.
 * Used to map long flag names (e.g., "show-token-use") to object keys (e.g., "showTokenUse").
 */
export function parseCliFlagKey(str: string): string {
  return camelCase(str.replace(FLAG_PREFIX_REGEX, ""));
}
