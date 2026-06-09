// System prompt builder.
// Reads the template from disk and renders with variables.

import fsPromises from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";
import { initSystemPromptTemplate as _initTemplate } from "../config.js";
import { render, render as renderTemplate } from "../../utils/render.js";

export { renderTemplate };

// ── Aspect Loading ─────────────────────────────────────────────────────────

/**
 * Load aspect files from a directory.
 * Files are named `<name>.aspect.md`.
 *
 * @param {string[]} aspectNames - Names of aspects to load.
 * @param {string} [aspectsDir] - Directory containing `.aspect.md` files. Defaults to CWD/config/aspects.
 * @returns {{name: string, content: string}[]} Array of loaded aspects.
 */
export async function loadAspects(aspectNames, aspectsDir) {
  if (!aspectNames || aspectNames.length === 0) return [];

  const dir = aspectsDir || join(cwd(), "config", "aspects");

  const promises = aspectNames.map(async (name) => {
    const fileName = `${name}.aspect.md`;
    const filePath = join(dir, fileName);
    try {
      const content = await fsPromises.readFile(filePath, "utf-8");
      const trimmed = content.trim();
      if (trimmed.length > 0) {
        return { name, content: trimmed };
      }
    } catch {
      // Silent skip — aspect file not found or unreadable
    }
    return null;
  });

  const results = await Promise.all(promises);
  return results.filter(Boolean);
}

// ── AGENTS.md Loading ──────────────────────────────────────────────────────

/**
 * Load AGENTS.md from CWD if it exists.
 */
export async function loadAgentsMd() {
  try {
    const path = join(cwd(), "AGENTS.md");
    return await fsPromises.readFile(path, "utf-8");
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
export async function loadSystemPromptTemplate(templatePath) {
  if (cachedTemplate) return cachedTemplate;

  cachedTemplate = await _initTemplate(templatePath);
  return cachedTemplate;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the full system prompt.
 * Build system prompt with skills preamble.
 */
export async function buildSystemPrompt(options) {
  const template = await loadSystemPromptTemplate(options.templatePath);

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
