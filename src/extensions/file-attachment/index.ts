// File Attachment Extension
// Expands @filepath references in user input to file contents in <file-include> format.

import fsPromises from "node:fs/promises";
import { resolve as resolveAbs, isAbsolute } from "node:path";
import { cwd } from "node:process";
import { HOOKS } from "../../core/hooks.ts";
import { OUTPUT_EVENT } from "../../core/context/output.ts";
import { logger } from "../../core/logger.ts";
import {
  CoreContext,
  ExtensionInstance,
  getExtensionConfig,
} from "../../core/extensions/types.ts";

// Pattern to match @filepath references
// Matches @ followed by path characters (alphanumeric, dots, slashes, hyphens, underscores, plus)
const FILE_REF_RE = /@([a-zA-Z0-9._\/\+-]+)\b/g;

/**
 * Resolve a relative path against the workspace root or cwd.
 */
function resolveFilePath(
  filePath: string,
  cwdBoundary: string | null,
  workspaceRoot: string | null,
): string {
  if (isAbsolute(filePath)) {
    return filePath;
  }
  if (cwdBoundary) {
    return resolveAbs(cwdBoundary, filePath);
  }
  if (workspaceRoot) {
    return resolveAbs(workspaceRoot, filePath);
  }
  return resolveAbs(cwd(), filePath);
}

/**
 * Read a file and return its content, or null if it cannot be read.
 */
async function readFileContent(
  resolvedPath: string,
  requestedPath: string,
  maxFileSize: number,
): Promise<{ content: string; path: string } | null> {
  try {
    const stats = await fsPromises.stat(resolvedPath);

    if (stats.isDirectory()) {
      logger.debug(
        `file-attachment: '${requestedPath}' is a directory, skipping`,
      );
      return null;
    }

    if (stats.size > maxFileSize) {
      logger.debug(
        `file-attachment: '${requestedPath}' is too large (${stats.size} bytes), skipping`,
      );
      return null;
    }

    const content = await fsPromises.readFile(resolvedPath, "utf-8");
    return { content, path: requestedPath };
  } catch (e) {
    logger.debug(
      `file-attachment: failed to read '${requestedPath}': ${(e as Error).message}`,
    );
    return null;
  }
}

/**
 * Expand @filepath references in text to file content blocks.
 */
async function expandFileReferences(
  text: string,
  cwdBoundary: string | null,
  workspaceRoot: string | null,
  maxFileSize: number,
  maxFiles: number,
): Promise<{ expanded: string; attachedFiles: Array<{ content: string; path: string }> }> {
  const attachedFiles: Array<{ content: string; path: string }> = [];

  // Reset regex lastIndex before using it (global regex maintains state)
  FILE_REF_RE.lastIndex = 0;

  // Check if there are any file references
  if (!FILE_REF_RE.test(text)) {
    return { expanded: text, attachedFiles };
  }

  // Reset regex lastIndex again before exec
  FILE_REF_RE.lastIndex = 0;

  const errors: string[] = [];
  let match: RegExpExecArray | null;

  // Collect all file references
  while (
    (match = FILE_REF_RE.exec(text)) !== null &&
    attachedFiles.length + errors.length < maxFiles
  ) {
    const requestedPath = match[1];
    if (!requestedPath) continue;
    const resolvedPath = resolveFilePath(
      requestedPath,
      cwdBoundary,
      workspaceRoot,
    );

    const result = await readFileContent(
      resolvedPath,
      requestedPath,
      maxFileSize,
    );
    if (result) {
      attachedFiles.push(result);
    } else {
      errors.push(requestedPath);
    }
  }

  // If no files were found, return original text
  if (attachedFiles.length === 0) {
    return { expanded: text, attachedFiles };
  }

  // Build content blocks appended at the bottom
  const blocks: string[] = [];
  for (const file of attachedFiles) {
    const tag = 'file-include';
    const block = `<${tag}>\n<path>${file.path}</path>\n<contents>\n${file.content}</contents>\n</${tag}>`;
    blocks.push(block);
  }

  let expanded = text;
  if (blocks.length > 0) {
    expanded += `\n\n${blocks.join("\n\n")}`;
  }

  // Add error notes for files that couldn't be read
  if (errors.length > 0) {
    expanded += `\n\n[File attachment note: could not read the following files: ${errors.join(", ")}]`;
  }

  return { expanded, attachedFiles };
}

/**
 * Create the file-attachment extension.
 */
export function create(core: CoreContext): ExtensionInstance {
  const config = getExtensionConfig<{
    maxFileSize?: number;
    maxFiles?: number;
  }>(core, "fileAttachment");
  const maxFileSize = config.maxFileSize;
  const maxFiles = config.maxFiles;

  return {
    hooks: {
      [HOOKS.INPUT]: async ({ text, agent }) => {
        // Get workspace boundaries from agent context, fall back to cwd
        const ctx = (agent as { context?: { get: (k: string) => unknown } })
          ?.context;
        const cwdBoundary = (ctx?.get("cwdBoundary") as string | null) ?? null;
        const workspaceRoot =
          (ctx?.get("workspaceRoot") as string | null) ?? null;

        const result = await expandFileReferences(
          text,
          cwdBoundary,
          workspaceRoot,
          maxFileSize,
          maxFiles,
        );

        if (result.expanded !== text) {
          // Emit system message for each attached file
          const sink = (agent as { sink?: { emit: (e: unknown) => void } })
            ?.sink;
          for (const file of result.attachedFiles) {
            sink?.emit({
              type: OUTPUT_EVENT.SYSTEM_MESSAGE,
              content: `- file attached: ${file.path}`,
              detail: file.content,
            });
          }
          return { action: "transform", text: result.expanded };
        }

        return { action: "continue" };
      },
    },
  };
}
