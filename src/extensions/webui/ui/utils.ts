/// <reference lib="dom" />
// Shared utilities for the WebUI frontend.
// Re-exports reactiveState/effect and the question resolver from the shared
// utils so the UI doesn't duplicate implementations (Bun bundles the UI,
// so @utils imports work here).

export { reactiveState, effect, type Atom } from "@utils/reactive-state.ts";
export {
  resolveQuestionAnswer,
  type QuestionField,
  type QuestionSelection,
  type QuestionResolution,
} from "@utils/question-answer.ts";
import { spoofSafe } from "@utils/spoof.ts";
import { escapeHtml } from "@utils/html.ts";


// ── Sidebar resize ──────────────────────────────────────────────────────────

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_DEFAULT_WIDTH = 300;

/** Sidebar width clamp: 200px .. min(520px, half the viewport). */
export function clampSidebarWidth(width: number, viewportWidth: number): number {
  // Min beats max on degenerate (sub-400px) viewports.
  const max = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth / 2));
  return Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), max);
}

// ── Formatting & sanitisation ───────────────────────────────────────────────

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

/** Footer clock, e.g. "1:35 AM" (12-hour, local time). */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours();
  return `${h % 12 || 12}:${d.getMinutes().toString().padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Elapsed time, e.g. "16m 21s", "42s", "1h 05m 09s". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m ${s.toString().padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatTokenCount(n: number): string {
  // Non-finite/negative pass through as-is; toFixed's trailing ".0" is stripped (1959 -> "2k").
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n < 1_000_000) return Math.round(n / 1000) + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

export function shortId(sessionId: string | null | undefined): string {
  return sessionId ? sessionId.slice(0, 8) : "???";
}

export function sanitize(str: string | null | undefined): string {
  if (!str) return "";
  // HTML escaping stops markup, not bidi/zero-width spoofing -- U+202E reorders rendered text inside a safe element too.
  // Neutralize code points first (they become visible [U+XXXX] tokens), then escape.
  return escapeHtml(spoofSafe(str));
}

// ── Clipboard ───────────────────────────────────────────────────────────────

/**
 * Copy text to the clipboard. navigator.clipboard needs a secure context,
 * so a plain-HTTP (non-localhost) webui falls back to the legacy
 * textarea + execCommand path. True when the copy was acknowledged.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path (permission denied, non-secure context).
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Keep it out of the layout and the scroll position.
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

