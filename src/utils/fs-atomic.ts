/**
 * Atomic exclusive file creation primitive.
 *
 * Contents go to a sibling temp file which is then link(2)-ed into place:
 * existence and full contents become a single event. `writeFile(path, {flag:"wx"})`
 * is two syscalls (open, then write), leaving a window where the path exists but
 * reads empty -- a lock/claim file built that way gets misjudged as corrupt by a
 * concurrent reader and taken over from its live creator.
 *
 * A process crashing between the temp write and the link leaves a stray `.new-*`
 * sibling; protocols that key on the final path treat it as inert litter.
 *
 * If the link fails with ENOENT right after a successful write, something outside the protocol
 * deleted the temp sibling or the parent dir. The vanish is classified, repaired (mkdir -p / rewrite temp),
 * and the link retried once; the retry still goes through link(2), so EEXIST exclusivity is intact.
 * A failed repair warns with the classification (fail-open callers stay fail-open)
 * so future occurrences are diagnosable. An ENOENT from the temp write itself is NOT repaired:
 * a missing parent dir is the caller's problem, not external sabotage mid-create.
 */
import { randomBytes } from "node:crypto";
import { link, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { formatError } from "@core/error.ts";
import { logger } from "./logger.ts";

async function isGone(p: string): Promise<boolean> {
  try {
    await stat(p);
    return false;
  } catch {
    return true;
  }
}

/** True when this call created `path`; false when it already existed (EEXIST). Other fs errors throw. */
export async function createExclusive(path: string, contents: string): Promise<boolean> {
  // Hidden sibling temp (leading dot): never matches a prefix-glob of the
  // target file (slot-* ledgers count their own files by readdir).
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  const base = path.slice(path.lastIndexOf("/") + 1);
  const tmp = `${dir}.${base}.new-${process.pid}-${randomBytes(4).toString("hex")}`;
  const linkIn = async (): Promise<boolean> => {
    try {
      await link(tmp, path);
      return true;
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "EEXIST") return false;
      throw e;
    }
  };
  try {
    await writeFile(tmp, contents);
    try {
      return await linkIn();
    } catch (e: unknown) {
      if ((e as { code?: string }).code !== "ENOENT") throw e;
      const [tmpGone, dirGone] = await Promise.all([isGone(tmp), isGone(dir)]);
      const gone =
        tmpGone && dirGone
          ? "temp sibling and parent dir vanished"
          : dirGone
            ? "parent dir vanished"
            : tmpGone
              ? "temp sibling unlinked"
              : "transient vanish (both present at classify)";
      try {
        // mkdir -p unconditionally: the dir may vanish between classify and
        // the rewrite below, and mkdir is cheap and idempotent on this path.
        await mkdir(dir, { recursive: true });
        await writeFile(tmp, contents);
        const won = await linkIn();
        logger.warn(
          `[fs-atomic] ${path}: ${gone} between write and link (external deletion?); repaired, ${won ? "created" : "lost to a rival create"}`,
        );
        return won;
      } catch (e2: unknown) {
        logger.warn(
          `[fs-atomic] ${path}: ${gone} between write and link; repair failed: ${formatError(e2)}`,
        );
        throw e2;
      }
    }
  } finally {
    // force already ignores cleanup errors on the common paths; the try/catch
    // keeps exotic ones (rm rejecting at all) from masking the create result.
    try { await rm(tmp, { force: true }); } catch {}
  }
}
