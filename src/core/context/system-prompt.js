// System prompt builder.
// Reads the template from disk and renders with variables.
// Extensions contribute chunks via the SYSTEM_PROMPT_BUILD hook;
// this module renders the template with those chunks.

import { initSystemPromptTemplate as _initTemplate } from "../config/providers.js";
import { render } from "../../utils/render.js";

// ── System Prompt Template ─────────────────────────────────────────────────

let cachedTemplate = null;

/**
 * Load the system prompt template.
 * Uses the pre-initialized template from config.js if available,
 * otherwise loads from disk or falls back to minimal template.
 */
export async function loadSystemPromptTemplate(templatePath) {
  if (cachedTemplate) return cachedTemplate;

  cachedTemplate = await _initTemplate(templatePath);
  return cachedTemplate;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the full system prompt.
 * Renders the template with role/body and extension-contributed chunks.
 *
 * @param {Object} options
 * @param {string} options.role - Role description.
 * @param {string} options.body - Profile body content.
 * @param {string} options.model - Model name.
 * @param {string} options.profileName - Profile name.
 * @param {Array<{name: string, priority: number, content: string}>} options.chunks -
 *   Sorted chunks contributed by extensions.
 * @param {string} [options.templatePath] - Optional template path override.
 */
export async function buildSystemPrompt(options) {
  const template = await loadSystemPromptTemplate(options.templatePath);

  const context = {
    role: options.role || "",
    body: options.body || "",
    model: options.model || "",
    profile_name: options.profileName || "default",
    chunks: options.chunks || [],
  };

  return render(template, context);
}
