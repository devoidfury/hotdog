// Prompts loader — loads .prompt.md files from config/prompts/.
// Each prompt is a reusable template with YAML front matter + Tera body.

import fs from "node:fs";
import { join } from "node:path";
import { parseFrontMatter } from "../../core/utils.js";
import { validateNameable } from "./lib.js";

/**
 * Parse a .prompt.md file into a Prompt object.
 */
export function parsePromptFromMd(content, fileName, location) {
  const parsed = parseFrontMatter(content);
  if (!parsed) {
    throw new Error("No YAML frontmatter found");
  }

  const fm = parsed.frontMatter;
  const body = parsed.body;

  // Validate description
  if (!fm.description || !fm.description.trim()) {
    throw new Error("Prompt description is missing or empty (required)");
  }

  const fileStem = fileName.replace(/\.prompt\.md$/, "");
  const name = fm.name || fileStem;

  // Warn on validation issues
  const warnings = validateNameable(name, "Prompt", fileStem);
  for (const w of warnings) {
    console.warn(`Warning: Prompt '${name}': ${w}`);
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
  constructor(paths) {
    // paths can be a string (colon-separated) or array
    this.paths = Array.isArray(paths)
      ? paths
      : paths
          .split(":")
          .map((p) => p.trim())
          .filter(Boolean);
    this.prompts = new Map();
  }

  /**
   * Load all .prompt.md files from configured directories.
   * Returns number of prompts loaded.
   */
  loadPrompts() {
    let count = 0;
    for (const dir of this.paths) {
      count += this.loadFromDirectory(dir);
    }
    return count;
  }

  loadFromDirectory(dir) {
    let count = 0;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
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
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        console.warn(`Warning: Failed to read prompt '${entry.name}'`);
        continue;
      }

      try {
        const location = fs.realpathSync(filePath);
        const prompt = parsePromptFromMd(content, entry.name, location);

        // Collision detection
        if (this.prompts.has(prompt.name)) {
          const existing = this.prompts.get(prompt.name);
          console.warn(
            `Warning: Prompt '${prompt.name}' already loaded (from ${existing.location}), overwriting with ${location}`,
          );
        }

        this.prompts.set(prompt.name, prompt);
        count++;
      } catch (e) {
        console.warn(
          `Warning: Failed to load prompt '${entry.name}': ${e.message}`,
        );
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
}
