// System prompt builder.
// Reads the template from disk and renders with variables.
// Extensions contribute chunks via the SYSTEM_PROMPT_BUILD hook;
// this module renders the template with those chunks.

import { initSystemPromptTemplate as _initTemplate } from "../config/providers.ts";
import { render } from "../../utils/render.ts";
import { HOOKS } from "../hooks.ts";

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
 *
 * @param role - The agent's role description
 * @param body - The profile body content
 * @param model - The current model name
 * @param profileName - The current profile name
 * @param chunks - Extension-contributed prompt chunks
 * @param templatePath - Optional custom template path
 */
export async function buildSystemPrompt(
  role: string,
  body: string,
  model: string,
  profileName: string,
  chunks: SystemPromptChunk[],
  templatePath?: string,
): Promise<string> {
  const template = await loadSystemPromptTemplate(templatePath);

  const context = {
    role: role || "",
    body: body || "",
    model: model || "",
    profile_name: profileName || "default",
    chunks: chunks || [],
  };

  return render(template, context);
}

/**
 * Agent config interface for system prompt building.
 * Extracts the needed fields from the Agent's config/profile.
 */
export interface AgentConfigForPrompt {
  role: string | undefined;
  profileBody: string | undefined;
  model: string;
  profileName: string | undefined;
}

/**
 * SystemPromptBuilder manages the system prompt lifecycle.
 *
 * Responsibilities:
 * - Collects chunks from the SYSTEM_PROMPT_BUILD hook
 * - Caches the built system prompt
 * - Rebuilds when explicitly requested (e.g., after profile change)
 *
 * This class decouples system prompt management from the Agent class,
 * making it testable and reusable.
 */
export class SystemPromptBuilder {
  #cachedPrompt: string | null = null;
  #templatePath: string | undefined;

  constructor(templatePath?: string) {
    this.#templatePath = templatePath;
  }

  /**
   * Get the cached system prompt, or null if not yet built.
   */
  getPrompt(): string | null {
    return this.#cachedPrompt;
  }

  /**
   * Check if the system prompt has been built.
   */
  isBuilt(): boolean {
    return this.#cachedPrompt !== null;
  }

  /**
   * Clear the cached system prompt.
   * Used when the profile changes or context is reset.
   */
  clear(): void {
    this.#cachedPrompt = null;
  }

  /**
   * Build the system prompt by:
   * 1. Running the SYSTEM_PROMPT_BUILD hook pipeline
   * 2. Collecting chunks from hook results
   * 3. Rendering the template with chunks and profile info
   *
   * @param hooks - The hook system to run the pipeline on
   * @param agent - The agent instance (passed to hook handlers)
   * @param config - Agent config with role, profileBody, model, profileName
   * @returns The built system prompt string
   */
  async build(
    hooks: {
      runHookPipeline: (
        hookName: string,
        data: unknown,
      ) => Promise<{ results: Array<{ result: unknown; source: string | null }> }>;
    },
    agent: unknown,
    config: AgentConfigForPrompt,
  ): Promise<string> {
    const { results } = await hooks.runHookPipeline(HOOKS.SYSTEM_PROMPT_BUILD, {
      agent,
    });
    const chunks = collectSystemPromptChunks(results);

    this.#cachedPrompt = await buildSystemPrompt(
      config.role || "",
      config.profileBody || "",
      config.model,
      config.profileName || "default",
      chunks,
      this.#templatePath,
    );

    return this.#cachedPrompt;
  }

  /**
   * Ensure the system prompt is built.
   * If already built, returns the cached prompt.
   * If not built, runs the build process.
   *
   * This is the main entry point for agents that need a system prompt.
   *
   * @param hooks - The hook system to run the pipeline on
   * @param agent - The agent instance (passed to hook handlers)
   * @param config - Agent config with role, profileBody, model, profileName
   * @returns The built system prompt string
   */
  async ensureBuilt(
    hooks: {
      runHookPipeline: (
        hookName: string,
        data: unknown,
      ) => Promise<{ results: Array<{ result: unknown; source: string | null }> }>;
    },
    agent: unknown,
    config: AgentConfigForPrompt,
  ): Promise<string> {
    if (this.#cachedPrompt !== null) {
      return this.#cachedPrompt;
    }

    return this.build(hooks, agent, config);
  }
}

/**
 * Create a new SystemPromptBuilder instance.
 */
export function createSystemPromptBuilder(templatePath?: string): SystemPromptBuilder {
  return new SystemPromptBuilder(templatePath);
}
