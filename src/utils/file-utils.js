import fsPromises from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";
import { YAML } from "bun";

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
 * @param {string} [aspectsDir] - Directory containing `.aspect.md` files. Defaults to CWD/config/aspects.
 * @returns {{name: string, content: string}[]} Array of loaded aspects.
 */
export async function loadAspects(aspectNames, aspectsDir) {
  if (!aspectNames || aspectNames.length === 0) return [];

  const dir = aspectsDir || join(cwd(), "config", "aspects");

  const promises = aspectNames.map(async (name) => {
    const fileName = `${name}.aspect.md`;
    const filePath = join(dir, fileName);
    try {
      const content = await fsPromises.readFile(filePath, "utf-8");
      const trimmed = content.trim();
      if (trimmed.length > 0) {
        return { name, content: trimmed };
      }
    } catch {
      // Silent skip — aspect file not found or unreadable
    }
    return null;
  });

  const results = await Promise.all(promises);
  return results.filter(Boolean);
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
