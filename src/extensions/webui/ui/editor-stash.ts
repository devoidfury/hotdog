/// <reference lib="dom" />
// HOT EXIT: the dirty-buffer stash. One sessionStorage record per BROWSER TAB
// mirrors every dirty editor buffer (path -> { text, baseMtimeMs, stashedAt })
// so a hard reload or a crash no longer destroys unsaved work: the workbench
// tab strip already survives reloads, and on the next load the buffer whose
// disk file is UNTOUCHED (mtime == the stashed base) comes back as the stashed
// text, dirty against the disk baseline (the content-derived dirty rule does
// the rest). When the file moved underneath (agent wrote it), nothing merges
// silently -- the caller offers the two doors.
//
// Per-tab doctrine (chat.ts, workbench.tsx): sessionStorage, never
// localStorage -- localStorage is shared across tabs of one webui, so tab B's
// reload would restore tab A's edits. The record key additionally carries a
// TAB-INSTANCE id minted once per browser tab (stored in that same
// sessionStorage, so an in-tab reload -- the case we serve -- reads the same
// id back); the keying makes the isolation explicit and testable even if two
// stores were ever pointed at one shared backend.
//
// Lifetime: sessionStorage's own. Close the tab/browser, the stash dies with
// it -- the documented v1 boundary. No server-side hot exit, no localStorage
// fallback.
//
// Storage doctrine rides the seam (workbench.tsx): resolve per call, never
// cache; reads swallow (blocked storage simply means no stash). WRITES are
// not silent, though: a setItem/removeItem failure (quota, ~5MB with buffers
// capped at 256KB each) marks the store quota-failed ONCE and notifies
// onQuota -- the app turns that into a status-chrome indicator plus a toast.
// A failed stash NEVER blocks editing or saving: nothing here throws at its
// callers, and writes run off the keystroke path entirely.
//
// Writes are trailing-debounced PER PATH (default STASH_DEBOUNCE_MS): typing
// coalesces into ONE write of the final text, never one per keystroke.
// Clears (save success, buffer went clean, buffer died) are immediate -- a
// stale record must not outlive the moment it stopped being true.
//
// Every persist is a READ-MODIFY-WRITE of the tab's whole record (no cached
// mirror): a clear must delete a path it never "loaded" -- the honest way to
// drop a conflict offer whose record a Cancel just consumed -- and a stale
// in-memory copy silently resurrects it on the next reload.

export interface StashEntry {
  /** The exact buffer bytes (the joinContent serialization; contentOf). */
  text: string;
  /** The mtime the buffer believed the file had (the saveFile BASE). */
  baseMtimeMs: number;
  /** Wall clock of the stash, for honest diagnostics. */
  stashedAt: number;
}

/** path -> entry, the whole record under one sessionStorage key. */
export type StashRecord = Record<string, StashEntry>;

/** The minimal Storage surface this module needs (so tests inject a Map). */
export interface StashStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const STASH_TAB_ID_KEY = "hotdog.editorStash.tabId";
export const STASH_KEY_PREFIX = "hotdog.editorStash.";
export const STASH_DEBOUNCE_MS = 400;

export interface EditorStashDeps {
  /** Resolved PER CALL, never cached (house doctrine); null = unavailable. */
  storage: () => StashStorage | null;
  now?: () => number;
  debounceMs?: number;
  /** Fired ONCE, at the first failed write (quota / blocked mid-flight). */
  onQuota?: () => void;
  /** Tab-instance id generator (injectable for deterministic tests). */
  newTabId?: () => string;
}

export interface EditorStash {
  /** Debounced (trailing, per path) mirror of one dirty buffer. */
  schedule(path: string, text: string, baseMtimeMs: number): void;
  /** Drop one path NOW (save success / went clean / buffer died). */
  clear(path: string): void;
  /** Follow a rename: the record key moves with the file. */
  move(from: string, to: string): void;
  /** The stashed entry for a path (restore-time read; null = none). */
  entryFor(path: string): StashEntry | null;
  /** Land every pending write NOW (the house leave event). */
  flush(): void;
  /** True once any write failed (quota). Sticky; the indicator rides it. */
  quotaFailed(): boolean;
}

const isStashEntry = (v: unknown): v is StashEntry =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { text?: unknown }).text === "string" &&
  typeof (v as { baseMtimeMs?: unknown }).baseMtimeMs === "number" &&
  typeof (v as { stashedAt?: unknown }).stashedAt === "number";

export function createEditorStash(deps: EditorStashDeps): EditorStash {
  const now = deps.now ?? (() => Date.now());
  const debounceMs = deps.debounceMs ?? STASH_DEBOUNCE_MS;
  const newTabId =
    deps.newTabId ??
    (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  /** The tab-instance id; resolved on first use WHILE storage answers
   *  (no memo on a blocked answer -- a later stub becomes live). */
  let tabId = "";
  const resolveTabId = (): string => {
    if (tabId !== "") return tabId;
    const storage = deps.storage();
    if (storage === null) return "";
    try {
      const found = storage.getItem(STASH_TAB_ID_KEY);
      if (typeof found === "string" && found !== "") {
        tabId = found;
        return tabId;
      }
      const fresh = newTabId();
      storage.setItem(STASH_TAB_ID_KEY, fresh);
      tabId = fresh;
      return tabId;
    } catch {
      return ""; // blocked: no stash this page (never a quota mark; reads swallow)
    }
  };

  let quota = false;
  const markQuota = (): void => {
    // Quota (or storage died): mark ONCE through onQuota, never re-throw.
    // Editing and saving must never feel this.
    if (!quota) {
      quota = true;
      deps.onQuota?.();
    }
  };

  /** The tab's record, decoded live (garbage and blocked reads read empty). */
  const readRecord = (): StashRecord => {
    const storage = deps.storage();
    if (storage === null) return {};
    const id = resolveTabId();
    if (id === "") return {};
    let raw: string | null = null;
    try {
      raw = storage.getItem(STASH_KEY_PREFIX + id);
    } catch {
      return {};
    }
    if (raw === null) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const rec: StashRecord = {};
      for (const [path, entry] of Object.entries(parsed as Record<string, unknown>)) {
        if (isStashEntry(entry)) rec[path] = { ...entry };
      }
      return rec;
    } catch {
      // Garbage record: no stash, silently (the workbench codec doctrine).
      return {};
    }
  };

  /** Read-modify-write backstop: one write of the WHOLE record (an emptied
   *  record drops the key), quota-marked on failure, never throwing. */
  const writeRecord = (rec: StashRecord): void => {
    const storage = deps.storage();
    if (storage === null) return;
    const id = resolveTabId();
    if (id === "") return;
    try {
      if (Object.keys(rec).length === 0) storage.removeItem(STASH_KEY_PREFIX + id);
      else storage.setItem(STASH_KEY_PREFIX + id, JSON.stringify(rec));
    } catch {
      markQuota();
    }
  };

  const pending = new Map<string, StashEntry>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const cancelTimer = (path: string): void => {
    const t = timers.get(path);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(path);
    }
  };

  return {
    schedule(path, text, baseMtimeMs) {
      pending.set(path, { text, baseMtimeMs, stashedAt: now() });
      cancelTimer(path);
      timers.set(
        path,
        setTimeout(() => {
          timers.delete(path);
          const entry = pending.get(path);
          if (entry === undefined) return;
          pending.delete(path);
          writeRecord({ ...readRecord(), [path]: entry });
        }, debounceMs),
      );
    },

    clear(path) {
      cancelTimer(path);
      pending.delete(path);
      const rec = readRecord();
      if (rec[path] === undefined) return; // zero-traffic when nothing was stashed
      delete rec[path];
      writeRecord(rec);
    },

    move(from, to) {
      if (from === to) return;
      cancelTimer(from);
      const entry = pending.get(from);
      pending.delete(from);
      const rec = readRecord();
      const carried = entry ?? rec[from];
      if (carried === undefined) return; // nothing stashed under the old path
      delete rec[from];
      rec[to] = carried; // an old record at `to` (if any) is replaced: rename wins
      writeRecord(rec);
    },

    entryFor(path) {
      // LIVE read (the restore must see the record the previous page left,
      // and a clear must never fight a cached copy of it).
      const entry = readRecord()[path];
      return entry ?? null;
    },

    flush() {
      if (timers.size === 0 && pending.size === 0) return;
      const rec = readRecord();
      for (const [path, entry] of pending) rec[path] = entry;
      pending.clear();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      writeRecord(rec);
    },

    quotaFailed: () => quota,
  };
}
