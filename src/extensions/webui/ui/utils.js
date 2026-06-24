// Shared utilities for the WebUI frontend.

/**
 * Format a timestamp for display.
 * @param {number} ts - Unix timestamp in milliseconds
 * @returns {string}
 */
export function formatTime(ts) {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Format a session ID for display (short form).
 * @param {string} sessionId - Full UUID
 * @returns {string} First 8 chars
 */
export function shortId(sessionId) {
  return sessionId ? sessionId.slice(0, 8) : "???";
}

/**
 * Sanitize a string for safe HTML insertion.
 * @param {string} str
 * @returns {string}
 */
export function sanitize(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&#34;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape JSON for embedding in HTML.
 * @param {string} str
 * @returns {string}
 */
export function escapeJson(str) {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}
