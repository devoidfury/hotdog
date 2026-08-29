const CAMEL_CASE_REGEX = /[_-]([a-z])/g;
const FLAG_PREFIX_REGEX = /^-+/;

const _camelTransform = (_: string, c: string): string => c.toUpperCase();

/**
 * Convert snake_case or kebab-case string to camelCase.
 * Removes underscores and hyphens, then capitalizes the next letter.
 */
export function camelCase(str: string): string {
  return str.replace(CAMEL_CASE_REGEX, _camelTransform);
}

/** Map a long flag name ("show-token-use") to its config key ("showTokenUse"). */
export function parseCliFlagKey(str: string): string {
  return camelCase(str.replace(FLAG_PREFIX_REGEX, ""));
}

export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (match) => XML_ENTITIES[match] ?? match);
}

const XML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};
