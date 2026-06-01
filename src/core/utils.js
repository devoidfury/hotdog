import { YAML } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Parse YAML front matter from a markdown string.
 * Returns { frontMatter: object, body: string } or null if no front matter.
 */
export function parseFrontMatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const body = m[2] || "";
  const fm = YAML.parse(m[1]);
  return { frontMatter: fm, body };
}

/**
 * Load aspect files from a directory.
 * Files are named `<name>.aspect.md`.
 *
 * @param {string[]} aspectNames - Names of aspects to load.
 * @param {string} aspectsDir - Directory containing `.aspect.md` files.
 * @returns {{name: string, content: string}[]} Array of loaded aspects.
 */
export function loadAspects(aspectNames, aspectsDir) {
  if (!aspectNames || aspectNames.length === 0) return [];

  const aspects = [];

  for (const name of aspectNames) {
    const fileName = `${name}.aspect.md`;
    const filePath = join(aspectsDir, fileName);
    try {
      const content = readFileSync(filePath, "utf-8");
      const trimmed = content.trim();
      if (trimmed.length > 0) {
        aspects.push({ name, content: trimmed });
      }
    } catch {
      // Silent skip — aspect file not found or unreadable
    }
  }

  return aspects;
}

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
    if (source == null || typeof source !== "object") continue;

    for (const [key, value] of Object.entries(source)) {
      if (
        value != null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        result[key] != null &&
        typeof result[key] === "object" &&
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
    warnings.push(
      `${label} name '${name}' does not match ${dirName === "directory name" ? "directory" : "file"} name '${dirName}'`,
    );
  }
  if (!name || name.length === 0) {
    warnings.push(`${label} name is empty`);
  } else if (name.length > 64) {
    warnings.push(
      `${label} name '${name}' exceeds 64 characters (got ${name.length})`,
    );
  }
  if (name && (name.startsWith("-") || name.endsWith("-"))) {
    warnings.push(
      `${label} name '${name}' must not start or end with a hyphen`,
    );
  }
  if (name && name.includes("--")) {
    warnings.push(
      `${label} name '${name}' must not contain consecutive hyphens`,
    );
  }
  if (name) {
    for (const c of name) {
      if (!/^[a-z0-9-]$/.test(c)) {
        warnings.push(
          `${label} name '${name}' contains invalid character '${c}', only lowercase alphanumeric and hyphens allowed`,
        );
      }
    }
  }
  return warnings;
}
