import { initSystemPromptTemplate } from "../config/providers.ts";
import { render } from "../../utils/render.ts";
import { HOOKS, type SystemPromptChunk } from "../hooks.ts";

/** Chunks from hook results, prefixed with the handler's registration source, sorted by priority. */
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


/**
 * Renders the template with role/body and extension-contributed chunks.
 * `template` is the loaded template TEXT; when omitted it is loaded from
 * the config dir (standalone callers only -- the agent pipeline always
 * passes the resolved template explicitly).
 */
export async function buildSystemPrompt(
  role: string,
  body: string,
  model: string,
  profileName: string,
  chunks: SystemPromptChunk[],
  template?: string,
): Promise<string> {
  const tpl = template || (await initSystemPromptTemplate());

  const context = {
    role: role || "",
    body: body || "",
    model: model || "",
    profile_name: profileName || "default",
    chunks: chunks || [],
  };

  return render(tpl, context);
}

export interface AgentConfigForPrompt {
  role: string | undefined;
  profileBody: string | undefined;
  model: string;
  profileName: string | undefined;
}

export class SystemPromptBuilder {
  #cachedPrompt: string | null = null;
  #template: string | null = null;

  /**
   * @param template - Loaded template text (from buildConfig's resolved
   *   config). Omitted only by standalone callers; build() then falls back
   *   to config-dir resolution.
   */
  constructor(template?: string) {
    this.#template = template || null;
  }

  getPrompt(): string | null {
    return this.#cachedPrompt;
  }

  isBuilt(): boolean {
    return this.#cachedPrompt !== null;
  }

  clear(): void {
    this.#cachedPrompt = null;
  }

  /** Runs the SYSTEM_PROMPT_BUILD hook pipeline, then renders the template with the collected chunks. */
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
      this.#template ?? undefined,
    );

    return this.#cachedPrompt;
  }

  /** Returns the cached prompt if built; otherwise builds it. */
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

export function createSystemPromptBuilder(template?: string): SystemPromptBuilder {
  return new SystemPromptBuilder(template);
}
