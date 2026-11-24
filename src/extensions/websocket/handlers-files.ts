// Workspace file listing, text reading, and the file ops for the webui
// workbench (C2S listDir / readFile / createFile / createDir / renamePath /
// deletePath / saveFile -> requestId-correlated S2C replies).
//
// CONFINEMENT IS THE WHOLE BALLGAME: this is a web socket reaching the
// filesystem. Hard rules:
// - The Workspace is constructed exactly like file-attachment/completions.ts
//   (the server process's resolved workspaceRoots + workspace.deny; a null
//   deny falls back to DEFAULT_DENY_PATTERNS inside the class).
// - EVERY path that arrives off the wire goes through Workspace.resolveSafe
//   BEFORE any fs call -- no pre-stat, no pre-read, no listing off a path
//   that did not pass the check. resolveSafe rejects direct (../) escapes,
//   symlink escapes (ancestor realpath walk + dangling-final-link probe),
//   and denylisted paths, on both the lexical and the real spelling. The
//   WRITE family runs the same gate on every side of every op (a rename
//   checks both paths; a create checks the target AND its parent dir).
// - Writes never invent parents (no mkdir -p), never clobber an existing
//   target, never touch a workspace root, never write THROUGH a symlink
//   (O_NOFOLLOW posture), and delete symlinked entries by unlinking the
//   link itself. saveFile lands atomically (per-op temp + rename, pin-store
//   posture) under a byte cap tied to the read cap, and every write op runs
//   its check-then-act critical section under a per-path lock, so two WIRE
//   ops on the same paths never interleave inside a gate (see the
//   Concurrency section below).
// - Rejections are honest one-line strings riding the reply's `error` field
//   (still requestId-correlated, so the tree renders the text on the row it
//   belongs to): no stacks, no absolute-path leakage beyond what the roots
//   listing itself already shows. formatError stays in the server log.
// - Replies go to the REQUESTING socket only (SessionRegistry.sendSafe).
//
// Listing a directory filters entries through the same deny semantics
// resolveSafe enforces (denylisted entries are OMITTED -- the tree must
// never offer dead ends). DEFAULT_DENY_PATTERNS consequently hides, at any
// depth: .ssh, .config, .git, .aws, .azure, .docker, .gnupg, .kube,
// dot-profiles (.*profile), dotfiles ending in rc (.*rc), *.local*, and
// .env* (with .env.example carved back in by the `!` rule). A root at or
// below a denied level is trusted (the class's root exception, mirrored
// below). Expanding a symlink whose target escapes roots/deny, or reading
// one, is refused by resolveSafe itself with an honest error.

import path from "node:path";
import fsPromises from "node:fs/promises";
import type { Stats } from "node:fs";
import { cwd } from "node:process";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { Workspace, PathEscapeError, pathMatchesRule } from "@utils/workspace.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import {
  S2C,
  errorFrame,
  errorText,
  MAX_LIST_DIR_ENTRIES,
  MAX_FILE_READ_CHARS,
  MAX_FILE_WRITE_BYTES,
  READ_LINES_DEFAULT,
  MAX_READ_LINES,
  type DirEntryWire,
  type FileOpResultWire,
  type ListDirResultWire,
  type ReadFileResultWire,
} from "./protocol.ts";
import { SessionRegistry } from "./session-registry.ts";
import type { RouteContext } from "./route-types.ts";

/** Bytes inspected for the binary verdict (NUL byte / failed streaming
 *  UTF-8 decode) before any page is assembled. */
const BINARY_PROBE_BYTES = 8192;
/** Read granularity while scanning for line boundaries. */
const READ_CHUNK_BYTES = 65536;

/** The file-attachment/completions.ts construction, verbatim in shape: the
 *  server process's resolved roots and deny rules; null/undefined both mean
 *  "unconfigured" and fall back to the class defaults. Built per request so
 *  a config change picked up by the running process is honored. Exported for
 *  the webui download route (same gate, same per-request construction). */
export function workspaceFor(core: CoreContext | undefined): Workspace {
  const roots = (core?.resolved?.workspaceRoots as string[] | undefined) ?? [cwd()];
  const deny = core?.resolved?.workspaceDeny as readonly string[] | null | undefined;
  return deny != null ? new Workspace(roots, deny) : new Workspace(roots);
}

/** Owning root of a lexical absolute path (null when outside every root).
 *  Mirrors workspace.ts's private `within` (that module is out of this
 *  phase's scope); resolveSafe stays the authoritative gate for every fs
 *  touch -- this only feeds the listing filter's root exception. */
function ownerOf(roots: string[], absolutePath: string): string | null {
  for (const r of roots) {
    if (absolutePath === r || absolutePath.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) {
      return r;
    }
  }
  return null;
}

/**
 * Denylist verdict for a directory-listing candidate, mirroring
 * Workspace.#deniedRule exactly (gitignore-style order, last match wins,
 * `!` negations, root exception) via the exported pathMatchesRule. The
 * authoritative check on expand/read is resolveSafe itself; mirroring keeps
 * the listing free of dead ends without paying a realpath walk per entry.
 */
function deniedRuleFor(workspace: Workspace, absolutePath: string): string | null {
  const owner = ownerOf(workspace.roots, absolutePath);
  if (owner === null) return null; // never reached in practice: the listed dir passed resolveSafe
  const comps = absolutePath.split(path.sep).filter(Boolean);
  const ownerComps = owner.split(path.sep).filter(Boolean);
  let matched: string | null = null;
  let denied = false;
  for (const candidate of workspace.deniedPatterns) {
    const negated = candidate.startsWith("!");
    const rule = negated ? candidate.slice(1) : candidate;
    if (!negated && pathMatchesRule(ownerComps, rule)) continue; // the root itself is trusted
    if (pathMatchesRule(comps, rule)) {
      matched = candidate;
      denied = !negated;
    }
  }
  return denied ? matched : null;
}

/** One-line honest text for a readdir failure the pre-stat did not predict. */
function fsErrorMessage(err: unknown, display: string): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ENOENT") return `not found: ${display}`;
  if (code === "EACCES" || code === "EPERM") return `permission denied: ${display}`;
  return errorText(err);
}

/** EscapeError -> its honest message; an fs permission refusal caught
 *  INSIDE resolveSafe (a mode-000 ancestor: macOS denies realpath on it,
 *  workspace.ts's walk) -> the same honest permission line the readdir
 *  catch uses, when the caller passes the display spelling. Anything else
 *  rethrows (the caller's catch logs formatError and sends errorFrame). */
function rejectionsAreHonest(e: unknown, display?: string): { error: string } | never {
  if (e instanceof PathEscapeError) return { error: e.message };
  if (display !== undefined) {
    const code = (e as { code?: string } | null)?.code;
    if (code === "EACCES" || code === "EPERM") return { error: `permission denied: ${display}` };
  }
  throw e;
}

// ── listDir ─────────────────────────────────────────────────────────────────

const byDirsThenName = (a: { name: string; isDirectory(): boolean }, b: { name: string; isDirectory(): boolean }): number => {
  const ad = a.isDirectory() ? 0 : 1;
  const bd = b.isDirectory() ? 0 : 1;
  if (ad !== bd) return ad - bd;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

/**
 * Build the listDir payload for one off-the-wire path. resolveSafe runs
 * BEFORE any fs call; entries then carry the deny filter (omission, never a
 * dead-end row), a dirs-first/name sort, and the entry cap with an honest
 * truncated flag. Symlinks ride as themselves (isSymlink, target unresolved).
 * Exported for tests.
 */
export async function listDirPayload(
  workspace: Workspace,
  rawPath: unknown,
): Promise<Partial<ListDirResultWire>> {
  const display = String(rawPath);
  let resolved: string;
  try {
    resolved = workspace.resolveSafe(rawPath as string);
  } catch (e) {
    return rejectionsAreHonest(e, display);
  }
  let dirStat: Awaited<ReturnType<typeof fsPromises.stat>>;
  try {
    dirStat = await fsPromises.stat(resolved);
  } catch {
    return { error: `not found: ${display}` };
  }
  if (!dirStat.isDirectory()) return { error: `not a directory: ${display}` };

  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fsPromises.readdir(resolved, { withFileTypes: true });
  } catch (e) {
    return { error: fsErrorMessage(e, display) };
  }

  const kept = dirents.filter((d) => deniedRuleFor(workspace, path.join(resolved, d.name)) === null);
  kept.sort(byDirsThenName);
  const slice = kept.slice(0, MAX_LIST_DIR_ENTRIES);

  const entries: DirEntryWire[] = [];
  for (const d of slice) {
    const childPath = path.join(resolved, d.name);
    const entry: DirEntryWire = { name: d.name, path: childPath, isDir: d.isDirectory() };
    if (d.isSymbolicLink()) entry.isSymlink = true;
    try {
      const st = await fsPromises.lstat(childPath); // lstat: links stay links
      if (st.isFile()) entry.size = st.size;
      entry.mtime = Math.round(st.mtimeMs);
    } catch {
      // raced away between readdir and lstat: name/path/kind still ride.
    }
    entries.push(entry);
  }
  const out: Partial<ListDirResultWire> = { path: resolved, entries };
  if (kept.length > MAX_LIST_DIR_ENTRIES) out.truncated = true;
  return out;
}

export async function handleListDir(ctx: RouteContext): Promise<void> {
  const { ws, msg, core } = ctx;
  const requestId = typeof msg.requestId === "number" ? msg.requestId : undefined;
  if (msg.path === undefined || msg.path === null) {
    // Roots listing: exactly the configured workspace roots, ZERO fs calls
    // (the wire carried no path to check; the roots are the config's own
    // spelling, already absolute).
    const roots = workspaceFor(core).roots.map((r) => ({
      name: path.basename(r) || r,
      path: r,
    }));
    // requestId rides last so an echoed non-number (undefined) simply drops
    // out of the JSON instead of shadowing the payload (handlers-config).
    SessionRegistry.sendSafe(ws, { type: S2C.LIST_DIR_RESULT, roots, requestId });
    return;
  }
  // Awaited for the settle contract: the listing is real I/O.
  await listDirPayload(workspaceFor(core), msg.path)
    .then((payload) => {
      SessionRegistry.sendSafe(ws, { ...payload, type: S2C.LIST_DIR_RESULT, requestId });
    })
    .catch((err: unknown) => {
      logger.warn(`[websocket] listDir failed: ${formatError(err)}`);
      SessionRegistry.sendSafe(ws, errorFrame(err));
    });
}

// ── readFile ────────────────────────────────────────────────────────────────

/**
 * Read one line-addressed page of a text file. Bytes are scanned from the
 * start (line addressing needs the offsets); the scan EXITS EARLY once the
 * window is complete, and the char cap bounds what ships. Known ceiling,
 * deliberate: a deep offset still reads (not buffers more than one page,
 * but reads) through the skipped bytes -- fine for a browsing viewer, a
 * Phase 7 concern if it starts hopping deep into megabyte files.
 *
 * The binary verdict rides the first BINARY_PROBE_BYTES: a NUL byte or a
 * failed streaming UTF-8 decode refuses with "binary file (N bytes)"; the
 * reply then carries ZERO content bytes (the caller only sets content on
 * success). Page boundaries are LINE boundaries, so consecutive pages
 * concatenate byte-identical; a single line over MAX_FILE_READ_CHARS is
 * refused honestly, never sliced.
 */
async function readTextPage(
  resolved: string,
  size: number,
  offset: number,
  limit: number,
): Promise<{ content: string; truncated: boolean } | { error: string }> {
  const binaryError = `binary file (${size} bytes) -- not displayed`;
  const handle = await fsPromises.open(resolved, "r");
  try {
    const chunks: Buffer[] = [];
    const lineEnds: number[] = []; // absolute index of every '\n' read so far
    let pos = 0;
    let eof = false;
    let probeDone = false;
    const probeNeed = Math.min(BINARY_PROBE_BYTES, size);
    const probeDecoder = new TextDecoder("utf-8", { fatal: true });

    while (true) {
      if (probeDone && lineEnds.length >= offset + limit) break; // window complete
      const want = probeDone ? READ_CHUNK_BYTES : Math.min(READ_CHUNK_BYTES, probeNeed - pos);
      if (want <= 0) {
        probeDone = true; // empty file / probe window already covered
        continue;
      }
      const tmp = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(tmp, 0, want, pos);
      if (bytesRead === 0) {
        eof = true;
        break;
      }
      const piece = Buffer.from(tmp.subarray(0, bytesRead)); // copy out of the reusable buffer
      if (!probeDone) {
        if (piece.includes(0)) return { error: binaryError };
        try {
          probeDecoder.decode(piece, { stream: true }); // stream: an incomplete codepoint at the WINDOW edge is not an error
        } catch {
          return { error: binaryError };
        }
        if (pos + bytesRead >= probeNeed) probeDone = true;
      }
      for (let i = 0; i < bytesRead; i++) if (piece[i] === 0x0a) lineEnds.push(pos + i);
      chunks.push(piece);
      pos += bytesRead;
    }

    const data = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, pos);
    // Line k spans [k === 0 ? 0 : lineEnds[k-1] + 1, k < lineEnds.length ? lineEnds[k] + 1 : pos).
    // A trailing partial line (bytes past the last '\n' at EOF) counts as a line.
    const bytesThroughLastNewline = lineEnds.length === 0 ? 0 : lineEnds[lineEnds.length - 1]! + 1;
    const totalLines = lineEnds.length + (eof && pos > bytesThroughLastNewline ? 1 : 0);
    if (offset >= totalLines) return { content: "", truncated: false };

    const picked: Buffer[] = [];
    let pickedBytes = 0;
    let cursor = offset;
    let hitCap = false;
    while (cursor < totalLines && picked.length < limit) {
      const start = cursor === 0 ? 0 : lineEnds[cursor - 1]! + 1;
      const end = cursor < lineEnds.length ? lineEnds[cursor]! + 1 : pos;
      const len = end - start;
      if (picked.length === 0 && len > MAX_FILE_READ_CHARS) {
        return { error: `line ${cursor + 1} is longer than the ${MAX_FILE_READ_CHARS}-char read cap` };
      }
      if (pickedBytes + len > MAX_FILE_READ_CHARS) {
        hitCap = true;
        break;
      }
      picked.push(data.subarray(start, end));
      pickedBytes += len;
      cursor++;
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(
        picked.length === 1 ? picked[0]! : Buffer.concat(picked),
      );
    } catch {
      return { error: binaryError }; // undecodable bytes past the probe window
    }
    return { content, truncated: hitCap || !eof };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Build the readFile payload for one off-the-wire path. resolveSafe runs
 *  BEFORE any fs call. Exported for tests. */
export async function readPayload(
  workspace: Workspace,
  rawPath: unknown,
  offset: number,
  limit: number,
): Promise<Partial<ReadFileResultWire>> {
  const display = String(rawPath);
  let resolved: string;
  try {
    resolved = workspace.resolveSafe(rawPath as string);
  } catch (e) {
    return rejectionsAreHonest(e, display);
  }
  let st: Awaited<ReturnType<typeof fsPromises.stat>>;
  try {
    st = await fsPromises.stat(resolved);
  } catch {
    return { error: `not found: ${display}` };
  }
  if (st.isDirectory()) return { error: `${display} is a directory -- use listDir` };
  if (!st.isFile()) return { error: `not a regular file: ${display}` };

  const page = await readTextPage(resolved, st.size, offset, limit);
  if ("error" in page) return { error: page.error };
  const out: Partial<ReadFileResultWire> = {
    path: display,
    offset,
    content: page.content,
    // The editor's BASE for the saveFile conflict gate (same rounding as
    // the gate compares against). Absent only when the page refused.
    mtimeMs: Math.round(st.mtimeMs),
  };
  if (page.truncated) out.truncated = true;
  return out;
}

export async function handleReadFile(ctx: RouteContext): Promise<void> {
  const { ws, msg, core } = ctx;
  const requestId = typeof msg.requestId === "number" ? msg.requestId : undefined;
  // offset = lines to SKIP (0-based, the core read tool's grammar); limit =
  // lines to return. Garbage numbers clamp to defaults rather than 500-ing:
  // this is a paging hint, not a trust boundary.
  const offset =
    typeof msg.offset === "number" && Number.isFinite(msg.offset) && msg.offset > 0
      ? Math.trunc(msg.offset)
      : 0;
  const limit =
    typeof msg.limit === "number" && Number.isFinite(msg.limit) && msg.limit >= 1
      ? Math.min(Math.trunc(msg.limit), MAX_READ_LINES)
      : READ_LINES_DEFAULT;
  // Awaited for the settle contract: the read is real I/O.
  await readPayload(workspaceFor(core), msg.path, offset, limit)
    .then((payload) => {
      SessionRegistry.sendSafe(ws, { ...payload, type: S2C.READ_FILE_RESULT, requestId });
    })
    .catch((err: unknown) => {
      logger.warn(`[websocket] readFile failed: ${formatError(err)}`);
      SessionRegistry.sendSafe(ws, errorFrame(err));
    });
}

// ── File ops (create / rename / delete / save) ──────────────────────────────
// The write family shares the read path's doctrine: resolveSafe BEFORE any
// fs call, honest one-liners on the reply's error field, replies correlated
// by requestId (one FILE_OP_RESULT envelope per family -- the id names the
// op). What the UI confirms (recursive deletes, overwrites) is its business;
// the server's contract is the gates below, stated in code.

/** lstat without following links: the write family decides on the entry ITSELF
 *  (a symlink stays a symlink, never its target). null = nothing at the path. */
async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fsPromises.lstat(target);
  } catch {
    return null;
  }
}

/** Gate the directory a write LANDS in -- required for EVERY create/write/
 *  move destination. Why the target's own resolveSafe is not enough: the
 *  REAL-spelling deny recheck inside Workspace.resolveSafe fires only when
 *  realpathSync of the checked path succeeds; a NON-EXISTENT final component
 *  (exactly what a create/save/rename lands) falls back to the LEXICAL
 *  spelling -- and the link name in that spelling hides the denied directory
 *  behind it (`x -> .ssh`, `g -> .git`: in-root links the ancestor walk
 *  deliberately blesses, because escape and deny are different questions).
 *  Without this gate a create/save/rename lands in .ssh/.git through such
 *  links while the direct spelling of the same path refuses. The parent is
 *  the fs object that actually receives the bytes: if it exists its realpath
 *  succeeds and the deny recheck fires; if it does not, the fs effect fails
 *  ENOENT on its own (no parents are ever invented). */
function gateLandingDir(workspace: Workspace, resolvedTarget: string): { error: string } | null {
  try {
    workspace.resolveSafe(path.dirname(resolvedTarget));
    return null;
  } catch (e) {
    return rejectionsAreHonest(e);
  }
}

// ── Concurrency: per-path write locks ────────────────────────────────────────
// Every write op is a check-then-act (exists? gate! write; target exists?
// move). Async, two sockets can interleave INSIDE that critical section:
// two same-path saves otherwise stream into the shared pid temp, landing
// mixed bytes, ENOENT-ing the losing rename, and answering success
// for writes that did not land. The codebase's precedent for concurrent
// async wire writes is handlers-config (per-op temp sequence + one file's
// edits never concurrent); pin-store's bare-pid temp is safe ONLY because
// writeFileSync cannot interleave. So: a promise chain per exact path -- the
// whole critical section (gate + fs effect) of one op runs with no other
// write-family op on the SAME paths in flight. renamePath takes BOTH locks,
// always in sorted order, so no circular wait exists. Keys are exact named
// paths: a recursive delete of D does NOT lock children created under D --
// that (and non-family processes touching the tree concurrently) remains the
// documented single-user/loopback ceiling. The map drains: an entry outlives
// its last queued op by one microtask and nothing else.

const pathChains = new Map<string, Promise<unknown>>();
const lockNoop = (): void => {};
/** Temp-name sequence (handlers-config idiom): every saveFile op gets its own
 *  temp name even inside one process -- the pid alone cannot separate two
 *  async saves of the same path. */
let saveSeq = 0;

function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = pathChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn); // the stored chain never rejects, but drains either way
  const tail = run.then(lockNoop, lockNoop);
  pathChains.set(key, tail);
  void tail.then(() => {
    if (pathChains.get(key) === tail) pathChains.delete(key);
  });
  return run;
}

function withPathLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(keys)].sort(); // same order for every op: no deadlock
  if (sorted.length === 0) return fn();
  return withPathLock(sorted[0]!, () => withPathLocks(sorted.slice(1), fn));
}

/** Build the createFile/createDir payload. Target passes resolveSafe (which
 *  also probes dangling final links); the landing dir passes it too
 *  (gateLandingDir), since the create lands bytes in it. Nothing that exists
 *  is clobbered: "wx" / bare mkdir are the atomic exists-gates themselves. */
export async function createPayload(
  workspace: Workspace,
  rawPath: unknown,
  kind: "file" | "dir",
): Promise<Partial<FileOpResultWire>> {
  const display = String(rawPath);
  let resolved: string;
  try {
    resolved = workspace.resolveSafe(rawPath as string);
  } catch (e) {
    return rejectionsAreHonest(e, display);
  }
  const landing = gateLandingDir(workspace, resolved);
  if (landing !== null) return landing;
  try {
    if (kind === "file") {
      // O_CREAT|O_EXCL: fails EEXIST on ANY existing entry, symlink included.
      const handle = await fsPromises.open(resolved, "wx");
      await handle.close();
    } else {
      await fsPromises.mkdir(resolved); // NO recursive: parents must already exist
    }
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code === "EEXIST") return { error: `already exists: ${display}` };
    if (code === "ENOENT") return { error: `parent directory not found: ${display}` };
    return { error: fsErrorMessage(e, display) };
  }
  return { path: resolved };
}

/** Build the renamePath payload. BOTH sides pass resolveSafe before anything
 *  moves, so a rename that carries a directory subtree lands it wherever
 *  roots/deny say the NEW spelling does -- a destination under a deny rule or
 *  outside the roots refuses the WHOLE op, and a legal one moves the subtree
 *  with it (rename is atomic within a filesystem; the children ride). The
 *  exists-target gate and the move run under the per-path locks (both sides),
 *  so racing WIRE renames cannot double-land on one target. Residual ceiling,
 *  stated: rename has no no-replace primitive -- a target created by a
 *  NON-family process in the check-to-move window still loses (single-user
 *  loopback seam). */
export async function renamePayload(
  workspace: Workspace,
  rawOldPath: unknown,
  rawNewPath: unknown,
): Promise<Partial<FileOpResultWire>> {
  let from: string;
  let to: string;
  try {
    from = workspace.resolveSafe(rawOldPath as string);
    to = workspace.resolveSafe(rawNewPath as string);
  } catch (e) {
    return rejectionsAreHonest(e);
  }
  const oldDisplay = String(rawOldPath);
  const newDisplay = String(rawNewPath);
  // The roots themselves are config, not tree content: unrenamable.
  if (workspace.roots.includes(from)) {
    return { error: `cannot rename a workspace root: ${oldDisplay}` };
  }
  // The destination's landing dir is gated too: the NEW final component does
  // not exist yet, so the target's own resolveSafe falls back to the LEXICAL
  // spelling where an in-root link (`d -> .ssh`) hides the denied directory.
  const landing = gateLandingDir(workspace, to);
  if (landing !== null) return landing;
  // LOCKED critical section (see withPathLocks): the exists-gates and the
  // move are one unit, so a second rename onto the SAME target answers
  // "target already exists" instead of clobbering the first one's landing.
  // The residual ceiling (stated, pinned in tests): a target created by a
  // NON-family process between check and rename still loses -- rename has
  // no no-replace primitive; this seam's contract is concurrent WIRE ops.
  return withPathLocks([from, to], async () => {
    const fromStat = await lstatOrNull(from);
    if (fromStat === null) return { error: `not found: ${oldDisplay}` };
    if ((await lstatOrNull(to)) !== null) return { error: `target already exists: ${newDisplay}` };
    try {
      await fsPromises.rename(from, to);
    } catch (e) {
      return { error: fsErrorMessage(e, oldDisplay) };
    }
    return { path: to };
  });
}

/** Build the deletePath payload. The UI confirms first (its copy states the
 *  recursive truth for directories); the server just deletes -- recursion is
 *  the contract. A
 *  workspace root is refused (it is config, not content). Symlinked entries
 *  are UNLINKED, never followed: the verdict comes from lstat, and unlink
 *  removes the link, never its target. */
export async function deletePayload(
  workspace: Workspace,
  rawPath: unknown,
): Promise<Partial<FileOpResultWire>> {
  const display = String(rawPath);
  let resolved: string;
  try {
    resolved = workspace.resolveSafe(rawPath as string);
  } catch (e) {
    return rejectionsAreHonest(e, display);
  }
  if (workspace.roots.includes(resolved)) {
    return { error: `cannot delete a workspace root: ${display}` };
  }
  // LOCKED critical section: the entry verdict (link vs tree) and the removal
  // are one unit against the other LOCKED ops (save's write, a rename landing
  // here). Stated ceiling: rm -r descends a directory without locking each
  // child -- concurrent writes UNDER a deleting dir keep the loopback
  // single-user contract.
  return withPathLock(resolved, async () => {
    const st = await lstatOrNull(resolved);
    if (st === null) return { error: `not found: ${display}` };
    try {
      if (st.isSymbolicLink()) {
        await fsPromises.unlink(resolved); // the link goes; its target survives
      } else {
        // rm's recursive walk does not traverse INTO symlinks either.
        await fsPromises.rm(resolved, { recursive: true });
      }
    } catch (e) {
      return { error: fsErrorMessage(e, display) };
    }
    return { path: resolved };
  });
}

/** Build the saveFile payload -- the editor's write seam. Gates, in order:
 *  byte cap (refused BEFORE anything is touched; see MAX_FILE_WRITE_BYTES
 *  for the chars-vs-bytes math), resolveSafe, then the entry itself:
 *  directories and SYMLINKS at the path are refused outright (O_NOFOLLOW
 *  posture -- this seam never writes THROUGH a link, even one whose target
 *  passed the gate; creating a NEW file at a free path is fine). Conflict
 *  gate: an existing file whose rounded mtimeMs differs from the caller's
 *  baseMtimeMs (create-then-save sends 0/absent, which any real file beats)
 *  refuses with conflict:true + the CURRENT mtime and zero bytes written.
 *  The write is ATOMIC (pin-store precedent): temp in the SAME directory,
 *  rename into place, best-effort temp unlink on failure. The WHOLE section
 *  -- conflict gate, temp write, rename -- runs under the per-path lock (see
 *  "Concurrency" above). Serialized, the conflict
 *  gate keeps its meaning under racing saves with one base: EXACTLY ONE
 *  writer answers ok and the other answers conflict:true carrying the
 *  winner's fresh mtime (the documented overwrite-or-reload flow) -- never a
 *  lost write reported as success. */
export async function saveFilePayload(
  workspace: Workspace,
  rawPath: unknown,
  content: unknown,
  rawBaseMtimeMs: unknown,
): Promise<Partial<FileOpResultWire>> {
  if (typeof content !== "string") return { error: "content must be a string" };
  // Cap FIRST: a too-large frame is refused before its path is even parsed.
  const byteLen = Buffer.byteLength(content, "utf8");
  if (byteLen > MAX_FILE_WRITE_BYTES) {
    return { error: `content is ${byteLen} bytes, over the ${MAX_FILE_WRITE_BYTES}-byte write cap` };
  }
  const display = String(rawPath);
  let resolved: string;
  try {
    resolved = workspace.resolveSafe(rawPath as string);
  } catch (e) {
    return rejectionsAreHonest(e, display);
  }
  // Landing-dir gate (see gateLandingDir): a NEW file at a free path is a
  // non-existent final component, so the target's resolveSafe never fires its
  // real-spelling deny recheck -- an in-root link (`w -> .ssh`) would swallow
  // the temp+rename into the denied directory.
  const landing = gateLandingDir(workspace, resolved);
  if (landing !== null) return landing;
  // LOCKED critical section (see "Concurrency" above): gate + temp + rename
  // are ONE unit per path. The per-op sequence (handlers-config's idiom --
  // pin-store needs neither, its writeFileSync cannot interleave) plus the
  // lock make the temp exclusive
  // per op, and the conflict gate now SEES the racing commit: with one shared
  // base exactly one writer answers ok, the other answers conflict:true with
  // the fresh mtime -- never two oks over a lost write.
  return withPathLock(resolved, async () => {
    const st = await lstatOrNull(resolved);
    if (st !== null) {
      if (st.isSymbolicLink()) return { error: `refusing to write through a symlink: ${display}` };
      if (st.isDirectory()) return { error: `${display} is a directory -- not a file` };
      if (!st.isFile()) return { error: `not a regular file: ${display}` };
      const base =
        typeof rawBaseMtimeMs === "number" && Number.isFinite(rawBaseMtimeMs) && rawBaseMtimeMs >= 0
          ? Math.trunc(rawBaseMtimeMs)
          : 0;
      const current = Math.round(st.mtimeMs);
      if (current !== base) {
        return {
          conflict: true,
          mtimeMs: current,
          error: `${display} changed on disk since it was read -- reload or overwrite deliberately`,
        };
      }
    }
    const tmp = `${resolved}.${process.pid}.${++saveSeq}.save.tmp`; // exclusive per op: same-path saves are serialized, different paths never collide, other processes differ by pid
    try {
      await fsPromises.writeFile(tmp, content, "utf8");
      await fsPromises.rename(tmp, resolved);
    } catch (e) {
      await fsPromises.unlink(tmp).catch(() => {}); // the original is untouched; sweep the temp
      return { error: fsErrorMessage(e, display) };
    }
    const after = await lstatOrNull(resolved);
    const out: Partial<FileOpResultWire> = { path: resolved };
    if (after !== null) out.mtimeMs = Math.round(after.mtimeMs); // the editor's NEW base
    return out;
  });
}

/** Reply idiom shared by the whole write family: awaited payload (settle
 *  contract), FILE_OP_RESULT with the requestId echoed LAST (a non-number
 *  simply drops out of the JSON), unexpected errors logged with formatError
 *  and answered with a plain errorFrame. */
async function replyFileOp(
  ctx: RouteContext,
  label: string,
  payload: Promise<Partial<FileOpResultWire>>,
): Promise<void> {
  const { ws, msg } = ctx;
  const requestId = typeof msg.requestId === "number" ? msg.requestId : undefined;
  await payload
    .then((p) => {
      SessionRegistry.sendSafe(ws, { ...p, type: S2C.FILE_OP_RESULT, requestId });
    })
    .catch((err: unknown) => {
      logger.warn(`[websocket] ${label} failed: ${formatError(err)}`);
      SessionRegistry.sendSafe(ws, errorFrame(err));
    });
}

export async function handleCreateFile(ctx: RouteContext): Promise<void> {
  await replyFileOp(ctx, "createFile", createPayload(workspaceFor(ctx.core), ctx.msg.path, "file"));
}

export async function handleCreateDir(ctx: RouteContext): Promise<void> {
  await replyFileOp(ctx, "createDir", createPayload(workspaceFor(ctx.core), ctx.msg.path, "dir"));
}

export async function handleRenamePath(ctx: RouteContext): Promise<void> {
  await replyFileOp(
    ctx,
    "renamePath",
    renamePayload(workspaceFor(ctx.core), ctx.msg.oldPath, ctx.msg.newPath),
  );
}

export async function handleDeletePath(ctx: RouteContext): Promise<void> {
  await replyFileOp(ctx, "deletePath", deletePayload(workspaceFor(ctx.core), ctx.msg.path));
}

export async function handleSaveFile(ctx: RouteContext): Promise<void> {
  await replyFileOp(
    ctx,
    "saveFile",
    saveFilePayload(workspaceFor(ctx.core), ctx.msg.path, ctx.msg.content, ctx.msg.baseMtimeMs),
  );
}
