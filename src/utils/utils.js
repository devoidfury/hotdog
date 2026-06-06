import { readFileSync } from "node:fs";
import { join } from "node:path";

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
