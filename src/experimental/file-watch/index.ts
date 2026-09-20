// File Watch Extension
// Cooperative-editing awareness for a shared working tree.
//
// Tracks the files this session reads or writes (its "interest set"), each baselined with a content hash,
// and detects when the bytes on disk stop matching what the session believes -- changed or deleted by another agent
// session, the user's editor, or git. Unresolved changes ride every LLM request as one small harness system-notice
// until the session re-reads the file; with writeGuard, an `overwrite` onto a stale target is blocked before
// it clobbers foreign work.
//
// Design notes:
//  - In-memory only. The manifest encodes what THIS session believes; after
//    a restart there are no beliefs to conflict against, so nothing to flag.
//  - Detection is lazy (checked before each LLM request, stat fast path then
//    content hash), not via filesystem watchers: an interest set is small,
//    and lazy checks survive any editor/VCS behavior.
//  - Self-writes rebaseline silently: a successful tracked tool write
//    (edit/overwrite/append) refreshes its own path. That rebuild would
//    adopt ANYTHING on disk as self-caused, so the writes it covers use a
//    two-phase window: before the write executes (bash, edit, append), any
//    divergence between disk and the baseline is frozen into `pending`
//    (motion that predates the write, which rebaselining must not swallow),
//    then the index is rebuilt on top, so the window's own writes (sed/git,
//    the edit/append payload) are adopted as self-caused. The freeze must
//    run BEFORE the write -- a post-run freeze would flag the session's own
//    successful write as external motion. `overwrite` is exempt: it makes
//    belief and disk identical by construction and a successful one clears
//    its pending entry. Changes inside the window itself cannot be
//    attributed and are adopted -- that is the irreducible blind spot of
//    this design.
//  - `pending` notices are orthogonal to baselines: the baseline tracks the
//    disk, pending tracks the session's stale belief. Only going and looking
//    resolves it -- a successful read, a read attempt that found the file
//    gone (absence is an observation too; a failed read of an existing file,
//    e.g. a permission error, taught the session nothing and must not disarm
//    the guard), or an overwrite (which makes belief and disk identical by
//    construction).
//  - A context replacement (compaction, session load/rewind) resets the
//    session's beliefs wholesale: agent.replaceContext() fires CONTEXT_REPLACED
//    and the manifest and pending maps are dropped. The verbatim file contents
//    the baselines encode are gone from the conversation, and so are the
//    stale notices riding on them; "do not write from memory" has no memory to
//    defend, so the write guard releases too. Maps rebuild from subsequent
//    reads. This also dissolves any dependence on handler order relative to
//    compaction in the CONTEXT pipeline.
//  - Two sessions in one process each keep their own manifest, so session A's
//    writes surface to session B as external changes -- which is the point.
//  - Courtesy feature, not a security gate: handlers fail open; a broken
//    watcher must never block a tool call.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve as resolveAbs } from "node:path";
import { HOOKS } from "@core/hooks.ts";
import { formatError } from "@core/error.ts";
import { Message } from "@core/context/message.ts";
import type { Agent } from "@core/agent.ts";
import { logger } from "@utils/logger.ts";
import {
  getExtensionConfig,
  type CoreContext,
  type ExtensionInstance,
} from "@core/extensions/types.ts";

interface FileWatchConfig {
  enabled: boolean;
  notify: boolean;
  writeGuard: boolean;
  ignore: string[];
}

interface Baseline {
  mtimeMs: number;
  size: number;
  hash: string;
}

// "unreadable" = the file is (still) there but stat/read failed with
// something other than not-found (EACCES, ELOOP, IO error). Kept distinct
// from "deleted" so notices and the guard do not falsely assert deletion.
type ChangeKind = "modified" | "deleted" | "unreadable";

/** Does the fs error mean "no such file/directory"? ENOTDIR covers a path
 * component having been replaced by a non-directory. */
function isNotFound(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// Tools whose input carries a `path` and whose success means the session now
// has (or rewrote) a grip on the file's contents.
const TRACKED_TOOLS = new Set(["read", "edit", "overwrite", "append"]);

// Tools whose successful run rebaselines and which therefore get the
// pre-run freeze (window phase 1): `bash` can write anything; `edit`/
// `append` write part of a file and observe none of the rest. `overwrite`
// rewrites the whole file -- belief and disk become identical by
// construction and a successful one clears its pending entry -- so it is
// exempt.
const WINDOW_TOOLS = new Set(["bash", "edit", "append"]);

// Larger files are skipped rather than hashed repeatedly per request; a
// session reading multi-MB files is not the cooperative-editing case.
const MAX_TRACK_BYTES = 8 * 1024 * 1024;

const MAX_NOTICE_LINES = 10;

/** Content snapshot; `null` = missing/unreadable/not a file, "large" = over cap. */
async function snapshot(path: string): Promise<Baseline | "large" | null> {
  try {
    const st = await stat(path);
    if (!st.isFile()) return null;
    if (st.size > MAX_TRACK_BYTES) return "large";
    const hash = createHash("sha256").update(await readFile(path)).digest("hex");
    return { mtimeMs: st.mtimeMs, size: st.size, hash };
  } catch (e: unknown) {
    logger.debug(`file-watch: snapshot failed for '${path}': ${formatError(e)}`);
    return null;
  }
}

/**
 * Does the file on disk still match the session's baseline? A stat match is
 * conclusive for ordinary writes -- an accepted blind spot is tooling that
 * deliberately restores mtime+size with foreign bytes (cp -p, tar, rsync).
 * A stat mismatch is confirmed by content hash, so `touch`/checkout churn that
 * preserves content does not flag. A content-only match refreshes the stored
 * stat so the next check takes the fast path again.
 */
async function detectChange(path: string, base: Baseline): Promise<ChangeKind | null> {
  let st;
  try {
    st = await stat(path);
  } catch (e: unknown) {
    // Only a genuine not-found means gone; a transient stat error (EACCES,
    // ELOOP, EMFILE) must not be reported as a confident "deleted".
    return isNotFound(e) ? "deleted" : "unreadable";
  }
  if (!st.isFile()) return "deleted";
  if (st.mtimeMs === base.mtimeMs && st.size === base.size) return null;
  if (st.size > MAX_TRACK_BYTES) return "modified";
  const snap = await snapshot(path);
  // stat just succeeded, so a failed read is an access/IO failure, not absence.
  if (snap === null) return "unreadable";
  if (snap === "large") return "modified";
  if (snap.hash === base.hash) {
    base.mtimeMs = snap.mtimeMs;
    base.size = snap.size;
    return null;
  }
  return "modified";
}

/** Is the file gone for good (absent, or a path component is not a
 * directory)? Stat errors that are NOT not-found (EACCES, ELOOP, IO) are
 * treated as "still there": a session that failed to look did not observe
 * absence, so the notice and the write guard must stay armed. */
async function fileGone(path: string): Promise<boolean> {
  try {
    return !(await stat(path)).isFile();
  } catch (e: unknown) {
    return isNotFound(e);
  }
}

/** Parse a core file tool's JSON input for its `path`; null when unusable. */
function parsePathInput(input: unknown): string | null {
  if (typeof input !== "string") return null;
  try {
    const parsed = JSON.parse(input) as { path?: unknown };
    return typeof parsed.path === "string" && parsed.path.length > 0 ? parsed.path : null;
  } catch {
    return null;
  }
}

export function create(core: CoreContext): ExtensionInstance {
  const config = getExtensionConfig<FileWatchConfig>(core, "fileWatch");

  if (config.enabled === false) {
    return {};
  }

  // Resolve tool paths the way the file tools do: relative to the primary
  // workspace root (resolved workspaceRoots[0]), else the process CWD.
  const primaryRoot = resolvePrimaryRoot(core);

  // Ignore patterns match on path-segment boundaries, not as raw substrings:
  // "dist/" ignores any `dist` directory without also swallowing `mydist/`.
  // A pattern matches when its segments appear as a consecutive run inside
  // the absolute path (a trailing slash is redundant; a pattern naming a
  // file, like "config.local.json", matches that file anywhere).
  const ignoreRuns = config.ignore
    .map((pattern) => pattern.split("/").filter(Boolean))
    .filter((run) => run.length > 0);

  const ignored = (absPath: string): boolean => {
    if (ignoreRuns.length === 0) return false;
    const segments = absPath.split("/").filter(Boolean);
    for (const run of ignoreRuns) {
      const head = run[0]!;
      for (let i = 0; i + run.length <= segments.length; i++) {
        if (segments[i] !== head) continue;
        let matched = true;
        for (let j = 1; j < run.length; j++) {
          if (segments[i + j] !== run[j]) {
            matched = false;
            break;
          }
        }
        if (matched) return true;
      }
    }
    return false;
  };

  const resolvePath = (p: string): string =>
    isAbsolute(p) ? resolveAbs(p) : resolveAbs(primaryRoot, p);

  const displayPath = (absPath: string): string => {
    const rel = relative(primaryRoot, absPath);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absPath;
  };

  // Interest set per session, keyed by sessionId: a shared tool/hook
  // instance serves all sessions, so state must be namespaced (same
  // reasoning as the loop extension). Entries are reclaimed on
  // HOOKS.SESSION_END -- fired when a session is deleted or a task agent
  // finishes -- so these maps stay bounded in a long-lived server process.
  const manifests = new Map<string, Map<string, Baseline>>();

  // Unresolved external motion per session: path -> kind, frozen at the
  // moment it was observed. Survives baseline rebuilds; see header notes.
  const pendingMaps = new Map<string, Map<string, ChangeKind>>();

  function sessionKey(agent: Agent | undefined): string {
    return agent?.sessionId || "default";
  }

  function getManifest(agent: Agent | undefined, createIfMissing: boolean): Map<string, Baseline> | undefined {
    const key = sessionKey(agent);
    let manifest = manifests.get(key);
    if (!manifest && createIfMissing) {
      manifest = new Map();
      manifests.set(key, manifest);
    }
    return manifest;
  }

  function getPending(agent: Agent | undefined, createIfMissing: boolean): Map<string, ChangeKind> | undefined {
    const key = sessionKey(agent);
    let pending = pendingMaps.get(key);
    if (!pending && createIfMissing) {
      pending = new Map();
      pendingMaps.set(key, pending);
    }
    return pending;
  }

  /** Silently adopt current disk state as the session's new belief. */
  async function rebaseline(manifest: Map<string, Baseline>): Promise<void> {
    for (const absPath of [...manifest.keys()]) {
      const snap = await snapshot(absPath);
      if (snap === null || snap === "large") manifest.delete(absPath);
      else manifest.set(absPath, snap);
    }
  }

  function buildNotice(changes: Array<{ path: string; kind: ChangeKind }>, overflow: number): string {
    const lines = [
      "Files you have touched changed outside this session's tool calls",
      "(another agent session, your editor, or git may be at work):",
    ];
    for (const { path, kind } of changes) {
      lines.push(
        kind === "deleted"
          ? `- ${path}: deleted`
          : kind === "unreadable"
            ? `- ${path}: unreadable since you last read it (permissions or I/O error)`
            : `- ${path}: modified since you last read it (your copy in this conversation is stale)`,
      );
    }
    if (overflow > 0) lines.push(`- ...and ${overflow} more`);
    lines.push("Re-read before editing; do not write these files from memory.");
    return lines.join("\n");
  }

  return {
    hooks: {
      // Window phase 1: before bash/edit/append execute, freeze any
      // divergence between disk and the baseline as pending notices, then
      // rebuild the index on top. Without this, the post-run rebaseline
      // would silently swallow external motion that landed before the window
      // even opened.
      [HOOKS.TOOL_BEFORE_EXECUTE]: async ({ toolName, agent }) => {
        if (!WINDOW_TOOLS.has(toolName) || !agent) return;
        try {
          const manifest = getManifest(agent, false);
          if (!manifest || manifest.size === 0) return;

          const changes: Array<{ path: string; kind: ChangeKind }> = [];
          for (const [abs, base] of manifest) {
            const kind = await detectChange(abs, base);
            if (kind !== null) changes.push({ path: abs, kind });
          }
          if (changes.length > 0) {
            const pending = getPending(agent, true)!;
            for (const { path, kind } of changes) pending.set(path, kind);
          }
          await rebaseline(manifest);
        } catch (e: unknown) {
          logger.debug(`file-watch: pre-window diff failed: ${formatError(e)}`);
        }
      },

      // Track self-CAUSED state: after read/edit/overwrite/append the file's
      // current bytes are what the session believes (or just wrote), so the
      // baseline is refreshed. Window phase 2 (bash/edit/append): rebuild
      // again -- writes inside the window are this session's own, regardless
      // of exit code; motion frozen in phase 1 lives on in `pending`.
      [HOOKS.TOOL_AFTER_EXECUTE]: async ({ toolName, input, agent, success }) => {
        try {
          if (!agent) return;

          if (toolName === "bash") {
            const manifest = getManifest(agent, false);
            if (manifest) await rebaseline(manifest);
            return;
          }

          if (!TRACKED_TOOLS.has(toolName)) return;

          const raw = parsePathInput(input);
          if (!raw) return;
          const abs = resolvePath(raw);
          if (ignored(abs)) return;

          // A successful read resolves pending motion -- going and looking is
          // the observation. A FAILED read resolves it only when the file is
          // actually gone: absence is an observation, but a permission/IO
          // failure taught the session nothing, so the notice (and the write
          // guard) must survive it. When absence is observed, clear the
          // manifest too: outside a bash window the "deleted" flag lives in
          // the manifest entry, and leaving its baseline behind would re-flag
          // forever a session that has now gone and looked. (Inside a window,
          // the phase-1 rebuild already dropped the entry, which is why the
          // pending-only clear sufficed there.)
          if (toolName === "read") {
            if (success || (await fileGone(abs))) {
              getPending(agent, false)?.delete(abs);
              if (!success) getManifest(agent, false)?.delete(abs);
            }
          }

          if (!success) return;

          const manifest = getManifest(agent, true)!;
          const snap = await snapshot(abs);
          if (snap === null || snap === "large") manifest.delete(abs);
          else manifest.set(abs, snap);

          // Overwrite makes belief and disk identical by construction.
          if (toolName === "overwrite") getPending(agent, false)?.delete(abs);
        } catch (e: unknown) {
          logger.debug(`file-watch: tracking failed: ${formatError(e)}`);
        }
      },

      // Motion in the peripheral view: while any tracked file diverges from
      // the session's belief, or unresolved motion is pending, one harness
      // system-notice rides each request. Ephemeral (CONTEXT output shapes
      // the request, not the stored context): it disappears the moment the
      // session re-reads the file.
      [HOOKS.CONTEXT]: async ({ messages, agent }) => {
        if (!config.notify) return;
        try {
          if (agent?.isRestoring) return;
          const manifest = getManifest(agent, false);
          const pending = getPending(agent, false);
          if (!manifest && !pending) return;

          const changes: Array<{ path: string; kind: ChangeKind }> = [];
          const seen = new Set<string>();
          let overflow = 0;
          const push = (abs: string, kind: ChangeKind) => {
            if (changes.length < MAX_NOTICE_LINES) changes.push({ path: displayPath(abs), kind });
            else overflow++;
          };

          // Pending first: observations frozen before the last bash window.
          if (pending) {
            for (const [abs, kind] of pending) {
              push(abs, kind);
              seen.add(abs);
            }
          }
          if (manifest) {
            for (const [abs, base] of manifest) {
              if (seen.has(abs)) continue;
              const kind = await detectChange(abs, base);
              if (kind === null) continue;
              push(abs, kind);
            }
          }
          if (changes.length === 0) return;

          const notice = new Message({
            role: "harness",
            source: "harness",
            content: [{ type: "system-notice", text: buildNotice(changes, overflow) }],
          });
          // The pipeline adopts the returned { messages } into the payload: if
          // compaction ran earlier in the chain, `messages` here is already
          // its rebuilt array. If it runs after us, its own rebuild replaces
          // our notice for this request -- and replaceContext() fires
          // CONTEXT_REPLACED, which clears our maps for the next one.
          return { messages: [...messages, notice] };
        } catch (e: unknown) {
          logger.debug(`file-watch: notice pass failed: ${formatError(e)}`);
          return;
        }
      },

      // Compaction, session load, and rewind all replace the context through
      // agent.replaceContext(), which fires this hook. The conversation IS the
      // session's file belief -- verbatim reads gone, baselines and their
      // stale notices moot -- so drop both maps for the session. The write
      // guard releases with them: after a replacement there is no in-
      // conversation copy left to clobber from. Tracking rebuilds from the
      // next read/edit.
      [HOOKS.CONTEXT_REPLACED]: async ({ agent }) => {
        const key = sessionKey(agent);
        manifests.delete(key);
        pendingMaps.delete(key);
      },

      // Session teardown (session deleted, or a task agent released): the
      // same wholesale drop as CONTEXT_REPLACED, keyed directly -- the
      // payload carries no agent, the session is gone.
      [HOOKS.SESSION_END]: ({ sessionId }) => {
        manifests.delete(sessionId);
        pendingMaps.delete(sessionId);
      },

      // The one collision that destroys work silently: overwriting a file
      // with content held from before someone else's edit. edit fails closed
      // on its own (oldString no longer matches) and append cannot clobber,
      // so only overwrite needs the guard.
      //
      // A gate handler with no opinion returns NOTHING. A no-op
      // `{ action: "continue" }` is still adopted onto the payload, so this
      // handler would own a field another gate may need to set -- and,
      // running after a gate that blocked (e.g. a user-gate approval), its
      // "continue" would disarm that block. Returning nothing leaves the
      // payload exactly as the previous handler left it, whatever the
      // registration order.
      [HOOKS.TOOL_CALL]: async ({ toolName, input, agent }) => {
        if (!config.writeGuard || toolName !== "overwrite" || !agent) return;
        try {
          const raw = parsePathInput(input);
          if (!raw) return;
          const abs = resolvePath(raw);

          // Two ways the session's belief can be stale: live divergence from
          // the baseline, or a frozen pre-bash observation the index rebuild
          // moved past (disk matches the baseline, but the session has not
          // looked since).
          let kind: ChangeKind | null | undefined = getPending(agent, false)?.get(abs);
          if (kind === undefined) {
            const base = getManifest(agent, false)?.get(abs);
            kind = base ? await detectChange(abs, base) : null;
          }
          if (kind === null || kind === undefined) return;

          const what =
            kind === "deleted"
              ? "was deleted"
              : kind === "unreadable"
                ? "can no longer be read"
                : "was changed";
          return {
            action: "block",
            result:
              `file-watch: '${displayPath(abs)}' ${what} outside this session since you last read it. ` +
              `Another editor may be working on this file -- re-read it, then write again.`,
          };
        } catch (e: unknown) {
          // Fail open: this is a courtesy guard, not a security gate.
          logger.debug(`file-watch: guard check failed: ${formatError(e)}`);
          return;
        }
      },
    },
  };
}

/**
 * The primary workspace root the file tools resolve relative paths against.
 * Read the RESOLVED roots (`workspaceRoots`: concrete absolute paths, already
 * expanded and validated by buildConfig, and the source of the Workspace
 * service's primary root -- same as environment/file-attachment/handoff-tool
 * read). Re-expanding the raw `workspace.paths` here would miss the legacy
 * cwdBoundary/workspaceRoot fallbacks and redo tilde/glob work at load time.
 */
function resolvePrimaryRoot(core: CoreContext): string {
  const roots = (core.config as { workspaceRoots?: unknown } | undefined)?.workspaceRoots;
  const first = Array.isArray(roots) ? roots[0] : undefined;
  return typeof first === "string" && first.length > 0 ? first : process.cwd();
}
