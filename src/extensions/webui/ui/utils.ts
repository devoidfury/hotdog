// Shared utilities for the WebUI frontend.
// Re-exports reactiveState/effect from the shared utils so the UI doesn't
// duplicate the atom implementation.

export { reactiveState, effect, type Atom } from "../../../utils/reactive-state.ts";


// ── Formatting & sanitisation ───────────────────────────────────────────────

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

export function shortId(sessionId: string | null | undefined): string {
  return sessionId ? sessionId.slice(0, 8) : "???";
}

export function sanitize(str: string | null | undefined): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&#34;")
    .replace(/'/g, "&#39;");
}

export function escapeJson(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}
