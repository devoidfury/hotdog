// Canonical HTML escaping and URL-scheme policy shared by every renderer
// (jsx/core, md-parser, webui). Policy choices live at the call sites; the
// escaping and control-char normalization live here so the XSS gates cannot
// drift apart. Wire-XML escaping (`&apos;`) is a separate domain and stays in
// strings.ts -- its bytes travel to the model, not into a DOM.

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape the five markup-significant characters.
 *
 * Not spoof-safe on purpose: compose `spoofSafe()` first when rendering
 * untrusted text (escaping stops markup, not bidi/zero-width code points).
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (m) => HTML_ESCAPES[m]!);
}

export interface SafeUrlPolicy {
  /** Lowercased schemes accepted when the value carries one. */
  allowedSchemes: ReadonlySet<string>;
  /**
   * data: URLs matching this also pass, regardless of the scheme set.
   * Only script-free image types qualify (an svg data: URI can carry script).
   */
  allowDataImage?: RegExp;
}

/**
 * Blocks script-capable schemes (javascript:, vbscript:, data:text/html).
 *
 * Browsers ignore C0 controls/whitespace when parsing URLs (`jav\tascript:`
 * is live), so they are stripped before the scheme check; no valid URL
 * contains raw C0 controls. Schemeless values (relative paths, `#anchor`,
 * `//host`) pass -- the policy governs explicit schemes only.
 */
export function isSafeUrl(value: string, policy: SafeUrlPolicy): boolean {
  const stripped = value.replace(/[\x00-\x20\x7f]+/g, "");
  if (policy.allowDataImage?.test(stripped)) return true;
  const scheme = stripped.match(/^([a-z][a-z\d+.-]*):/i);
  if (!scheme) return true;
  return policy.allowedSchemes.has(scheme[1]!.toLowerCase());
}
