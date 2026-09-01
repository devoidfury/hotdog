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

  static denied(path: string, rule: string): PathEscapeError {
    return new PathEscapeError(`Denylisted path rejected (${rule}): ${path}`);
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
      throw new ConfigError(`workspace.paths entries must be non-empty strings, got: ${entry}`);
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
        throw new ConfigError(`workspace path does not exist: ${abs} (from '${entry}')`);
      }
      roots.push(abs);
    }
  }

  return [...new Set(roots)];
}

/**
 * Built-in denylist for sensitive paths inside any workspace root.
 *
 * This is the runtime fallback used when a `Workspace` is constructed
 * without an explicit list. The effective default for agent sessions is
 * the `workspace.deny` config key (default declared in
 * core.config.json); a test pins the two lists in sync.
 *
 * Rule format: slash-separated globs matched against the components of the
 * resolved absolute path. A rule may start at any depth -- `.ssh` denies
 * the `.ssh` directory itself and everything below it, wherever it sits.
 * `*` and `?` glob within a single component and never cross `/`
 * (no `[...]` classes). A rule prefixed with `!` is a negation: rules are
 * evaluated in order and the LAST match wins, gitignore-style, so
 * `!.env.example` after `.env*` carves an exception out.
 *
 * Root exception: a positive rule never applies to a root that itself sits
 * at or below the denied level (e.g. a configured root of `~/.config/tool`
 * is trusted; `.env*` and the rest do not fire inside it for that rule).
 */
export const DEFAULT_DENY_PATTERNS: readonly string[] = [
  ".ssh",
  ".config",
  ".git",
  ".aws",
  ".azure",
  ".docker",
  ".gnupg",
  ".kube",
  ".*profile",
  ".*rc",
  "*.local*",
  ".env*",
  "!.env.example",
];

/**
 * Compile one path component to a segment-glob regex: `*` = any run of
 * non-separator chars, `?` = one char, everything else literal.
 */
function componentToRegex(component: string): RegExp {
  let rx = "";
  for (const ch of component) {
    if (ch === "*") rx += "[^/]*";
    else if (ch === "?") rx += "[^/]";
    else rx += ch.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${rx}$`);
}

/**
 * True if a rule's component sequence appears at any position in the
 * path's component list.
 */
function pathMatchesRule(components: string[], rule: string): boolean {
  const rx = rule.split("/").filter(Boolean).map(componentToRegex);
  if (rx.length === 0) return false;
  for (let i = 0; i + rx.length <= components.length; i++) {
    let ok = true;
    for (let j = 0; j < rx.length; j++) {
      if (!rx[j]!.test(components[i + j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Multi-root workspace boundary.
 *
 * Relative paths resolve against the primary root (`roots[0]`); absolute
 * paths are accepted if they fall inside any configured root. Anything that
 * escapes -- directly or through symlinks -- is rejected, except symlinks
 * whose real location is inside another configured root (still trusted).
 * Paths matching the configured denylist (`deniedPatterns`, from the
 * `workspace.deny` config key) are rejected as well (see
 * `Workspace#resolveSafe`).
 */
export class Workspace {
  readonly roots: string[];
  readonly deniedPatterns: readonly string[];

  /**
   * @param deniedPatterns - Denylist rules for `resolveSafe`; defaults to
   *   `DEFAULT_DENY_PATTERNS`. Agent sessions pass the resolved
   *   `workspace.deny` config value; an explicit empty array disables
   *   the denylist. Entries must be strings (a `ConfigError` is thrown
   *   otherwise, so a bad config fails at construction, not per resolve).
   */
  constructor(roots: string | string[], deniedPatterns: readonly string[] = DEFAULT_DENY_PATTERNS) {
    const normalized = (Array.isArray(roots) ? roots : [roots]).map((r) => resolveAbs(r));
    if (normalized.length === 0) {
      throw new ConfigError("Workspace roots must not be empty");
    }
    if (deniedPatterns.some((r) => typeof r !== "string")) {
      throw new ConfigError("deniedPatterns entries must be strings");
    }
    this.roots = normalized;
    this.deniedPatterns = deniedPatterns;
  }

  get root(): string {
    return this.roots[0]!;
  }

  #ownerRoot(absolutePath: string): string | null {
    const resolved = resolveAbs(absolutePath);
    for (const r of this.roots) {
      if (resolved === r || resolved.startsWith(r + sep)) return r;
    }
    return null;
  }

  /**
   * Evaluate `this.deniedPatterns` against a resolved absolute path.
   *
   * Rules are evaluated in order; the last rule that matches the path's
   * components decides (gitignore-style, so `!` negations can override an
   * earlier positive rule). A positive rule is skipped when the owning
   * root itself sits at/below the denied level -- a root configured
   * directly inside (e.g. under) a denylisted directory is explicitly
   * trusted.
   *
   * @returns The matched rule (for the error message), or null if allowed.
   */
  #deniedRule(resolved: string, owner: string): string | null {
    const comps = resolved.split(sep).filter(Boolean);
    const ownerComps = owner.split(sep).filter(Boolean);
    let matched: string | null = null;
    let denied = false;
    for (const candidate of this.deniedPatterns) {
      const negated = candidate.startsWith("!");
      const rule = negated ? candidate.slice(1) : candidate;
      // Root exception: the root is explicitly at/below this level.
      if (!negated && pathMatchesRule(ownerComps, rule)) continue;
      if (pathMatchesRule(comps, rule)) {
        matched = candidate;
        denied = !negated;
      }
    }
    return denied ? matched : null;
  }

  /**
   * Resolve a workspace path, rejecting escapes.
   *
   * Relative paths resolve against the primary root; absolute paths are
   * accepted if they fall inside any configured root. The denylist is
   * enforced on the lexical path AND on the real path, so symlinks
   * cannot name their way around it.
   *
   * @param path - Path relative to the primary root, or absolute.
   * @returns The resolved absolute path.
   * @throws PathEscapeError if the path escapes the workspace or is denylisted.
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

    // Reject denylisted paths (ssh dirs, dotfiles, env files, ...).
    const denied = this.#deniedRule(resolved, owner);
    if (denied !== null) {
      throw PathEscapeError.denied(path, denied);
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

    // Re-check the denylist against the REAL path: a symlink inside the
    // root (or a symlinked ancestor) may name a denied target that the
    // lexical path alone does not reveal (e.g. `notes.md` -> `.ssh/id_rsa`).
    let real = probe;
    try {
      real = fs.realpathSync.native(probe);
    } catch {
      // Path does not exist yet; the lexical form is all we have.
    }
    // The root exemption applies to the REAL location of the owning root,
    // so a symlinked root sitting below a denied level stays trusted; when
    // the real path lands in a different configured root, that root's
    // exemptions apply instead.
    let ownerReal = owner;
    try {
      ownerReal = fs.realpathSync.native(owner);
    } catch {
      // owner vanished; the lexical form is fine
    }
    const realOwner =
      realRoots.find((rr) => real === rr || real.startsWith(rr + sep)) ?? ownerReal;
    const deniedReal = this.#deniedRule(real, realOwner);
    if (deniedReal !== null) {
      throw PathEscapeError.denied(path, deniedReal);
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

  contains(absolutePath: string): boolean {
    return this.#ownerRoot(absolutePath) !== null;
  }

  /** Workspace-relative path against the first containing root, or null if outside. */
  relative(absolutePath: string): string | null {
    const resolved = resolveAbs(absolutePath);
    const owner = this.#ownerRoot(resolved);
    if (!owner) return null;
    return resolved.slice(owner.length).replace(/^\/+/, "");
  }
}
