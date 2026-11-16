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
    s.removeItem(DRAFT_CARET_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ── Caret + focus record (saved alongside the draft text) ──────────────────
// The composer's CARET and whether it HELD FOCUS survive a reload too, so a
// mid-typing refresh lands where the user left off. A sibling key beside the
// draft: the text record stays the raw string loadDraft hands back (wire
// format unchanged), the caret rides its own record under the exact same
// best-effort doctrine -- every access swallowed, garbage decodes to "no
// restore" (a wrong caret is worse than none).

const DRAFT_CARET_STORAGE_KEY = "hotdog-webui-draft-caret";
export { DRAFT_CARET_STORAGE_KEY };

export interface DraftCaret {
  start: number;
  end: number;
  /** The composer held focus when the record was written. */
  focused: boolean;
}

function decodeDraftCaret(raw: string | null): DraftCaret | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { s?: unknown; e?: unknown; f?: unknown };
    if (
      typeof v?.s !== "number" ||
      typeof v?.e !== "number" ||
      !Number.isInteger(v.s) ||
      !Number.isInteger(v.e) ||
      v.s < 0 ||
      v.e < v.s
    ) {
      return null;
    }
    return { start: v.s, end: v.e, focused: v.f === 1 };
  } catch {
    return null;
  }
}

export function loadDraftCaret(storage?: DraftStorage): DraftCaret | null {
  const s = resolveStorage(storage);
  if (!s) return null;
  try {
    return decodeDraftCaret(s.getItem(DRAFT_CARET_STORAGE_KEY));
  } catch {
    return null;
  }
}

function saveDraftCaret(caret: DraftCaret | null, storage?: DraftStorage): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    if (caret === null) s.removeItem(DRAFT_CARET_STORAGE_KEY);
    else s.setItem(
      DRAFT_CARET_STORAGE_KEY,
      JSON.stringify({ s: caret.start, e: caret.end, f: caret.focused ? 1 : 0 }),
    );
  } catch {
    // same swallow as the text: the caret costs the reload, never the app
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
 * time, so the surviving save always carries the latest text. getCaret (when
 * given) is read at the SAME moment: text, caret and the focus marker land in
 * one coalesced write, so the pair can never disagree. An empty text takes
 * the caret record with it (no draft, nothing to restore).
 */
export function scheduleDraftSave(
  getText: () => string,
  storage?: DraftStorage,
  getCaret?: () => DraftCaret | null,
): void {
  clearPendingTimer();
  pendingSave = () => {
    const text = getText();
    saveDraft(text, storage);
    if (getCaret) saveDraftCaret(text === "" ? null : getCaret(), storage);
  };
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
