// System prompt builder — mirrors Rust `context/system_prompt.rs`.
// Reads the template from disk and renders with variables.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { initSystemPromptTemplate as _initTemplate } from '../init/resolution.js';
import { render, render as renderTemplate } from './render.js';

export { renderTemplate };

// ── Aspect Loading ─────────────────────────────────────────────────────────

/**
 * Load aspect files from config/aspects/.
 * Files are named <name>.aspect.md.
 */
export function loadAspects(aspectNames) {
  if (!aspectNames || aspectNames.length === 0) return [];

  const aspectsDir = join(cwd(), 'config', 'aspects');
  const aspects = [];

  for (const name of aspectNames) {
    const fileName = `${name}.aspect.md`;
    const path = join(aspectsDir, fileName);
    try {
      const content = readFileSync(path, 'utf-8');
      const trimmed = content.trim();
      if (trimmed.length > 0) {
        aspects.push({ name, content: trimmed });
      }
    } catch {
      // Silent skip
    }
  }

  return aspects;
}

// ── AGENTS.md Loading ──────────────────────────────────────────────────────

/**
 * Load AGENTS.md from CWD if it exists.
 */
export function loadAgentsMd() {
  try {
    const path = join(cwd(), 'AGENTS.md');
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

// ── System Prompt Template ─────────────────────────────────────────────────

let cachedTemplate = null;

/**
 * Load the system prompt template.
 * Uses the pre-initialized template from init/resolution.js if available,
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
 * Mirrors Rust `build_system_prompt_with_skills`.
 */
export function buildSystemPrompt(options) {
  const template = loadSystemPromptTemplate(options.templatePath);
  
  const context = {
    role: options.role || '',
    body: options.body || '',
    model: options.model || '',
    profile_name: options.profileName || 'default',
    cwd: cwd(),
    platform: process.platform,
    session_start: new Date().toISOString(),
    aspects: options.aspects || [],
    agents_md: options.agentsMd || '',
  };

  let result = render(template, context);

  // Append skills preamble
  if (options.skillsContent && options.skillsContent.trim()) {
    result += '\n\n' + options.skillsContent.trim();
  }

  return result;
}
