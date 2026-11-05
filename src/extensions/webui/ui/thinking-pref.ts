/// <reference lib="dom" />
// Reasoning-visibility preference: a per-BROWSER view setting (owner ruling
// 2026-11-05). localStorage so it survives a reload and applies to whatever
// transcript is on screen -- the live one or a cold log being browsed. The
// CLI's /thinking session state (agent.hideThinking, server broadcast) is
// separate server state; this file never touches it.
// Storage doctrine copied from draft.ts: every access is swallowed at this
// boundary, so a blocked or throwing localStorage (private-mode Safari) can
// never break chat -- the default (reasoning shown) is all that is lost.

import type { DraftStorage } from "./draft.ts";

/** "1" hides reasoning; anything else (missing, garbage, "0") shows it. */
const HIDE_THINKING_STORAGE_KEY = "hotdog-webui-hide-thinking";
export { HIDE_THINKING_STORAGE_KEY };

function resolveStorage(storage?: DraftStorage): DraftStorage | null {
  if (storage) return storage;
  try {
    return window.localStorage ?? null;
  } catch {
    return null; // accessing localStorage itself can throw
  }
}

/** Read the preference; unreadable or unset storage means show reasoning. */
export function loadHideThinking(storage?: DraftStorage): boolean {
  const s = resolveStorage(storage);
  if (!s) return false;
  try {
    return s.getItem(HIDE_THINKING_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Best-effort persist: a blocked or quota-full store only costs the reload. */
export function saveHideThinking(hide: boolean, storage?: DraftStorage): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    s.setItem(HIDE_THINKING_STORAGE_KEY, hide ? "1" : "0");
  } catch {
    // blocked storage / quota exceeded: the view still flips for this page
  }
}
