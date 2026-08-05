// Workspace boundary for file operations.
//
// All file tools should work through this class. It keeps paths workspace-relative
// and rejects escapes -- both direct (../) and via symlinks.

import { resolve as resolveAbs, sep, dirname } from "node:path";
import fs from "node:fs";
import { ToolError } from "../core/error";

/**
 * A path tried to escape the workspace.
 */
export class PathEscapeError extends ToolError {
  constructor(message: string) {
    super(message);
    this.name = "PathEscapeError";
  }
  
  static invalidInput(input: unknown): PathEscapeError {
    return new PathEscapeError(`Invalid path: ${input}`);
  }

  static directEscape(path: string): PathEscapeError {
    return new PathEscapeError(`Path escape rejected: ${path}`);
  }

  static symlinkEscape(path: string): PathEscapeError {
    return new PathEscapeError(`Symlink escape rejected: ${path}`);
  }
}

/**
 * Workspace boundary.
 *
 * Resolve workspace-relative paths safely and reject anything that tries
 * to escape, including through symlinks.
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = resolveAbs(root);
  }

  /**
   * Resolve a workspace-relative path, rejecting escapes.
   *
   * @param relativePath - Path relative to the workspace root.
   * @returns The resolved absolute path.
   * @throws PathEscapeError if the path escapes the workspace.
   */
  resolveSafe(relativePath: string): string {
    if (!relativePath || typeof relativePath !== "string") {
      throw PathEscapeError.invalidInput(relativePath);
    }

    const resolved = resolveAbs(this.root, relativePath);

    // Reject direct escapes (../ past the root)
    if (!resolved.startsWith(this.root + sep) && resolved !== this.root) {
      throw PathEscapeError.directEscape(relativePath);
    }

    // Reject symlink escapes: walk ancestors that exist and check their real paths
    let current = resolved;
    const realRoot = fs.realpathSync.native(this.root);
    while (current.length > this.root.length) {
      if (fs.existsSync(current)) {
        const real = fs.realpathSync.native(current);
        if (real !== realRoot && !real.startsWith(realRoot + sep)) {
          throw PathEscapeError.symlinkEscape(relativePath);
        }
      }
      current = dirname(current);
    }

    return resolved;
  }

  /**
   * Check if a path is inside the workspace without resolving.
   */
  contains(absolutePath: string): boolean {
    const resolved = resolveAbs(absolutePath);
    return resolved.startsWith(this.root + sep) || resolved === this.root;
  }

  /**
   * Convert an absolute path back to workspace-relative, or null if outside.
   */
  relative(absolutePath: string): string | null {
    const resolved = resolveAbs(absolutePath);
    if (!this.contains(resolved)) return null;
    return resolved.slice(this.root.length).replace(/^\/+/, "");
  }
}
