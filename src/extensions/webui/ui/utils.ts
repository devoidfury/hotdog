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
  // HTML escaping stops markup, not bidi/zero-width spoofing -- U+202E reorders rendered text inside a safe element too.
  // Neutralize code points first (they become visible [U+XXXX] tokens), then escape.
  return spoofSafe(str)
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

