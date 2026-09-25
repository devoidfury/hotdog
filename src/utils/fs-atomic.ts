/**
 * Atomic exclusive file creation primitive.
 *
 * Contents go to a sibling temp file which is then link(2)-ed into place:
 * existence and full contents become a single event. `writeFile(path, {flag:"wx"})`
 * is two syscalls (open, then write), leaving a window where the path exists but
 * reads empty -- a lock/claim file built that way gets misjudged as corrupt by a
 * concurrent reader and taken over from its live creator (measured over-admission
 * in LaneLedger: cap 2 gave 3-4 winners in ~7% of 5-way concurrent acquires).
 * link(2) fails with EEXIST when the target exists, so exclusivity is unchanged.
 *
 * A process crashing between the temp write and the link leaves a stray `.new-*`
 * sibling; protocols that key on the final path treat it as inert litter.
 */
import { randomBytes } from "node:crypto";
import { link, rm, writeFile } from "node:fs/promises";

/** True when this call created `path`; false when it already existed (EEXIST). Other fs errors throw. */
export async function createExclusive(path: string, contents: string): Promise<boolean> {
  // Hidden sibling temp (leading dot): never matches a prefix-glob of the
  // target file (slot-* ledgers count their own files by readdir).
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  const base = path.slice(path.lastIndexOf("/") + 1);
  const tmp = `${dir}.${base}.new-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, contents);
    try {
      await link(tmp, path);
      return true;
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "EEXIST") return false;
      throw e;
    }
  } finally {
    // force already ignores cleanup errors on the common paths; the try/catch
    // keeps exotic ones (rm rejecting at all) from masking the create result.
    try { await rm(tmp, { force: true }); } catch {}
  }
}
