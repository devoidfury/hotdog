// Prompts loader — loads .prompt.md files from config/prompts/.
// Each prompt is a reusable template with YAML front matter + Tera body.

import fs from "node:fs/promises";
import { join } from "node:path";
import { parseFrontMatter, validateNameable } from "../../utils/file-utils.ts";
import { logger } from "../../core/logger.ts";
import { ParseError } from "../../core/error.ts";
import { render } from "../../utils/render.ts";
import { ACTIONS } from "../../core/commands.ts";

interface Prompt {
  name: string;
  description: string;
  disableModelInvocation: boolean;
  content: string;
  location: string;
}

/**
 * Parse a .prompt.md file into a Prompt object.
 */
export function parsePromptFromMd(
  content: string,
  fileName: string,
  location: string,
): Prompt {
  const parsed = parseFrontMatter(content);
  if (!parsed) {
    throw ParseError.FrontmatterNotFound();
  }

  const fm = parsed.frontMatter;
  const body = parsed.body;

  // Validate description
  const description = fm.description as string | undefined;
  if (!description || !description.trim()) {
    throw ParseError.MissingDescription("Prompt");
  }

  const fileStem = fileName.replace(/\.prompt\.md$/, "");
  const name = (fm.name as string) || fileStem;

  // Warn on validation issues
  const warnings = validateNameable(name, "Prompt", fileStem);
  for (const w of warnings) {
    logger.warn(`Prompt '${name}': ${w}`);
  }

  return {
    name,
    description,
    disableModelInvocation:
      (fm["disable-model-invocation"] as boolean) || (fm.disable_model_invocation as boolean) || false,
    content: body,
    location,
  };
}

/**
 * PromptsLoader — loads and manages prompt templates.
 */
export class PromptsLoader {
  private readonly paths: string[];
  private readonly prompts: Map<string, Prompt>;
  readonly displayPrompt: boolean;

  constructor(paths: string | string[] | undefined, display = true) {
    // paths can be a string (colon-separated) or array
    this.paths = Array.isArray(paths)
      ? paths
      : (paths || "")
          .split(":")
          .map((p: string) => p.trim())
          .filter(Boolean) as string[];
    this.prompts = new Map();
    this.displayPrompt = display;
  }

  /**
   * Load all .prompt.md files from configured directories.
   * Returns number of prompts loaded.
   */
  async loadPrompts(): Promise<number> {
    let count = 0;
    for (const dir of this.paths) {
      count += await this.loadFromDirectory(dir);
    }
    return count;
  }

  private async loadFromDirectory(dir: string): Promise<number> {
    let count = 0;

    let entries: { isFile: () => boolean; name: string }[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Directory doesn't exist — silently skip
      return 0;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".prompt.md")) continue;

      const filePath = join(dir, entry.name);
      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch {
        logger.warn(`Failed to read prompt '${entry.name}'`);
        continue;
      }

      try {
        const location = await fs.realpath(filePath);
        const prompt = parsePromptFromMd(content, entry.name, location);

        // Collision detection
        if (this.prompts.has(prompt.name)) {
          const existing = this.prompts.get(prompt.name)!;
          logger.warn(
            `Prompt '${prompt.name}' already loaded (from ${existing.location}), overwriting with ${location}`,
            { existingLocation: existing.location, newLocation: location },
          );
        }

        this.prompts.set(prompt.name, prompt);
        count++;
      } catch (e: unknown) {
        logger.warn(`Failed to load prompt '${entry.name}': ${(e as Error).message}`, {
          error: (e as Error).message,
        });
      }
    }

    return count;
  }

  /**
   * Get a prompt by name.
   */
  getPrompt(name: string): Prompt | null {
    return this.prompts.get(name) || null;
  }

  /**
   * Get all prompts (excluding disabled ones).
   */
  allPrompts(): Prompt[] {
    return Array.from(this.prompts.values()).filter(
      (p) => !p.disableModelInvocation,
    );
  }

  /**
   * Get configured directories.
   */
  directories(): string[] {
    return [...this.paths];
  }

  /**
   * The handler for when a prompt should be loaded in response to a command
   */
  async promptHandler(
    _agent: unknown,
    cmdValue: string,
  ): Promise<Record<string, unknown>> {
    const rest = cmdValue.slice(7);
    const spaceIdx = rest.indexOf(" ");
    const name = spaceIdx >= 0 ? rest.slice(0, spaceIdx).trim() : rest.trim();
    const args = spaceIdx >= 0 ? rest.slice(spaceIdx + 1).trim() : "";

    const prompt = this.getPrompt(name);
    if (!prompt) {
      return { action: ACTIONS.ERROR, error: `Unknown prompt: ${name}` };
    }

    // Render the prompt template with args using the render engine
    const content = render(prompt.content, { ARGS: args || "" });

    // Build action flags. PROMPT always enqueues for LLM processing.
    // DISPLAY is added when displayPrompt is true so the rendered prompt
    // appears in chat before the LLM responds.
    let action = ACTIONS.PROMPT;
    if (this.displayPrompt !== false) {
      action |= ACTIONS.DISPLAY;
    }

    return { action, content };
  }
}
