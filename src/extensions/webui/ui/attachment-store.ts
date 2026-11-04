/// <reference lib="dom" />
// Pending-attachment persistence: staged composer files survive a page
// reload, the same doctrine as draft.ts -- every read/write is swallowed at
// this boundary, so a blocked or throwing localStorage (private-mode Safari)
// can never break the app. Writes are best-effort too: base64 payloads are
// big and localStorage is ~5MB per origin, so a quota-exceeded save simply
// keeps the previous snapshot (a reload may restore a slightly stale chip
// set; every file is re-validated server-side on send regardless).

import type { DraftStorage } from "./draft.ts";

/** A staged composer file riding along with the next message. */
export interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  data: string; // base64, no data: prefix
}

/** Storage shape: ids are per-boot handles (chip keys / removal), so only
 *  the payload round-trips and ids are re-minted on hydrate. */
export type StoredAttachment = Omit<PendingAttachment, "id">;

const ATTACHMENTS_STORAGE_KEY = "hotdog-webui-attachments";
export { ATTACHMENTS_STORAGE_KEY };

function resolveStorage(storage?: DraftStorage): DraftStorage | null {
  if (storage) return storage;
  try {
    return window.localStorage ?? null;
  } catch {
    return null; // accessing localStorage itself can throw
  }
}

/** Snapshot every staged file; an empty set clears the key. */
export function saveAttachments(items: PendingAttachment[], storage?: DraftStorage): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    if (items.length === 0) {
      s.removeItem(ATTACHMENTS_STORAGE_KEY);
      return;
    }
    const payload: StoredAttachment[] = items.map(({ name, mimeType, size, data }) => ({
      name,
      mimeType,
      size,
      data,
    }));
    s.setItem(ATTACHMENTS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // quota exceeded / blocked storage: the chips stay usable this session,
    // they just don't survive the reload.
  }
}

export function loadAttachments(storage?: DraftStorage): StoredAttachment[] {
  const s = resolveStorage(storage);
  if (!s) return [];
  try {
    const raw = s.getItem(ATTACHMENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredAttachment);
  } catch {
    return [];
  }
}

function isStoredAttachment(v: unknown): v is StoredAttachment {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Partial<StoredAttachment>;
  return (
    typeof a.name === "string" &&
    a.name !== "" &&
    typeof a.mimeType === "string" &&
    typeof a.data === "string" &&
    a.data !== "" &&
    typeof a.size === "number" &&
    Number.isFinite(a.size) &&
    a.size >= 0
  );
}
