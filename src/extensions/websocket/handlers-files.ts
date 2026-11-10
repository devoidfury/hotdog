// Workspace file listing + text reading for the webui workbench (C2S
// listDir / readFile -> requestId-correlated S2C replies).
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
//   and denylisted paths, on both the lexical and the real spelling.
// - READ-ONLY. Zero writes, zero new config keys.
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
  READ_LINES_DEFAULT,
  MAX_READ_LINES,
  type DirEntryWire,
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
 *  a config change picked up by the running process is honored. */
function workspaceFor(core: CoreContext | undefined): Workspace {
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

/** EscapeError -> its honest message; anything else rethrows (the
 *  caller's catch logs formatError and sends errorFrame). */
function rejectionsAreHonest(e: unknown): { error: string } | never {
  if (e instanceof PathEscapeError) return { error: e.message };
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
  let resolved: string;
  try {
    resolved = workspace.resolveSafe(rawPath as string);
  } catch (e) {
    return rejectionsAreHonest(e);
  }
  const display = String(rawPath);
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
  let resolved: string;
  try {
    resolved = workspace.resolveSafe(rawPath as string);
  } catch (e) {
    return rejectionsAreHonest(e);
  }
  const display = String(rawPath);
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
  const out: Partial<ReadFileResultWire> = { path: display, offset, content: page.content };
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
