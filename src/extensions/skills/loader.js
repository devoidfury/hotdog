// Skills loader — loads SKILL.md files from skill directories.
// Supports tool-dependencies, auto-activation, and pattern matching.

import fs from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { parseFrontMatter } from "../../utils/file-utils.js";
import { validateNameable } from "../../utils/file-utils.js";
import { render } from "../../utils/render.js";

// ── Pattern Matching ───────────────────────────────────────────────────────

/**
 * Match a tool name against a pattern that may contain '*' wildcards.
 * Uses DP-based glob matching.
 */
export function patternMatches(pattern, toolName) {
  if (pattern === toolName) return true;
  if (!pattern.includes("*")) return false;

  const pat = pattern.split("");
  const name = toolName.split("");
  const patLen = pat.length;
  const nameLen = name.length;

  // dp[i][j] = does pat[0..i] match name[0..j]?
  const dp = Array.from({ length: patLen + 1 }, () =>
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

/**
 * Parse a SKILL.md file into a Skill object.
 */
export function parseSkillFromMd(content, dirName, location) {
  const parsed = parseFrontMatter(content);
  if (!parsed) {
    throw new Error("No YAML frontmatter found");
  }

  const fm = parsed.frontMatter;
  const body = parsed.body;

  // Validate description
  if (!fm.description || !fm.description.trim()) {
    throw new Error("Skill description is missing or empty (required)");
  }

  // Warn on description length
  const descLen =
    typeof fm.description === "string" ? fm.description.length : 0;
  if (descLen > 1024) {
    console.warn(
      `Warning: Skill '${fm.name || dirName}' description exceeds 1024 characters (${descLen} chars), truncating`,
    );
  }

  const name = fm.name || dirName;

  // Lenient name validation
  const warnings = validateNameable(name, "Skill", dirName);
  for (const w of warnings) {
    console.warn(`Warning: Skill '${name}': ${w}`);
  }

  // Parse tool-related fields
  const allowedTools = parseToolList(
    fm["allowed-tools"] || fm.allowed_tools || "",
  );
  const includeTools = parseToolList(
    fm["include-tools"] || fm.include_tools || "",
  );
  const toolDependencies = parseToolList(
    fm["tool-dependencies"] || fm.tool_dependencies || "",
  );

  return {
    name,
    description: fm.description,
    license: fm.license || "",
    compatibility: fm.compatibility || "",
    metadata: fm.metadata || {},
    allowedTools,
    includeTools,
    toolDependencies,
    visible: toolDependencies.length === 0, // visible by default if no dependencies
    disableModelInvocation:
      fm["disable-model-invocation"] || fm.disable_model_invocation || false,
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
function parseToolList(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string") {
    // Could be space-separated or comma-separated
    return val
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

// ── Skills Loader ──────────────────────────────────────────────────────────

/**
 * Recursively collect additional files from a skill directory.
 * Stores paths relative to the skill root
 */
function collectAdditionalFiles(dirPath, parentDir, files = []) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "SKILL.md") continue;
      const fullPath = join(dirPath, entry.name);
      if (entry.isFile()) {
        const relPath = join(parentDir, entry.name);
        files.push(relPath);
      } else if (entry.isDirectory()) {
        collectAdditionalFiles(fullPath, join(parentDir, entry.name), files);
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
  constructor(paths) {
    this.paths = Array.isArray(paths)
      ? paths
      : paths
          .split(":")
          .map((p) => p.trim())
          .filter(Boolean);
    this.skills = new Map();
  }

  /**
   * Load all skills from configured directories.
   * Returns number of skills loaded.
   */
  loadSkills() {
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
      return 0;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillFile = join(dir, entry.name, "SKILL.md");
      let content;
      try {
        content = fs.readFileSync(skillFile, "utf-8");
      } catch {
        continue; // No SKILL.md in this directory
      }

      try {
        const location = fs.realpathSync(skillFile);
        const skill = parseSkillFromMd(content, entry.name, location);

        // Discover additional files (relative paths from skill root)
        skill.additionalFiles = collectAdditionalFiles(
          join(dir, entry.name),
          entry.name,
        );

        // Collision detection
        if (this.skills.has(skill.name)) {
          const existing = this.skills.get(skill.name);
          console.warn(
            `Warning: Skill '${skill.name}' already loaded (from ${existing.location}), overwriting with ${location}`,
          );
        }

        this.skills.set(skill.name, skill);
        count++;
      } catch (e) {
        console.warn(
          `Warning: Failed to load skill '${entry.name}': ${e.message}`,
        );
      }
    }

    return count;
  }

  /**
   * Get a skill by name.
   */
  getSkill(name) {
    return this.skills.get(name) || null;
  }

  /**
   * Get all skills.
   */
  allSkills() {
    return Array.from(this.skills.values());
  }

  /**
   * Get active/loaded skills.
   */
  activeSkills() {
    return this.allSkills().filter((skill) => skill.loaded);
  }

  agentViewableSkills() {
    return this.activeSkills().filter((s) => !s.disableModelInvocation);
  }

  /**
   * Activate a skill (mark as loaded).
   */
  activateSkill(name) {
    const skill = this.skills.get(name);
    if (skill) skill.loaded = true;
  }

  /**
   * Preload skills
   */
  preloadSkills(preloadSkills) {
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
  setAvailableTools(availableTools) {
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
  directories() {
    return [...this.paths];
  }

  /**
   * Build skills preamble content for the system prompt.
   */
  buildSkillsPreamble() {
    const visibleSkills = this.agentViewableSkills();

    if (visibleSkills.length === 0) return "";

    // Load the skills preamble template
    const templatePath = join(
      cwd(),
      "config",
      "templates",
      "skills_preamble.md",
    );
    let template;
    try {
      template = fs.readFileSync(templatePath, "utf-8");
    } catch {
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
