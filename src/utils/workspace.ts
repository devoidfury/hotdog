// Workspace boundary for file operations.
//
// All file tools should work through this class. It keeps paths inside the
// configured workspace roots and rejects escapes -- both direct (../) and via
// symlinks.

import { resolve as resolveAbs, sep, dirname } from "node:path";
import { homedir } from "node:os";
import fs from "node:fs";
import { ToolError, ConfigError } from "../core/error.ts";
import { logger } from "../core/logger.ts";

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
 * Pinned @types/bun predates the Bun.Glob typing -- cast shim until the
 * typings catch up.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GlobCtor = (Bun as any).Glob as new (pattern: string) => {
  scanSync(options?: { onlyFiles?: boolean }): Iterable<string>;
};

// Characters that make an entry a glob pattern rather than a literal path.
// Braces are included so patterns like ~/.config/{a,b} are detected even
// without a *.
const GLOB_MAGIC = /[*?\[{]/;

/**
 * Expand a raw config entry: leading `~` or `~/...` becomes the user's home
 * directory. `~user` and anything else is left as-is.
 */
function expandTilde(entry: string): string {
  if (entry === "~") return homedir();
  if (entry.startsWith("~/")) return homedir() + entry.slice(1);
  return entry;
}

/**
 * Expand raw `workspace.paths` config entries into concrete absolute paths.
 *
 * Per entry: tilde-expand, then either glob-expand (via Bun.Glob) if the
 * entry contains glob magic, or treat it as a literal path. Glob matches are
 * resolved against the process CWD (Bun.Glob returns relative matches for
 * relative patterns). A glob that matches nothing but exists as a literal
 * path (e.g. a directory whose name contains `[`) is used as-is; a glob
 * that matches nothing and does not exist logs a warning and is dropped;
 * a literal path that does not exist throws.
 *
 * @returns Absolute lexical paths, deduplicated, order-preserving.
 * @throws ConfigError if the input is not a non-empty array of non-empty
 *   strings, or an explicit (non-glob) path does not exist.
 */
export function expandWorkspacePaths(entries: readonly string[]): string[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ConfigError("workspace.paths must be a non-empty array of paths");
  }

  const roots: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ConfigError(
        `workspace.paths entries must be non-empty strings, got: ${entry}`,
      );
    }

    const expanded = expandTilde(entry);
    const isGlob = GLOB_MAGIC.test(expanded);
    // onlyFiles:false -- workspace roots are usually directories, and scanSync
    // defaults to files only.
    const matches = isGlob ? Array.from(new GlobCtor(expanded).scanSync({ onlyFiles: false })) : [expanded];

    if (isGlob && matches.length === 0) {
      // The entry may be a literal path whose name merely contains glob
      // magic (e.g. "my[1]dir"). Fall back to it if it exists on disk.
      const literal = resolveAbs(process.cwd(), expanded);
      if (fs.existsSync(literal)) {
        roots.push(literal);
        continue;
      }
      logger.warn(`workspace path pattern '${entry}' matched nothing`);
      continue;
    }

    for (const match of matches) {
      const abs = resolveAbs(process.cwd(), match);
      if (!fs.existsSync(abs)) {
        throw new ConfigError(
          `workspace path does not exist: ${abs} (from '${entry}')`,
        );
      }
      roots.push(abs);
    }
  }

  return [...new Set(roots)];
}

/**
 * Multi-root workspace boundary.
 *
 * Relative paths resolve against the primary root (`roots[0]`); absolute
 * paths are accepted if they fall inside any configured root. Anything that
 * escapes -- directly or through symlinks -- is rejected, except symlinks
 * whose real location is inside another configured root (still trusted).
 */
export class Workspace {
  readonly roots: string[];

  constructor(roots: string | string[]) {
    const normalized = (Array.isArray(roots) ? roots : [roots]).map((r) => resolveAbs(r));
    if (normalized.length === 0) {
      throw new ConfigError("Workspace roots must not be empty");
    }
    this.roots = normalized;
  }

  /**
   * The primary root (where relative paths resolve).
   */
  get root(): string {
    return this.roots[0]!;
  }

  /**
   * Find the first configured root (config order) that contains the given
   * absolute path, or null if none does.
   */
  #ownerRoot(absolutePath: string): string | null {
    const resolved = resolveAbs(absolutePath);
    for (const r of this.roots) {
      if (resolved === r || resolved.startsWith(r + sep)) return r;
    }
    return null;
  }

  /**
   * Resolve a workspace path, rejecting escapes.
   *
   * Relative paths resolve against the primary root; absolute paths are
   * accepted if they fall inside any configured root.
   *
   * @param path - Path relative to the primary root, or absolute.
   * @returns The resolved absolute path.
   * @throws PathEscapeError if the path escapes the workspace.
   */
  resolveSafe(path: string): string {
    if (!path || typeof path !== "string") {
      throw PathEscapeError.invalidInput(path);
    }

    const resolved = resolveAbs(this.root, path);

    // Reject direct escapes: no configured root contains the result.
    const owner = this.#ownerRoot(resolved);
    if (!owner) {
      throw PathEscapeError.directEscape(path);
    }

    // Reject symlink escapes: walk ancestors that exist and check their real
    // paths against the REAL location of every configured root, so a symlink
    // that points at a different configured root is still inside the workspace.
    let current = resolved;
    const realRoots = this.#realRoots();
    while (current.length > owner.length) {
      if (fs.existsSync(current)) {
        const real = fs.realpathSync.native(current);
        if (!this.#insideRealRoots(real, realRoots)) {
          throw PathEscapeError.symlinkEscape(path);
        }
      }
      current = dirname(current);
    }

    // A dangling symlink as the final component evades the existsSync-based
    // ancestor check (existsSync follows the link and sees the missing
    // target), yet a write would create the file at the target -- which may
    // be outside the root. Follow the final link chain explicitly; each hop
    // must stay inside the root. lstat does not follow links, so a missing
    // final target is simply a non-existent path (allowed).
    // (Bun implements realpathSync.native but not lstatSync.native/readlinkSync.native,
    // so use the plain variants here.)
    let probe = resolved;
    for (let hop = 0; hop < 40; hop++) {
      let st;
      try {
        st = fs.lstatSync(probe);
      } catch {
        break; // final component does not exist -- nothing to follow
      }
      if (!st.isSymbolicLink()) break;
      probe = resolveAbs(dirname(probe), fs.readlinkSync(probe));
      // The root itself may be a symlink; the ancestor walk accepts anything
      // under ANY root's REAL path, so the probe must too.
      const inLexicalRoot = probe === owner || probe.startsWith(owner + sep);
      if (!inLexicalRoot && !this.#insideRealRoots(probe, realRoots)) {
        throw PathEscapeError.symlinkEscape(path);
      }
    }

    return resolved;
  }

  /**
   * Real (symlink-resolved) locations of all configured roots. Roots that
   * have vanished since construction contribute nothing.
   */
  #realRoots(): string[] {
    const reals: string[] = [];
    for (const r of this.roots) {
      try {
        reals.push(fs.realpathSync.native(r));
      } catch {
        // root no longer exists -- nothing to compare against
      }
    }
    return reals;
  }

  /** True if p is at, or lexically under, any of the given real root paths. */
  #insideRealRoots(p: string, realRoots: string[]): boolean {
    for (const rr of realRoots) {
      if (p === rr || p.startsWith(rr + sep)) return true;
    }
    return false;
  }

  /**
   * Check if a path is inside any workspace root without resolving.
   */
  contains(absolutePath: string): boolean {
    return this.#ownerRoot(absolutePath) !== null;
  }

  /**
   * Convert an absolute path back to workspace-relative against the FIRST
   * containing root (config order), or null if outside all roots.
   */
  relative(absolutePath: string): string | null {
    const resolved = resolveAbs(absolutePath);
    const owner = this.#ownerRoot(resolved);
    if (!owner) return null;
    return resolved.slice(owner.length).replace(/^\/+/, "");
  }
}
