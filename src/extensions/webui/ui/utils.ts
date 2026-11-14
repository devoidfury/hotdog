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


// ── Panel sizing (sidebar width, Recent Logs height) ───────────────────────
// The numbers only: the drag/collapse/clamp machinery is one seam
// (panel-resize.ts) and both panels configure themselves here.

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 780;
export const SIDEBAR_DEFAULT_WIDTH = 300;

// Recent Logs list height. The default is the height the CSS cap shipped
// before the section became resizable, so a fresh visitor sees no change;
// 96px keeps a couple of rows plus their scroll affordance on screen.
export const LOGS_MIN_HEIGHT = 96;
// The static ceiling only binds on very tall viewports; on ordinary screens the
// live ceiling is viewport height minus LOGS_VIEWPORT_RESERVE (see the panel
// config in app.tsx), so the list can reach nearly the full sidebar while the
// live sessions above it stay visible.
export const LOGS_MAX_HEIGHT = 900;
export const LOGS_VIEWPORT_RESERVE = 220;
export const LOGS_DEFAULT_HEIGHT = 240;

// Workbench pane (right dock, see workbench.tsx + the workbenchPanel config
// in app.tsx). The static ceiling only binds on huge viewports; the live one
// is viewport-aware. 320 keeps a usable file tree readable at the floor.
export const WORKBENCH_MIN_WIDTH = 320;
export const WORKBENCH_MAX_WIDTH = 1680;
export const WORKBENCH_DEFAULT_WIDTH = 420;

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

/**
 * Compact per-call wall time for the footer segment, e.g. "4.2s", "0.9s",
 * "1m 01s". Below 10s it keeps one decimal: a 4.2s call is not a 4s call,
 * and a 900ms call must never print "0s". Longer calls use the whole-second
 * formatDuration. Callers gate finiteness (same as the footer's other
 * segments).
 */
export function formatCallDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatDuration(ms);
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
  // The offscreen textarea must leave the document even when execCommand
  // throws (a leaked node poisons later querySelector("textarea") lookups).
  const ta = document.createElement("textarea");
  ta.value = text;
  // Keep it out of the layout and the scroll position.
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  try {
    document.body.appendChild(ta);
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

