import fsPromises from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";
import { YAML } from "bun";
import { logger } from "../core/logger.ts";
import { ToolResult } from "../core/extensions/tool-utils.ts";

export interface ParsedFrontMatter {
  frontMatter?: Record<string, unknown>;
  body?: string;
}

/** Parse YAML front matter from a markdown string. */
export function parseFrontMatter(content: string): ParsedFrontMatter | null {
  const m = content.replaceAll("\r", "").match(FRONTMATTER_RE);
  if (!m || !m[1]) return null;
  const body = m[2] || "";
  const fm = YAML.parse(m[1]) as Record<string, unknown> | undefined;
  return { frontMatter: fm, body };
}
const FRONTMATTER_RE = /^-{3,}\n([\s\S]*?)\n-{3,}\n?([\s\S]*)$/;

/** Load aspect files from a directory. Files are named `<name>.aspect.md`. */
export async function loadAspects(
  aspectNames: string[] | null,
  aspectsDir?: string,
): Promise<{ name: string; content: string }[]> {
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
    } catch (e) {
      logger.warn(`Failed to load aspect '${name}' from '${filePath}'`, {
        error: (e as Error).message,
      });
    }
    return null;
  });

  const results = await Promise.all(promises);
  return results.filter((r): r is { name: string; content: string } => r !== null);
}

/**
 * Validate a nameable entity (skill, prompt) per spec constraints.
 * Returns warnings — loading still proceeds with warnings.
 */
export function validateNameable(name: string | null | undefined, label: string, dirName: string): string[] {
  const warnings: string[] = [];

  if (name && name !== dirName) {
    warnings.push(
      `${label} name '${name}' does not match ${dirName === "directory name" ? "directory" : "file"} name '${dirName}'`,
    );
  }
  if (!name || name.length === 0) {
    warnings.push(`${label} name is empty`);
  } else if (name.length > 64) {
    warnings.push(`${label} name '${name}' exceeds 64 characters (got ${name.length})`);
  }
  if (name && (name.startsWith("-") || name.endsWith("-"))) {
    warnings.push(`${label} name '${name}' must not start or end with a hyphen`);
  }
  if (name && name.includes("--")) {
    warnings.push(`${label} name '${name}' must not contain consecutive hyphens`);
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

/** Create a directory (and parents), returning a ToolResult error instead of throwing. */
export async function safeMkdir(dir: string): Promise<ToolResult | null> {
  try {
    await fsPromises.mkdir(dir, { recursive: true });
    return null;
  } catch (e: unknown) {
    return ToolResult.err(`Error creating directory: ${(e as Error).message}`);
  }
}

/** String transform on paths to fix common llm typos. */
export function correctCommonPathMistakes(strPath: string, dirPath?: string): [string, string | undefined] {
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
