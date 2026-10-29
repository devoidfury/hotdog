// Persisted fetch-policy approvals, backing the fetch-policy extension.
//
// The file lives in the config dir (next to defaults.json) and is owned by
// this layer: entries are appended on "always allow", hand-editable, and
// merge under the config's own allow list. Denies never live here -- a deny
// is config-only and cannot be created or lifted from a prompt.
//
// A corrupt or unreadable file reads as empty (fail toward prompting, never
// open). Writes go through a temp file + rename so a crash mid-write cannot
// truncate the state to nothing. Appends serialize through an in-process
// tail; concurrent hotdog processes over a shared config dir are last-writer-
// wins (documented ceiling -- the same shape as other config-dir state).
//
// Shape:
//   { "version": 1, "allow": [{ "origin": "https://api.github.com",
//                               "addedAt": "2026-10-29T...", "note": "fetch tool" }] }

import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { parseOriginRule } from "./policy.ts";

export const FETCH_POLICY_STATE_FILENAME = "fetch-policy.json";
const STATE_VERSION = 1;

export interface PersistedAllowEntry {
  /** Origin rule text, e.g. "https://api.github.com". */
  origin: string;
  /** ISO timestamp of when the human allowed it. */
  addedAt: string;
  note?: string;
}

/** Never throw: every failure path is a warning plus an empty allow list. */
export function readAllowEntries(path: string): PersistedAllowEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return []; // missing/unreadable file is the normal state
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    logger.warn(`[fetch-policy] ${path} is not valid JSON (${formatError(e)}); treating persisted allows as empty`);
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    logger.warn(`[fetch-policy] ${path} is not a JSON object; treating persisted allows as empty`);
    return [];
  }
  const state = parsed as { version?: unknown; allow?: unknown };
  if (state.version !== STATE_VERSION) {
    logger.warn(`[fetch-policy] ${path} has version ${JSON.stringify(state.version)}, expected ${STATE_VERSION}; treating persisted allows as empty`);
    return [];
  }
  if (!Array.isArray(state.allow)) {
    logger.warn(`[fetch-policy] ${path} has no allow array; treating persisted allows as empty`);
    return [];
  }
  const out: PersistedAllowEntry[] = [];
  const seen = new Set<string>();
  for (const item of state.allow) {
    if (typeof item !== "object" || item === null) {
      logger.warn(`[fetch-policy] ${path}: skipping non-object allow entry`);
      continue;
    }
    const entry = item as Partial<PersistedAllowEntry>;
    if (typeof entry.origin !== "string" || entry.origin.trim() === "") {
      logger.warn(`[fetch-policy] ${path}: skipping allow entry without an origin`);
      continue;
    }
    try {
      parseOriginRule(entry.origin); // an unparsable allow is a dead rule -- drop it and say so
    } catch (e) {
      logger.warn(`[fetch-policy] ${path}: skipping invalid origin '${entry.origin}' (${formatError(e)})`);
      continue;
    }
    const key = entry.origin.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      origin: key,
      addedAt: typeof entry.addedAt === "string" ? entry.addedAt : "",
      ...(typeof entry.note === "string" && entry.note !== "" ? { note: entry.note } : {}),
    });
  }
  return out;
}

/** Serialized so two sessions approving at once cannot clobber each other's append. */
let writeTail: Promise<unknown> = Promise.resolve();

/**
 * Append one allow entry (deduped by origin). Resolves true when the file
 * changed. Rejects on write failure -- the caller decides what a lost
 * persistence means (the session grant stands either way).
 */
export function appendAllowEntry(
  path: string,
  origin: string,
  note?: string,
): Promise<boolean> {
  const task = writeTail.then(async () => {
    const rule = origin.trim().toLowerCase();
    const entries = readAllowEntries(path);
    if (entries.some((e) => e.origin === rule)) return false;
    entries.push({
      origin: rule,
      addedAt: new Date().toISOString(),
      ...(note ? { note } : {}),
    });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.new`;
    const body = JSON.stringify({ version: STATE_VERSION, allow: entries }, null, 2) + "\n";
    await writeFile(tmp, body);
    await rename(tmp, path);
    return true;
  });
  writeTail = task.catch(() => {});
  return task;
}
