/// <reference lib="dom" />
// Composer draft persistence: survive a page reload, nothing more. Draft
// storage is best-effort -- every read/write is swallowed at this boundary
// so a blocked or throwing localStorage (private-mode Safari) can never
// break the app.

const DRAFT_STORAGE_KEY = "hotdog-webui-draft";
export { DRAFT_STORAGE_KEY };

/** Minimal Storage surface; tests inject a fake instead of mocking globals. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): DraftStorage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null; // accessing localStorage itself can throw
  }
}

function resolveStorage(storage?: DraftStorage): DraftStorage | null {
  return storage ?? browserStorage();
}

export function loadDraft(storage?: DraftStorage): string | null {
  const s = resolveStorage(storage);
  if (!s) return null;
  try {
    return s.getItem(DRAFT_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Empty text clears the key: an emptied composer must not linger as "" noise. */
export function saveDraft(text: string, storage?: DraftStorage): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    if (text === "") s.removeItem(DRAFT_STORAGE_KEY);
    else s.setItem(DRAFT_STORAGE_KEY, text);
  } catch {
    // quota exceeded / blocked storage: keep typing, just don't persist
  }
}

export function clearDraft(storage?: DraftStorage): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    s.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ── Debounced autosave ──────────────────────────────────────────────────────

const DRAFT_SAVE_DEBOUNCE_MS = 250;

let pendingSave: (() => void) | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingTimer(): void {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

/**
 * Debounced save; rapid calls coalesce into one write. getText runs at fire
 * time, so the surviving save always carries the latest text.
 */
export function scheduleDraftSave(getText: () => string, storage?: DraftStorage): void {
  clearPendingTimer();
  pendingSave = () => saveDraft(getText(), storage);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const run = pendingSave;
    pendingSave = null;
    run?.();
  }, DRAFT_SAVE_DEBOUNCE_MS);
}

/** Write any pending draft immediately (pagehide/beforeunload). */
export function flushDraftSave(): void {
  clearPendingTimer();
  const run = pendingSave;
  pendingSave = null;
  run?.();
}

// A sent message consumed its draft: cancel drops the pending save outright,
// so a later unload flush can never resurrect text that already went out.
export function cancelDraftSave(): void {
  clearPendingTimer();
  pendingSave = null;
}
