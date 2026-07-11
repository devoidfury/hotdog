// Skills loader — loads SKILL.md files from skill directories.
// Supports tool-dependencies, auto-activation, and pattern matching.

import fs from "node:fs/promises";
import { join } from "node:path";
import { parseFrontMatter, validateNameable } from "../../utils/file-utils.ts";
import { render } from "../../utils/render.ts";
import { logger } from "../../core/logger.ts";
import { ParseError } from "../../core/error.ts";

// ── Pattern Matching ───────────────────────────────────────────────────────

/**
 * Match a tool name against a pattern that may contain '*' wildcards.
 * Uses DP-based glob matching.
 */
export function patternMatches(pattern: string, toolName: string): boolean {
  if (pattern === toolName) return true;
  if (!pattern.includes("*")) return false;

  const pat = pattern.split("");
  const name = toolName.split("");
  const patLen = pat.length;
  const nameLen = name.length;

  // dp[i][j] = does pat[0..i] match name[0..j]?
  const dp: boolean[][] = Array.from({ length: patLen + 1 }, () =>
    Array(nameLen + 1).fill(false),
  );
  dp[0][0] = true;

  // Handle leading * patterns
  for (let i = 1; i <= patLen; i++) {
    if (pat[i - 1] === "*") dp[i][0] = dp[i - 1][0];
    else break;
  }

  for (let i = 1; i <= patLen; i++) {
    for (let j = 1; j <= nameLen; j++) {
      if (pat[i - 1] === "*") {
        dp[i][j] = dp[i - 1][j] || dp[i][j - 1];
      } else if (pat[i - 1] === name[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      }
    }
  }

  return dp[patLen][nameLen];
}

// ── Skill Parsing ──────────────────────────────────────────────────────────

interface Skill {
  name: string;
  description: string;
  license: string;
  compatibility: string;
  metadata: Record<string, unknown>;
  allowedTools: string[];
  includeTools: string[];
  toolDependencies: string[];
  visible: boolean;
  disableModelInvocation: boolean;
  loaded: boolean;
  content: string;
  location: string;
  additionalFiles: string[];
}

interface ParsedFrontMatter {
  frontMatter: Record<string, unknown>;
  body: string;
}

/**
 * Parse a SKILL.md file into a Skill object.
 */
export function parseSkillFromMd(
  content: string,
  dirName: string,
  location: string,
): Skill {
  const parsed = parseFrontMatter(content) as ParsedFrontMatter | null;
  if (!parsed) {
    throw ParseError.FrontmatterNotFound();
  }

  const fm = parsed.frontMatter;
  const body = parsed.body;

  // Validate description
  const description = fm.description as string | undefined;
  if (!description || !description.trim()) {
    throw ParseError.MissingDescription("Skill");
  }

  // Warn on description length
  const descLen =
    typeof fm.description === "string" ? fm.description.length : 0;
  if (descLen > 1024) {
    logger.warn(
      `Skill '${fm.name || dirName}' description exceeds 1024 characters (${descLen} chars), truncating`,
    );
  }

  const name = (fm.name as string) || dirName;

  // Lenient name validation
  const warnings = validateNameable(name, "Skill", dirName);
  for (const w of warnings) {
    logger.warn(`Skill '${name}': ${w}`);
  }

  // Parse tool-related fields
  const allowedTools = parseToolList(
    (fm["allowed-tools"] as string | string[]) ||
      (fm.allowed_tools as string | string[]) ||
      "",
  );
  const includeTools = parseToolList(
    (fm["include-tools"] as string | string[]) ||
      (fm.include_tools as string | string[]) ||
      "",
  );
  const toolDependencies = parseToolList(
    (fm["tool-dependencies"] as string | string[]) ||
      (fm.tool_dependencies as string | string[]) ||
      "",
  );

  return {
    name,
    description,
    license: (fm.license as string) || "",
    compatibility: (fm.compatibility as string) || "",
    metadata: (fm.metadata as Record<string, unknown>) || {},
    allowedTools,
    includeTools,
    toolDependencies,
    visible: toolDependencies.length === 0, // visible by default if no dependencies
    disableModelInvocation:
      (fm["disable-model-invocation"] as boolean) ||
      (fm.disable_model_invocation as boolean) ||
      false,
    loaded: false,
    content: body,
    location,
    additionalFiles: [],
  };
}

/**
 * Parse a tool list from YAML string or array.
 * Handles space-separated strings: "grep edit read"
 * and YAML arrays: ["grep", "edit", "read"]
 */
function parseToolList(val: string | string[] | undefined): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string") {
    // Could be space-separated or comma-separated
    return val
      .split(/[\s,]+/)
      .map((s: string) => s.trim())
      .filter(Boolean) as string[];
  }
  return [];
}

// ── Skills Loader ──────────────────────────────────────────────────────────

/**
 * Recursively collect additional files from a skill directory.
 * Stores paths relative to the skill root
 */
async function collectAdditionalFiles(
  dirPath: string,
  parentDir: string,
  files: string[] = [],
): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "SKILL.md") continue;
      const fullPath = join(dirPath, entry.name);
      if (entry.isFile()) {
        const relPath = join(parentDir, entry.name);
        files.push(relPath);
      } else if (entry.isDirectory()) {
        await collectAdditionalFiles(
          fullPath,
          join(parentDir, entry.name),
          files,
        );
      }
    }
  } catch {
    // Skip on error
  }
  files.sort();
  return files;
}

/**
 * SkillsLoader — loads and manages skills.
 */
export class SkillsLoader {
  private readonly paths: string[];
  private readonly skills: Map<string, Skill>;

  constructor(paths: string | string[]) {
    this.paths = Array.isArray(paths)
      ? paths
      : (paths
          .split(":")
          .map((p: string) => p.trim())
          .filter(Boolean) as string[]);
    this.skills = new Map();
  }

  /**
   * Load all skills from configured directories.
   * Returns number of skills loaded.
   */
  async loadSkills(): Promise<number> {
    let count = 0;
    for (const dir of this.paths) {
      count += await this.loadFromDirectory(dir);
    }
    return count;
  }

  private async loadFromDirectory(dir: string): Promise<number> {
    let count = 0;

    let entries: { isDirectory: () => boolean; name: string }[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillFile = join(dir, entry.name, "SKILL.md");
      let content: string;
      try {
        content = await fs.readFile(skillFile, "utf-8");
      } catch {
        continue; // No SKILL.md in this directory
      }

      try {
        const location = await fs.realpath(skillFile);
        const skill = parseSkillFromMd(content, entry.name, location);

        // Discover additional files (relative paths from skill root)
        skill.additionalFiles = await collectAdditionalFiles(
          join(dir, entry.name),
          entry.name,
        );

        // Collision detection
        if (this.skills.has(skill.name)) {
          const existing = this.skills.get(skill.name)!;
          logger.warn(
            `Skill '${skill.name}' already loaded (from ${existing.location}), overwriting with ${location}`,
            { existingLocation: existing.location, newLocation: location },
          );
        }

        this.skills.set(skill.name, skill);
        count++;
      } catch (e: unknown) {
        logger.warn(
          `Failed to load skill '${entry.name}': ${(e as Error).message}`,
          { error: (e as Error).message },
        );
      }
    }

    return count;
  }

  /**
   * Get a skill by name.
   */
  getSkill(name: string): Skill | null {
    return this.skills.get(name) || null;
  }

  /**
   * Get all skills.
   */
  allSkills(): Skill[] {
    return Array.from(this.skills.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /**
   * Get active/loaded skills.
   */
  activeSkills(): Skill[] {
    return this.allSkills().filter((skill) => skill.loaded);
  }

  agentViewableSkills(): Skill[] {
    return this.allSkills().filter((s) => !s.disableModelInvocation);
  }

  /**
   * Activate a skill (mark as loaded).
   */
  activateSkill(name: string): void {
    const skill = this.skills.get(name);
    if (skill) skill.loaded = true;
  }

  /**
   * Preload skills
   */
  preloadSkills(preloadSkills: string[]): void {
    if (preloadSkills.length > 0) {
      for (const name of preloadSkills) {
        this.activateSkill(name);
      }
    }
  }

  /**
   * Auto-activate skills whose tool-dependencies match available tools.
   * A skill becomes visible when at least one dependency pattern matches.
   * Skills without dependencies remain visible (default).
   * Does NOT set loaded — only visible.
   */
  setAvailableTools(availableTools: string[]): void {
    const availableLower = availableTools.map((t) => t.toLowerCase());
    for (const skill of this.skills.values()) {
      if (skill.toolDependencies.length === 0) {
        skill.visible = true;
        continue;
      }
      const matched = skill.toolDependencies.some((pattern) => {
        const patternLower = pattern.toLowerCase();
        return availableLower.some((tool) =>
          patternMatches(patternLower, tool),
        );
      });
      skill.visible = matched;
    }
  }

  /**
   * Get configured directories.
   */
  directories(): string[] {
    return [...this.paths];
  }

  /**
   * Build skills preamble content for the system prompt.
   */
  async buildSkillsPreamble(): Promise<string> {
    const visibleSkills = this.agentViewableSkills();

    if (visibleSkills.length === 0) return "";

    // Load the skills preamble template
    const templatePath = join(import.meta.dirname, "skills_preamble.md");

    let template: string;
    try {
      template = await fs.readFile(templatePath, "utf-8");
    } catch {
      logger.warn(`skills preamble ${templatePath} template error`);
      return "";
    }

    // Transform skills to match template expectations
    const renderedSkills = visibleSkills.map((s) => ({
      ...s,
      additional_files: s.additionalFiles || [],
    }));

    const context = {
      skills: renderedSkills,
      skill_directories: this.directories(),
    };

    return render(template, context);
  }
}
