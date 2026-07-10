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

/**
 * Collect system prompt chunks from the hook pipeline.
 * Each hook handler returns a chunk object { name, priority, content } or
 * an array of such objects. Source prefixing is applied based on the
 * handler's registration source. Chunks are sorted by priority.
 *
 * @param {Array<object>} results results from the hook.
 * @param {Object} agent - The agent instance (passed to hooks as context).
 * @returns {Array<{name: string, priority: number, content: string}>} Sorted chunks.
 */
export function collectSystemPromptChunks(results, agent) {
  const chunks = [];
  for (const { result, source } of results) {
    const items = Array.isArray(result) ? result : [result];
    for (const item of items) {
      if (item && item.name && item.content) {
        const fullName = source ? `${source}:${item.name}` : item.name;
        chunks.push({
          name: fullName,
          priority: item.priority,
          content: item.content,
        });
      }
    }
  }

  // Sort by priority (lower = earlier in the prompt)
  chunks.sort((a, b) => a.priority - b.priority);
  return chunks;
}

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
