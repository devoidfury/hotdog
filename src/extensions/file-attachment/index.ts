import fsPromises from "node:fs/promises";
import { resolve as resolveAbs, isAbsolute } from "node:path";
import { cwd } from "node:process";
import { HOOKS } from "@core/hooks.ts";
import { OUTPUT_EVENT } from "@core/context/output.ts";
import { logger } from "@core/logger.ts";
import { formatError } from "@core/error.ts";
import { type CoreContext, type ExtensionInstance, getExtensionConfig } from "@core/extensions/types.ts";
import { Workspace, PathEscapeError } from "@utils/workspace.ts";

import { matcher, completion } from "./completions.ts";

// Lookbehind so "tom@furycodes.com" doesn't match; only bare @path refs do.
const FILE_REF_RE = /(?<!\w)@([a-zA-Z0-9._\/\+-]+)\b/g;

/**
 * Returns null when the path is rejected by the workspace boundary, or when
 * the boundary check itself fails for any other reason -- a broken check
 * must fail closed, never silently widen the boundary. The unbounded
 * resolution below only runs when no workspace was supplied at all.
 * @internal Exported for testing.
 */
export function resolveFilePath(filePath: string, workspace: Workspace | null): string | null {
  if (workspace) {
    try {
      return workspace.resolveSafe(filePath);
    } catch (e: unknown) {
      if (e instanceof PathEscapeError) {
        logger.debug(`file-attachment: path escape rejected for '${filePath}'`);
      } else {
        logger.warn(`file-attachment: boundary check failed for '${filePath}': ${formatError(e)}; refusing path`);
      }
      return null;
    }
  }
  if (isAbsolute(filePath)) {
    return filePath;
  }
  return resolveAbs(cwd(), filePath);
}

async function readFileContent(
  resolvedPath: string,
  requestedPath: string,
  maxFileSize: number,
): Promise<{ content: string; path: string } | null> {
  try {
    const stats = await fsPromises.stat(resolvedPath);

    if (stats.isDirectory()) {
      logger.debug(`file-attachment: '${requestedPath}' is a directory, skipping`);
      return null;
    }

    if (stats.size > maxFileSize) {
      logger.debug(`file-attachment: '${requestedPath}' is too large (${stats.size} bytes), skipping`);
      return null;
    }

    const content = await fsPromises.readFile(resolvedPath, "utf-8");
    return { content, path: requestedPath };
  } catch (e) {
    logger.debug(`file-attachment: failed to read '${requestedPath}': ${(e as Error).message}`);
    return null;
  }
}

async function expandFileReferences(
  text: string,
  workspace: Workspace | null,
  maxFileSize: number,
  maxFiles: number,
): Promise<{
  expanded: string;
  attachedFiles: Array<{ content: string; path: string }>;
}> {
  const attachedFiles: Array<{ content: string; path: string }> = [];

  // Reset regex lastIndex before using it (global regex maintains state)
  FILE_REF_RE.lastIndex = 0;

  if (!FILE_REF_RE.test(text)) {
    return { expanded: text, attachedFiles };
  }

  // Reset regex lastIndex again before exec
  FILE_REF_RE.lastIndex = 0;

  const errors: string[] = [];
  let boundaryRejections = 0;
  let match: RegExpExecArray | null;

  while ((match = FILE_REF_RE.exec(text)) !== null && attachedFiles.length + errors.length < maxFiles) {
    const requestedPath = match[1];
    if (!requestedPath) continue;
    const resolvedPath = resolveFilePath(requestedPath, workspace);

    if (resolvedPath === null) {
      errors.push(requestedPath);
      boundaryRejections++;
      continue;
    }

    const result = await readFileContent(resolvedPath, requestedPath, maxFileSize);
    if (result) {
      attachedFiles.push(result);
    } else {
      errors.push(requestedPath);
    }
  }

  // If no files were found, return original text. Boundary rejections are
  // the exception: they always get a note, even when nothing attached.
  if (attachedFiles.length === 0 && boundaryRejections === 0) {
    return { expanded: text, attachedFiles };
  }

  const blocks: string[] = [];
  for (const file of attachedFiles) {
    const tag = "file-include";
    const block = `<${tag}>\n<path>${file.path}</path>\n<contents>\n${file.content}</contents>\n</${tag}>`;
    blocks.push(block);
  }

  let expanded = text;
  if (blocks.length > 0) {
    expanded += `\n\n${blocks.join("\n\n")}`;
  }

  if (errors.length > 0) {
    expanded += `\n\n[File attachment note: could not read the following files: ${errors.join(", ")}]`;
  }

  return { expanded, attachedFiles };
}

export function create(core: CoreContext): ExtensionInstance {
  const config = getExtensionConfig<{
    maxFileSize: number;
    maxFiles: number;
  }>(core, "fileAttachment");
  const maxFileSize = config.maxFileSize;
  const maxFiles = config.maxFiles;

  core.completion.register(matcher, completion, "file-attachment:path-completion");

  return {
    hooks: {
      [HOOKS.INPUT]: async ({ text, agent }) => {
        const roots =
          (agent?.config?.workspaceRoots as string[] | undefined) ?? [cwd()];
        // null/undefined both mean "unconfigured" -- fall back to the defaults.
        const deny = agent?.config?.workspaceDeny as readonly string[] | null | undefined;
        const workspace = deny != null ? new Workspace(roots, deny) : new Workspace(roots);

        const result = await expandFileReferences(text, workspace, maxFileSize, maxFiles);

        if (result.expanded !== text) {
          const sink = agent?.sink;
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
