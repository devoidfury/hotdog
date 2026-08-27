import fsPromises from "node:fs/promises";
import { resolve as resolveAbs, isAbsolute, dirname } from "node:path";
import { cwd } from "node:process";
import { logger } from "@core/logger.ts";
import { Workspace, PathEscapeError } from "@utils/workspace.ts";
import type { CompletionContext } from "@core/completion.ts";

export function matcher(ctx: CompletionContext) {
  const text = ctx.line.slice(0, ctx.cursorPos);
  const lastSpace = text.lastIndexOf(" ");
  const currentWord = text.slice(lastSpace + 1);
  return currentWord.startsWith("@");
}

export async function completion(ctx: CompletionContext) {
  const text = ctx.line.slice(0, ctx.cursorPos);
  const lastSpace = text.lastIndexOf(" ");
  const currentWord = text.slice(lastSpace + 1);
  if (!currentWord.startsWith("@")) return [];

  const roots =
    (ctx.agent?.config?.workspaceRoots as string[] | undefined) ?? [cwd()];
  const workspace = new Workspace(roots);
  let baseDir = workspace.root;

  const pathPrefix = currentWord.slice(1);

  try {
    let searchDir: string;
    let prefixToMatch: string;

    if (isAbsolute(pathPrefix)) {
      if (workspace) {
        try {
          searchDir = workspace.resolveSafe(pathPrefix);
        } catch (e: unknown) {
          if (e instanceof PathEscapeError) return [];
          throw e;
        }
      } else {
        searchDir = pathPrefix;
      }
      searchDir = dirname(searchDir);
      prefixToMatch = pathPrefix.slice(searchDir.length + 1);
    } else if (pathPrefix.includes("/")) {
      const lastSlash = pathPrefix.lastIndexOf("/");
      const relDir = pathPrefix.slice(0, lastSlash);
      if (workspace) {
        try {
          searchDir = workspace.resolveSafe(relDir);
        } catch (e: unknown) {
          if (e instanceof PathEscapeError) {
            return [];
          }
          throw e;
        }
      } else {
        searchDir = resolveAbs(baseDir, relDir);
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
        return { value: "@" + fullPath };
      });

    return matches;
  } catch (e) {
    logger.debug(`file-attachment: completion error: ${(e as Error).message}`);
    return [];
  }
}
