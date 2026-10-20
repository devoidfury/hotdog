// One-shot layout migration for the sessions/data dir split.
//
// Before the split, `workflows/` and `task-lanes/` lived inside the sessions
// dir; they now live directly under the data dir (default ~/.cache/hotdog).
// At startup, each dir still found at its OLD location is moved to the new
// one -- so users who only ever used the defaults (with or without
// HOTDOG_SESSIONS_DIR) see their data follow the new resolution with no
// manual steps. Configured locations (workflows.path, taskLanesDir) are
// explicit and untouched; this only relocates what the old defaults created.
//
// Rules, per dir:
// - old missing (the common case) -> silent no-op.
// - old present, new missing -> move (creating the data dir if it is missing,
//   e.g. a fresh HOTDOG_DATA_DIR on first run). rename() when possible;
//   copy+delete across filesystems (HOTDOG_SESSIONS_DIR on tmpfs is a real setup).
// - both present -> never merge, never delete: warn and use the new one.
//   Deleting either side could destroy data a running old-version process
//   (e.g. a webui daemon started before the upgrade) is still writing.
// - the old entry is a stray file, not a dir -> warn, leave it.
//
// Never fatal: every failure is a warn that states both paths. Startup must
// not depend on a layout tidy-up succeeding. The fs seam is injectable so the
// EXDEV fallback and the lost-race path are testable without mocks.

import { cpSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "@utils/logger.ts";
import { formatError } from "./error.ts";
import { dataDir, joinDataDir, sessionsDir } from "./session/session-log.ts";

/** The dirs that moved from the sessions dir to the data dir. */
const MOVED_DIRS = ["workflows", "task-lanes"] as const;

/**
 * The fs seam, narrowed to exactly what the migration calls (string paths --
 * the real *Sync functions satisfy this contravariantly). Injectable so the
 * EXDEV fallback and the lost-race paths are testable without mocks.
 */
export interface LayoutFs {
  lstat: (path: string) => { isDirectory(): boolean };
  exists: (path: string) => boolean;
  mkdir: (path: string, options: { recursive: true }) => void;
  rename: (from: string, to: string) => void;
  copy: (from: string, to: string, options: { recursive: true }) => void;
  rm: (path: string, options: { recursive: true }) => void;
}

const REAL_FS: LayoutFs = {
  lstat: lstatSync,
  exists: existsSync,
  mkdir: mkdirSync,
  rename: renameSync,
  copy: cpSync,
  rm: rmSync,
};

function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

/**
 * Move oldPath onto newPath: rename when same-filesystem, copy+delete on
 * EXDEV. Throws on anything else (caller warns).
 */
function moveDir(oldPath: string, newPath: string, fs: LayoutFs): void {
  try {
    fs.rename(oldPath, newPath);
  } catch (e) {
    if (errnoCode(e) !== "EXDEV") throw e;
    fs.copy(oldPath, newPath, { recursive: true });
    // Source removal is best-effort: a failed unlink leaves both dirs, and
    // the next startup's "both exist" warn is the honest outcome.
    try {
      fs.rm(oldPath, { recursive: true });
    } catch (e) {
      logger.warn(
        `[data-layout] copied ${oldPath} to ${newPath} across filesystems but could not remove the source ` +
          `(it is now stale -- delete it once nothing is using it): ${formatError(e)}`,
      );
    }
  }
}

function migrateOne(name: string, fs: LayoutFs): void {
  const oldPath = join(sessionsDir(), name);
  const newPath = joinDataDir(name);
  // Degenerate env setups (e.g. HOTDOG_SESSIONS_DIR === HOTDOG_DATA_DIR)
  // where the "old" and "new" resolution is the same path.
  if (oldPath === newPath) return;

  let stat;
  try {
    stat = fs.lstat(oldPath);
  } catch {
    return; // no old dir: the common case, and post-migration forever after
  }

  if (!stat.isDirectory()) {
    logger.warn(
      `[data-layout] found a stray file at the old ${name} location ${oldPath}; ` +
        `the ${name} dir now lives at ${newPath}. The stray file was left in place.`,
    );
    return;
  }

  if (fs.exists(newPath)) {
    logger.warn(
      `[data-layout] ${name} dir exists at BOTH the old location ${oldPath} and the new one ${newPath}; ` +
        `using the new location and leaving both untouched. When nothing is using the old dir ` +
        `(an older hotdog process may still be), merge or delete it yourself.`,
    );
    return;
  }

  try {
    // rename() fails with ENOENT if newPath's parent is missing: a fresh
    // HOTDOG_DATA_DIR that nothing has created yet is a real first-run case.
    fs.mkdir(dirname(newPath), { recursive: true });
    moveDir(oldPath, newPath, fs);
  } catch (e) {
    const code = errnoCode(e);
    if (code === "ENOENT" && !fs.exists(oldPath)) return; // a concurrent startup won the race; its move is complete
    if (code === "EEXIST" || code === "ENOTEMPTY") {
      // New dir appeared between the check and the rename: same split-brain
      // case as above, same honest hands-off outcome.
      logger.warn(
        `[data-layout] ${name} dir appeared at ${newPath} during migration; ` +
          `leaving the old ${oldPath} untouched. Using ${newPath}.`,
      );
      return;
    }
    logger.warn(
      `[data-layout] could not move the ${name} dir ${oldPath} -> ${newPath}; ` +
        `continuing with the new location (start empty). ${formatError(e)}`,
    );
    return;
  }
  logger.info(`[data-layout] migrated ${name} dir ${oldPath} -> ${newPath} (sessions/data split)`);
}

/**
 * Run the one-shot sessions/data layout migration. Call once at startup,
 * before anything reads or creates the workflows/task-lanes dirs.
 */
export function migrateDataLayout(fs: LayoutFs = REAL_FS): void {
  // Cheap guard: with the default env the two roots share a parent, so the
  // old dir is one stat away; when the sessions dir itself is gone there is
  // nothing of ours on disk yet.
  if (!fs.exists(dataDir()) && !fs.exists(sessionsDir())) return;
  for (const name of MOVED_DIRS) {
    try {
      migrateOne(name, fs);
    } catch (e) {
      logger.warn(`[data-layout] ${name} migration failed: ${formatError(e)}`);
    }
  }
}
