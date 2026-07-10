// Prompts loader — loads .prompt.md files from config/prompts/.
// Each prompt is a reusable template with YAML front matter + Tera body.

import fs from "node:fs/promises";
import { join } from "node:path";
import { parseFrontMatter, validateNameable } from "../../utils/file-utils.js";
import { logger } from "../../core/logger.js";
import { ParseError } from "../../core/error.js";
import { Message } from "../../core/context/message.js";
import { render } from "../../utils/render.js";
import { ACTIONS } from "../../core/commands.js";

/**
 * Parse a .prompt.md file into a Prompt object.
 */
export function parsePromptFromMd(content, fileName, location) {
  const parsed = parseFrontMatter(content);
  if (!parsed) {
    throw ParseError.FrontmatterNotFound();
  }

  const fm = parsed.frontMatter;
  const body = parsed.body;

  // Validate description
  if (!fm.description || !fm.description.trim()) {
    throw ParseError.MissingDescription("Prompt");
  }

  const fileStem = fileName.replace(/\.prompt\.md$/, "");
  const name = fm.name || fileStem;

  // Warn on validation issues
  const warnings = validateNameable(name, "Prompt", fileStem);
  for (const w of warnings) {
    logger.warn(`Prompt '${name}': ${w}`);
  }

  return {
    name,
    description: fm.description,
    disableModelInvocation:
      fm["disable-model-invocation"] || fm.disable_model_invocation || false,
    content: body,
    location,
  };
}

/**
 * PromptsLoader — loads and manages prompt templates.
 */
export class PromptsLoader {
  constructor(paths, display = true) {
    // paths can be a string (colon-separated) or array
    this.paths = Array.isArray(paths)
      ? paths
      : (paths || "")
          .split(":")
          .map((p) => p.trim())
          .filter(Boolean);
    this.prompts = new Map();
    this.displayPrompt = display;
  }

  /**
   * Load all .prompt.md files from configured directories.
   * Returns number of prompts loaded.
   */
  async loadPrompts() {
    let count = 0;
    for (const dir of this.paths) {
      count += await this.loadFromDirectory(dir);
    }
    return count;
  }

  async loadFromDirectory(dir) {
    let count = 0;

    let entries;
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
      let content;
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
          const existing = this.prompts.get(prompt.name);
          logger.warn(
            `Prompt '${prompt.name}' already loaded (from ${existing.location}), overwriting with ${location}`,
            { existingLocation: existing.location, newLocation: location },
          );
        }

        this.prompts.set(prompt.name, prompt);
        count++;
      } catch (e) {
        logger.warn(`Failed to load prompt '${entry.name}': ${e.message}`, {
          error: e.message,
        });
      }
    }

    return count;
  }

  /**
   * Get a prompt by name.
   */
  getPrompt(name) {
    return this.prompts.get(name) || null;
  }

  /**
   * Get all prompts (excluding disabled ones).
   */
  allPrompts() {
    return Array.from(this.prompts.values()).filter(
      (p) => !p.disableModelInvocation,
    );
  }

  /**
   * Get configured directories.
   */
  directories() {
    return [...this.paths];
  }

  /**
   * The handler for when a prompt should be loaded in response to a command
   */
  async promptHandler(agent, cmdValue) {
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
