// System prompt builder.
// Reads the template from disk and renders with variables.
// Extensions contribute chunks via the SYSTEM_PROMPT_BUILD hook;
// this module renders the template with those chunks.

import { initSystemPromptTemplate as _initTemplate } from "../config/providers.ts";
import { render } from "../../utils/render.ts";

// ── System Prompt Template ─────────────────────────────────────────────────

let cachedTemplate: string | null = null;

/**
 * Load the system prompt template.
 * Uses the pre-initialized template from config/providers.ts if available,
 * otherwise loads from disk or falls back to minimal template.
 */
export async function loadSystemPromptTemplate(
  templatePath?: string,
): Promise<string> {
  if (cachedTemplate) return cachedTemplate;

  cachedTemplate = await _initTemplate(templatePath);
  return cachedTemplate;
}

export interface SystemPromptChunk {
  name: string;
  priority: number;
  content: string;
}

/**
 * Collect system prompt chunks from the hook pipeline.
 * Each hook handler returns a chunk object { name, priority, content } or
 * an array of such objects. Source prefixing is applied based on the
 * handler's registration source. Chunks are sorted by priority.
 */
export function collectSystemPromptChunks(
  results: Array<{ result: unknown; source: string | null }>,
  _agent: unknown,
): SystemPromptChunk[] {
  const chunks: SystemPromptChunk[] = [];
  for (const { result, source } of results) {
    const items = Array.isArray(result) ? result : [result];
    for (const item of items as Record<string, unknown>[]) {
      if (item && item.name && item.content) {
        const fullName = source ? `${source}:${item.name}` : `${item.name}`;
        chunks.push({
          name: fullName,
          priority: item.priority as number,
          content: item.content as string,
        });
      }
    }
  }

  // Sort by priority (lower = earlier in the prompt)
  chunks.sort((a, b) => a.priority - b.priority);
  return chunks;
}

export interface BuildSystemPromptOptions {
  role: string;
  body: string;
  model: string;
  profileName: string;
  chunks: SystemPromptChunk[];
  templatePath?: string;
}

/**
 * Build the full system prompt.
 * Renders the template with role/body and extension-contributed chunks.
 */
export async function buildSystemPrompt(
  options: BuildSystemPromptOptions,
): Promise<string> {
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
