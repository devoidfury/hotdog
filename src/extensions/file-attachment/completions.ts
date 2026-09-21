import fsPromises from "node:fs/promises";
import { isAbsolute, dirname } from "node:path";
import { cwd } from "node:process";
import { logger } from "@utils/logger.ts";
import { Workspace, PathEscapeError } from "@utils/workspace.ts";
import type { CompletionContext } from "@core/completion.ts";

function currentWord(ctx: CompletionContext): string {
  const text = ctx.line.slice(0, ctx.cursorPos);
  const lastSpace = text.lastIndexOf(" ");
  return text.slice(lastSpace + 1);
}

// Bare-path trigger: words that unambiguously look like a path ("./x", "/x",
// "dir/x") so plain prose like "test.txt" never triggers file completion.
function isBarePath(word: string): boolean {
  return word.startsWith(".") || word.startsWith("/") || word.includes("/");
}

export function matcher(ctx: CompletionContext) {
  const currentWordText = currentWord(ctx);
  return currentWordText.startsWith("@") || isBarePath(currentWordText);
}

export async function completion(ctx: CompletionContext) {
  const word = currentWord(ctx);
  const isAttachment = word.startsWith("@");
  if (!isAttachment && !isBarePath(word)) return [];

  const roots =
    (ctx.agent?.config?.workspaceRoots as string[] | undefined) ?? [cwd()];
  // null/undefined both mean "unconfigured" -- fall back to the defaults.
  const deny = ctx.agent?.config?.workspaceDeny as readonly string[] | null | undefined;
  const workspace = deny != null ? new Workspace(roots, deny) : new Workspace(roots);
  let baseDir = workspace.root;

  const pathPrefix = isAttachment ? word.slice(1) : word;

  try {
    let searchDir: string;
    let prefixToMatch: string;

    if (isAbsolute(pathPrefix)) {
      try {
        searchDir = workspace.resolveSafe(pathPrefix);
      } catch (e: unknown) {
        if (e instanceof PathEscapeError) return [];
        throw e;
      }
      searchDir = dirname(searchDir);
      prefixToMatch = pathPrefix.slice(searchDir.length + 1);
    } else if (pathPrefix.includes("/")) {
      const lastSlash = pathPrefix.lastIndexOf("/");
      const relDir = pathPrefix.slice(0, lastSlash);
      try {
        searchDir = workspace.resolveSafe(relDir);
      } catch (e: unknown) {
        if (e instanceof PathEscapeError) {
          return [];
        }
        throw e;
      }
      prefixToMatch = pathPrefix.slice(lastSlash + 1);
    } else {
      searchDir = baseDir;
      prefixToMatch = pathPrefix;
    }

    const entries = await fsPromises.readdir(searchDir, {
      withFileTypes: true,
    });
    const matches = entries
      .filter((entry) => {
        // Skip hidden files/dirs and node_modules
        if (entry.name.startsWith(".") || entry.name === "node_modules") {
          return false;
        }
        return entry.name.toLowerCase().startsWith(prefixToMatch.toLowerCase());
      })
      .map((entry) => {
        const name = entry.isDirectory() ? entry.name + "/" : entry.name;
        const fullPath =
          pathPrefix.includes("/") || isAbsolute(pathPrefix)
            ? (isAbsolute(pathPrefix)
                ? dirname(pathPrefix)
                : pathPrefix.slice(0, pathPrefix.lastIndexOf("/"))) +
              "/" +
              name
            : name;
        return { value: (isAttachment ? "@" : "") + fullPath };
      });

    return matches;
  } catch (e) {
    logger.debug(`file-attachment: completion error: ${(e as Error).message}`);
    return [];
  }
}
