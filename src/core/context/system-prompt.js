// System prompt builder.
// Reads the template from disk and renders with variables.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { initSystemPromptTemplate as _initTemplate } from "../config.js";
import { render, render as renderTemplate } from "../../utils/render.js";
import { loadAspects as _loadAspects } from "../../utils/utils.js";

export { renderTemplate };

// ── Aspect Loading ─────────────────────────────────────────────────────────

/**
 * Load aspect files from the default aspects directory (CWD/config/aspects).
 * Files are named `<name>.aspect.md`.
 *
 * @param {string[]} aspectNames - Names of aspects to load.
 * @returns {{name: string, content: string}[]} Array of loaded aspects.
 */
export function loadAspects(aspectNames) {
  const aspectsDir = join(cwd(), "config", "aspects");
  return _loadAspects(aspectNames, aspectsDir);
}

// ── AGENTS.md Loading ──────────────────────────────────────────────────────

/**
 * Load AGENTS.md from CWD if it exists.
 */
export function loadAgentsMd() {
  try {
    const path = join(cwd(), "AGENTS.md");
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

// ── System Prompt Template ─────────────────────────────────────────────────

let cachedTemplate = null;

/**
 * Load the system prompt template.
 * Uses the pre-initialized template from config.js if available,
 * otherwise loads from disk or falls back to minimal template.
 */
export function loadSystemPromptTemplate(templatePath) {
  if (cachedTemplate) return cachedTemplate;

  cachedTemplate = _initTemplate(templatePath);
  return cachedTemplate;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the full system prompt.
 * Build system prompt with skills preamble.
 */
export function buildSystemPrompt(options) {
  const template = loadSystemPromptTemplate(options.templatePath);

  const context = {
    role: options.role || "",
    body: options.body || "",
    model: options.model || "",
    profile_name: options.profileName || "default",
    cwd: cwd(),
    platform: process.platform,
    session_start: new Date().toISOString().slice(0, 10),
    aspects: options.aspects || [],
    agents_md: options.agentsMd || "",
  };

  let result = render(template, context);

  // Append skills preamble
  if (options.skillsContent && options.skillsContent.trim()) {
    result += "\n\n" + options.skillsContent.trim();
  }

  return result;
}
