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

/** True when a and b differ by at most one edit (insert/delete/substitute). */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;
  let i = 0;
  while (i < short.length && long[i] === short[i]) i++;
  if (i === short.length) return true; // remainder = one insert
  if (long.length === short.length) {
    return long.slice(i + 1) === short.slice(i + 1); // one substitution
  }
  return long.slice(i + 1) === short.slice(i); // one deletion
}

/**
 * Fuzzy "did you mean" suggestions shared by every unknown-input path (CLI
 * flags, tool names, subcommands): normalized exact match, then prefix/
 * substring near-matches, then one-edit typos (a dropped char like "modl"
 * for "model" defeats substring matching alone). The highest-confidence
 * tier that yields anything wins, capped at `limit`.
 *
 * `normalize` maps the target and each candidate to a comparison key (e.g.
 * lowercase, strip separators/flag dashes); candidates keep their given
 * order in the result.
 */
export function suggestCandidates(
  target: string,
  candidates: string[],
  options: { normalize?: (s: string) => string; limit?: number } = {},
): string[] {
  const normalize = options.normalize ?? ((s: string) => s);
  const limit = options.limit ?? 5;
  const t = normalize(target);
  if (!t) return [];

  const keys = candidates.map((c) => [c, normalize(c)] as const);

  let matches = keys.filter(([, k]) => k === t);
  // The substring tier needs >2 chars on BOTH sides: a 1-2 char target ("o")
  // is a substring of nearly every name, so without the target guard tier 2
  // returns `limit` near-arbitrary candidates. Tiny targets fall through to
  // the one-edit tier, which still catches e.g. "ca" -> "cat".
  if (matches.length === 0 && t.length > 2) {
    matches = keys.filter(([, k]) => k.length > 2 && (k.includes(t) || t.includes(k)));
  }
  if (matches.length === 0) {
    matches = keys.filter(([, k]) => withinOneEdit(k, t));
  }
  return matches.slice(0, limit).map(([c]) => c);
}
