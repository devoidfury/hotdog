// oa-agent — library entry point.
// Re-exports core modules for programmatic use.

export * from './config.js';
export * from './context/index.js';
export * from './llm_client/client.js';
export * from './tools/index.js';
export * from './agent/agent.js';
export * from './ui/cli.js';

/**
 * Deep-merge objects together, like Object.assign but recursive.
 *
 * - Nested plain objects are merged key-by-key.
 * - Arrays (and other non-object values) from later sources replace earlier ones.
 * - null/undefined sources are skipped.
 * - Returns a new object — source objects are not mutated.
 */
export function deepMerge(...sources) {
  const result = {};

  for (const source of sources) {
    if (source == null || typeof source !== 'object') continue;

    for (const [key, value] of Object.entries(source)) {
      if (
        value != null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        result[key] != null &&
        typeof result[key] === 'object' &&
        !Array.isArray(result[key])
      ) {
        // Both are plain objects → recurse
        result[key] = deepMerge(result[key], value);
      } else {
        // Arrays, primitives, or first-seen value → replace
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Validate a nameable entity (skill, prompt) per spec constraints.
 * Returns warnings — loading still proceeds with warnings.
 */
export function validateNameable(name, label, dirName) {
  const warnings = [];

  if (name && name !== dirName) {
    warnings.push(`${label} name '${name}' does not match ${dirName === 'directory name' ? 'directory' : 'file'} name '${dirName}'`);
  }
  if (!name || name.length === 0) {
    warnings.push(`${label} name is empty`);
  } else if (name.length > 64) {
    warnings.push(`${label} name '${name}' exceeds 64 characters (got ${name.length})`);
  }
  if (name && (name.startsWith('-') || name.endsWith('-'))) {
    warnings.push(`${label} name '${name}' must not start or end with a hyphen`);
  }
  if (name && name.includes('--')) {
    warnings.push(`${label} name '${name}' must not contain consecutive hyphens`);
  }
  if (name) {
    for (const c of name) {
      if (!/^[a-z0-9-]$/.test(c)) {
        warnings.push(`${label} name '${name}' contains invalid character '${c}', only lowercase alphanumeric and hyphens allowed`);
      }
    }
  }
  return warnings;
}
