import fsPromises from "node:fs/promises";
import {
  join,
  dirname,
  isAbsolute,
  resolve as resolveAbs,
  sep,
} from "node:path";
import { cwd } from "node:process";
import { YAML } from "bun";

/**
 * IO error class for file system operations.
 * Standalone -- does not depend on core error classes.
 */
export class IOError extends Error {
  static PathNotFound(requested) {
    return new IOError(`Path not found: ${requested}`);
  }

  static PathOutside(requested, boundary) {
    return new IOError(
      `Path '${requested}' is outside the allowed directory '${boundary}'. ` +
        "File operations are restricted to the boundary directory.",
    );
  }

  static NotWritable(dir, msg) {
    return new IOError(`Directory '${dir}' is not writable: ${msg}`);
  }

  static NotReadable(filePath) {
    return new IOError(`Path '${filePath}' does not exist or is not readable`);
  }
}

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

/**
 * Write a file, creating parent directories as needed.
 */
export async function writeFileWithParents(filePath, content) {
  const parentDir = dirname(filePath);
  if (parentDir && parentDir !== ".") {
    await fsPromises.mkdir(parentDir, { recursive: true });
  }
  await fsPromises.writeFile(filePath, content);
}

/**
 * Validate that a path is within the cwd boundary.
 */
export function validateCwdBoundary(filePath, cwdBoundary) {
  if (!cwdBoundary) return null;
  const boundaryResolved = resolveAbs(cwdBoundary);
  const fileResolved = resolveAbs(filePath);
  if (
    !fileResolved.startsWith(boundaryResolved + sep) &&
    fileResolved !== boundaryResolved
  ) {
    return `Error: path ${filePath} is outside cwd boundary ${cwdBoundary}`;
  }
  return null;
}

/**
 * String transform on paths to fix common llm typos
 * @param {string} strPath
 * @param {string} dirPath
 * @returns {[string, string]}
 */
export function correctCommonPathMistakes(strPath, dirPath) {
  if (strPath === "/.") strPath = "./";
  if (dirPath === "/.") dirPath = "./";

  if (strPath === "/**/*" || strPath === "/*") {
    strPath = strPath.substring(1);
  }

  if (strPath === "**/*" && (!dirPath || dirPath === "/")) {
    dirPath = "./";
  }

  return [strPath, dirPath];
}

/**
 * Resolve a path against cwdBoundary or workspaceRoot.
 */
export function resolvePath(filePath, cwdBoundary, workspaceRoot) {
  if (isAbsolute(filePath)) {
    return filePath;
  }
  if (cwdBoundary) {
    return resolveAbs(cwdBoundary, filePath);
  }
  if (workspaceRoot) {
    return resolveAbs(workspaceRoot, filePath);
  }
  return resolveAbs(filePath);
}

/**
 * Get file size in bytes.
 */
export async function fileSize(filePath) {
  const stats = await fsPromises.stat(filePath);
  return stats.size;
}

/**
 * Resolve a path and verify it stays within the cwd boundary.
 */
export async function resolvePathAndValidate(requested, cwdBoundary = null) {
  const resolved = resolveAbs(requested);

  try {
    await fsPromises.access(resolved);
  } catch {
    throw IOError.PathNotFound(requested);
  }

  if (cwdBoundary) {
    const boundaryResolved = resolveAbs(cwdBoundary);
    if (
      !resolved.startsWith(boundaryResolved + sep) &&
      resolved !== boundaryResolved
    ) {
      throw IOError.PathOutside(requested, cwdBoundary);
    }
  }

  return resolved;
}

/**
 * Check if a path is writable.
 */
export async function checkWritable(filePath) {
  const parentDir = dirname(filePath);

  if (parentDir && parentDir !== ".") {
    const tempPath = join(parentDir, ".hotdog-permission-test");
    try {
      await fsPromises.writeFile(tempPath, "");
      await fsPromises.unlink(tempPath);
    } catch (e) {
      throw IOError.NotWritable(parentDir, e.message);
    }
  }

  try {
    await fsPromises.access(filePath, fsPromises.constants.W_OK);
  } catch {
    // File doesn't exist — that's OK, we can create it
  }

  return true;
}

/**
 * Check if a path is readable.
 */
export async function checkReadable(filePath) {
  try {
    await fsPromises.access(filePath, fsPromises.constants.R_OK);
  } catch {
    throw IOError.NotReadable(filePath);
  }
  return true;
}
