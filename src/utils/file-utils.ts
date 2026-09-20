import fsPromises from "node:fs/promises";
import { dirname, join } from "node:path";
import { cwd } from "node:process";
import { YAML } from "bun";
import { logger } from "./logger.ts";
import { ToolResult, parseToolInput } from "@core/extensions/tool-utils.ts";
import { PathEscapeError } from "./workspace.ts";
import type { Workspace } from "./workspace.ts";
import type { ToolContext } from "@core/extensions/types.ts";

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

/**
 * Shared skeleton for the workspace write tools (append, overwrite):
 * validate args, resolve within the workspace, create parent dirs, run the
 * write, and shape the result. Error strings are byte-identical to what the
 * tools returned before sharing this helper.
 */
export async function writeWithinWorkspace(
  input: string | Record<string, unknown> | null,
  ctx: ToolContext,
  opts: {
    writeFn: (path: string, content: string) => Promise<void>;
    writeErrorLabel: string;
    resultKey: string;
    /** Rewrite the content before writing (e.g. re-apply the file's EOL/BOM). */
    prepareContent?: (path: string, content: string) => Promise<string>;
  },
): Promise<ToolResult> {
  const rawArgs = parseToolInput(input);
  if (!rawArgs || !rawArgs.path || rawArgs.content === undefined) {
    return ToolResult.err(
      "Error parsing arguments: expected a JSON object with required 'path' and 'content' strings",
    );
  }

  const filePath = rawArgs.path as string;
  const content = rawArgs.content as string;
  const workspace = ctx.get("workspace") as Workspace;

  let resolvedPath: string;
  try {
    resolvedPath = workspace.resolveSafe(filePath);
  } catch (e: unknown) {
    if (e instanceof PathEscapeError) {
      return ToolResult.err(e.message);
    }
    return ToolResult.err(`Error resolving path: ${(e as Error).message}`);
  }

  const dir = dirname(resolvedPath);
  const mkdirError = await safeMkdir(dir);
  if (mkdirError) {
    return mkdirError;
  }

  const finalContent = opts.prepareContent
    ? await opts.prepareContent(resolvedPath, content)
    : content;

  try {
    await opts.writeFn(resolvedPath, finalContent);
  } catch (e: unknown) {
    return ToolResult.err(`${opts.writeErrorLabel}: ${(e as Error).message}`);
  }

  return ToolResult.ok(
    JSON.stringify({
      path: filePath,
      [opts.resultKey]: Buffer.byteLength(finalContent, "utf-8"),
    }),
  );
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

// ── BOM / line-ending fidelity ───────────────────────────────────────────────
// Model-facing text is LF, BOM-free. Detect the file's real style before
// matching and re-apply it on write, or one edit to a CRLF/BOM file silently
// rewrites the whole file (Windows consumers also treat a lost BOM as an
// encoding change).

export interface FileStyle {
  bom: boolean;
  eol: "\r\n" | "\n";
}

export function detectFileStyle(content: string): FileStyle {
  return {
    bom: content.charCodeAt(0) === 0xfeff,
    eol: content.includes("\r\n") ? "\r\n" : "\n",
  };
}

/** Normalize to LF, BOM-free text for matching/editing. */
export function stripFileStyle(content: string): string {
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  return content.replaceAll("\r\n", "\n");
}

export function applyFileStyle(content: string, style: FileStyle): string {
  if (style.eol === "\r\n") {
    content = content.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
  }
  return style.bom ? `\uFEFF${content}` : content;
}

/**
 * Style of an existing file, read from its first 64 KB (BOM is at the front;
 * leading EOLs represent the file for our purposes). Null when the file does
 * not exist. The boundary cannot split a \r\n pair (both single-byte).
 */
export async function detectFileStyleAt(path: string): Promise<FileStyle | null> {
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | null = null;
  try {
    handle = await fsPromises.open(path, "r");
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return detectFileStyle(buf.toString("utf-8", 0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
