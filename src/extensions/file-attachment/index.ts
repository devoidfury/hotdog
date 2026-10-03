import fsPromises from "node:fs/promises";
import { resolve as resolveAbs, isAbsolute } from "node:path";
import { cwd } from "node:process";
import { HOOKS } from "@core/hooks.ts";
import { logger } from "@utils/logger.ts";
import { formatError } from "@core/error.ts";
import { type CoreContext, type ExtensionInstance, getExtensionConfig } from "@core/extensions/types.ts";
import { Workspace, PathEscapeError } from "@utils/workspace.ts";

import { matcher, completion } from "./completions.ts";
import { modelAcceptsImages } from "@core/config/providers.ts";
// Same 10MB image cap as the read tool: keeping one constant means @refs and
// read never disagree on which images are attachable.
import { DEFAULT_MAX_IMAGE_SIZE } from "@extensions/core-tools/defaults.ts";
import type { ImageAttachment } from "@core/context/message.ts";

// Lookbehind so "tom@furycodes.com" doesn't match; only bare @path refs do.
const FILE_REF_RE = /(?<!\w)@([a-zA-Z0-9._\/\+-]+)\b/g;

/** Image refs ride the Message `images` field instead of inlining (utf-8 would corrupt them).
 * Extension doubles as the MIME guess; content sniffing deliberately skipped. */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function imageMimeType(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return null;
  return IMAGE_MIME[filePath.slice(dot + 1).toLowerCase()] ?? null;
}

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

/** A text file's content, or an image encoded for the Message images field. */
type AttachedFile =
  | { kind: "text"; path: string; content: string }
  | { kind: "image"; path: string; image: ImageAttachment };

async function readFileContent(
  resolvedPath: string,
  requestedPath: string,
  maxFileSize: number,
  maxImageSize: number,
): Promise<AttachedFile | null> {
  try {
    const stats = await fsPromises.stat(resolvedPath);

    if (stats.isDirectory()) {
      logger.debug(`file-attachment: '${requestedPath}' is a directory, skipping`);
      return null;
    }

    // The image/text budgets are separate: images ride base64 to a vision
    // model (read's 10MB cap), text is inlined into the prompt (100KB cap).
    const mimeType = imageMimeType(resolvedPath);
    const sizeCap = mimeType ? maxImageSize : maxFileSize;
    if (stats.size > sizeCap) {
      logger.debug(`file-attachment: '${requestedPath}' is too large (${stats.size} bytes > ${sizeCap}), skipping`);
      return null;
    }

    if (mimeType) {
      // Binary: base64, never utf-8 (decoding binary as text corrupts it).
      const buf = await fsPromises.readFile(resolvedPath);
      return {
        kind: "image",
        path: requestedPath,
        image: { type: "image_url", mimeType, data: buf.toString("base64") },
      };
    }

    const content = await fsPromises.readFile(resolvedPath, "utf-8");
    return { kind: "text", path: requestedPath, content };
  } catch (e) {
    logger.debug(`file-attachment: failed to read '${requestedPath}': ${formatError(e)}`);
    return null;
  }
}

async function expandFileReferences(
  text: string,
  workspace: Workspace | null,
  maxFileSize: number,
  maxImageSize: number,
  maxFiles: number,
  vision: boolean,
): Promise<{
  content: Array<Record<string, unknown>>;
  attachedFiles: AttachedFile[];
} | null> {
  const attachedFiles: AttachedFile[] = [];
  const skippedImages: string[] = [];

  // Reset regex lastIndex before using it (global regex maintains state)
  FILE_REF_RE.lastIndex = 0;

  if (!FILE_REF_RE.test(text)) {
    return null;
  }

  // Reset regex lastIndex again before exec
  FILE_REF_RE.lastIndex = 0;

  const errors: string[] = [];
  let boundaryRejections = 0;
  let match: RegExpExecArray | null;

  while (
    (match = FILE_REF_RE.exec(text)) !== null &&
    attachedFiles.length + skippedImages.length + errors.length < maxFiles
  ) {
    const requestedPath = match[1];
    if (!requestedPath) continue;

    // Vision gate before any read: a non-vision model never gets image bytes.
    if (imageMimeType(requestedPath) !== null && !vision) {
      logger.debug(`file-attachment: '${requestedPath}' is an image but the model has no vision, skipping`);
      skippedImages.push(requestedPath);
      continue;
    }

    const resolvedPath = resolveFilePath(requestedPath, workspace);

    if (resolvedPath === null) {
      errors.push(requestedPath);
      boundaryRejections++;
      continue;
    }

    const result = await readFileContent(resolvedPath, requestedPath, maxFileSize, maxImageSize);
    if (result) {
      attachedFiles.push(result);
    } else {
      errors.push(requestedPath);
    }
  }

  // If no files were found and nothing was rejected, return the input
  // unchanged. Boundary rejections and vision-skipped images are the
  // exception: they always get a note, even when nothing attached.
  if (attachedFiles.length === 0 && boundaryRejections === 0 && skippedImages.length === 0) {
    return null;
  }

  // Semantic parts -- the wire renders each wrapper and applies the mangler;
  // this extension stays one level above the XML. The original text rides an
  // `untrusted` part (mangled at the wire for every provenance, including a
  // harness message whose flattened text a transform saw). The note is
  // harness text: a plain part, mangled only where the message says so.
  const content: Array<Record<string, unknown>> = [{ type: "untrusted", text }];
  for (const file of attachedFiles) {
    // Images ride the transform's `images` field, never a content part.
    if (file.kind === "image") continue;
    content.push({ type: "file-include", path: file.path, content: file.content });
  }
  if (errors.length > 0) {
    content.push({
      type: "text",
      text: `[File attachment note: could not read the following files: ${errors.join(", ")}]`,
    });
  }
  if (skippedImages.length > 0) {
    content.push({
      type: "text",
      text: `[File attachment note: skipped image attachments (current model does not accept image input): ${skippedImages.join(", ")}]`,
    });
  }

  return { content, attachedFiles };
}

export function create(core: CoreContext): ExtensionInstance {
  const config = getExtensionConfig<{
    maxFileSize: number;
    maxImageSize?: number;
    maxFiles: number;
  }>(core, "fileAttachment");
  const maxFileSize = config.maxFileSize;
  // Config resolution fills the schema default; the ?? covers standalone
  // callers (tests) that hand create() a bare core without resolution.
  const maxImageSize = config.maxImageSize ?? DEFAULT_MAX_IMAGE_SIZE;
  const maxFiles = config.maxFiles;

  core.completion.register(matcher, completion, "file-attachment:path-completion");

  return {
    hooks: {
      [HOOKS.INPUT]: async ({ text, agent, origin }) => {
        // Only direct user input expands @refs. origin is undefined for normal
        // user typing (CLI, one-shot, websocket, loop prompts) and "user" for
        // explicit user-sourced input; harness/model/system/tool (task results,
        // handoffs, notices, tool output) are not typed by the user and must not
        // attach files.
        if (origin !== undefined && origin !== "user") {
          return { action: "continue" };
        }

        const roots =
          (agent?.config?.workspaceRoots as string[] | undefined) ?? [cwd()];
        // null/undefined both mean "unconfigured" -- fall back to the defaults.
        const deny = agent?.config?.workspaceDeny as readonly string[] | null | undefined;
        const workspace = deny != null ? new Workspace(roots, deny) : new Workspace(roots);

        const result = await expandFileReferences(
          text,
          workspace,
          maxFileSize,
          maxImageSize,
          maxFiles,
          // agent is optional here (same as agent?.config above); an unknown
          // model fails closed -- no images to a model we can't verify.
          modelAcceptsImages(agent?.model, agent?.modelRegistry),
        );

        if (result) {
          const images = result.attachedFiles
            .filter((f): f is Extract<AttachedFile, { kind: "image" }> => f.kind === "image")
            .map((f) => f.image);
          return {
            action: "transform",
            content: result.content,
            ...(images.length > 0 ? { images } : {}),
          };
        }

        return { action: "continue" };
      },
    },
  };
}
