// Tests for skills extension — create(), hooks, and SkillsLoader.

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { create } from "../../src/extensions/skills/index.ts";
import { SkillsLoader, patternMatches } from "../../src/extensions/skills/loader.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { ACTIONS } from "../../src/core/commands.ts";
import { ExtensionInstance } from "../../src/core/extensions/types.ts";
import fs from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

// ── patternMatches Tests ────────────────────────────────────────────────────

describe("patternMatches", () => {
  it("matches exact strings", () => {
    expect(patternMatches("read", "read")).toBe(true);
    expect(patternMatches("bash", "bash")).toBe(true);
  });

  it("does not match different strings", () => {
    expect(patternMatches("read", "overwrite")).toBe(false);
    expect(patternMatches("bash", "cat")).toBe(false);
  });

  it("matches wildcard at end", () => {
    expect(patternMatches("read*", "read")).toBe(true);
    expect(patternMatches("read*", "read_file")).toBe(true);
    expect(patternMatches("read*", "read-something")).toBe(true);
  });

  it("matches wildcard at beginning", () => {
    expect(patternMatches("*read", "read")).toBe(true);
    expect(patternMatches("*read", "file_read")).toBe(true);
  });

  it("matches wildcard in middle", () => {
    expect(patternMatches("read_*", "read_file")).toBe(true);
    expect(patternMatches("file_*_tool", "file_read_tool")).toBe(true);
  });

  it("matches multiple wildcards", () => {
    expect(patternMatches("*_*", "a_b")).toBe(true);
    expect(patternMatches("*_*_*", "a_b_c")).toBe(true);
  });

  it("matches full wildcard", () => {
    expect(patternMatches("*", "anything")).toBe(true);
    expect(patternMatches("*", "")).toBe(true);
  });

  it("returns false for no match with wildcard", () => {
    expect(patternMatches("read*", "overwrite")).toBe(false);
    expect(patternMatches("*bash", "cat")).toBe(false);
  });

  it("handles empty pattern", () => {
    expect(patternMatches("", "")).toBe(true);
    expect(patternMatches("", "read")).toBe(false);
  });

  it("handles empty tool name", () => {
    expect(patternMatches("read", "")).toBe(false);
    expect(patternMatches("*", "")).toBe(true);
  });

  it("is case sensitive", () => {
    expect(patternMatches("Read", "read")).toBe(false);
    expect(patternMatches("READ", "read")).toBe(false);
  });

  it("matches complex patterns", () => {
    expect(patternMatches("core-*", "core-read")).toBe(true);
    expect(patternMatches("core-*", "core-write")).toBe(true);
    expect(patternMatches("core-*", "core-read-file")).toBe(true);
    expect(patternMatches("core-*", "other-read")).toBe(false);
  });
});

// ── SkillsLoader Tests ──────────────────────────────────────────────────────

describe("SkillsLoader", () => {
  let tempDir: string;

  async function createTempSkill(name: string, content: string): Promise<string> {
    const skillDir = join(tempDir, name);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(join(skillDir, "SKILL.md"), content);
    return skillDir;
  }

  beforeEach(async () => {
    tempDir = join(os.tmpdir(), `hotdog-skills-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("constructor", () => {
    it("accepts a single path string", () => {
      const loader = new SkillsLoader("/some/path");
      expect(loader.directories()).toEqual(["/some/path"]);
    });

    it("accepts a colon-separated path string", () => {
      const loader = new SkillsLoader("/path1:/path2");
      expect(loader.directories()).toEqual(["/path1", "/path2"]);
    });

    it("accepts an array of paths", () => {
      const loader = new SkillsLoader(["/path1", "/path2"]);
      expect(loader.directories()).toEqual(["/path1", "/path2"]);
    });

    it("trims and filters empty paths", () => {
      const loader = new SkillsLoader(" /path1 : :/path2: ");
      expect(loader.directories()).toEqual(["/path1", "/path2"]);
    });
  });

  describe("loadSkills", () => {
    it("returns 0 for non-existent directory", async () => {
      const loader = new SkillsLoader("/non-existent");
      const count = await loader.loadSkills();
      expect(count).toBe(0);
    });

    it("loads a valid skill", async () => {
      await createTempSkill("test-skill", `---
name: Test Skill
description: A test skill for testing
---

Skill content here.
`);

      const loader = new SkillsLoader(tempDir);
      const count = await loader.loadSkills();
      expect(count).toBe(1);

      const skill = loader.getSkill("Test Skill");
      expect(skill).not.toBeNull();
      expect(skill!.name).toBe("Test Skill");
      expect(skill!.description).toBe("A test skill for testing");
      expect(skill!.content).toContain("Skill content here");
      expect(skill!.loaded).toBe(false);
    });

    it("uses directory name when no name in frontmatter", async () => {
      await createTempSkill("my-skill", `---
description: No name skill
---

Content.
`);

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();

      const skill = loader.getSkill("my-skill");
      expect(skill).not.toBeNull();
      expect(skill!.name).toBe("my-skill");
    });

    it("skills directory without SKILL.md", async () => {
      const emptyDir = join(tempDir, "empty-skill");
      await fs.mkdir(emptyDir, { recursive: true });

      const loader = new SkillsLoader(tempDir);
      const count = await loader.loadSkills();
      expect(count).toBe(0);
    });

    it("skips skill with missing description", async () => {
      await createTempSkill("bad-skill", `---
name: Bad Skill
---

Content without description.
`);

      const loader = new SkillsLoader(tempDir);
      const count = await loader.loadSkills();
      expect(count).toBe(0);
    });

    it("parses allowed-tools from frontmatter", async () => {
      await createTempSkill("tool-skill", `---
name: Tool Skill
description: A skill with tool restrictions
allowed-tools: ["read", "overwrite"]
---

Content.
`);

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();

      const skill = loader.getSkill("Tool Skill");
      expect(skill).not.toBeNull();
      expect(skill!.allowedTools).toEqual(["read", "overwrite"]);
    });

    it("parses include-tools from frontmatter", async () => {
      await createTempSkill("include-skill", `---
name: Include Skill
description: A skill with include tools
include-tools: grep edit read
---

Content.
`);

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();

      const skill = loader.getSkill("Include Skill");
      expect(skill).not.toBeNull();
      expect(skill!.includeTools).toEqual(["grep", "edit", "read"]);
    });

    it("parses tool-dependencies from frontmatter", async () => {
      await createTempSkill("dep-skill", `---
name: Dep Skill
description: A skill with tool dependencies
tool-dependencies: ["bash", "read"]
---

Content.
`);

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();

      const skill = loader.getSkill("Dep Skill");
      expect(skill).not.toBeNull();
      expect(skill!.toolDependencies).toEqual(["bash", "read"]);
      expect(skill!.visible).toBe(false); // Not visible until dependencies are met
    });

    it("parses allowed_tools (snake_case) from frontmatter", async () => {
      await createTempSkill("snake-skill", `---
name: Snake Skill
description: Snake case tools
allowed_tools: read,overwrite,bash
---

Content.
`);

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();

      const skill = loader.getSkill("Snake Skill");
      expect(skill).not.toBeNull();
      expect(skill!.allowedTools).toEqual(["read", "overwrite", "bash"]);
    });

    it("collects additional files", async () => {
      const skillDir = join(tempDir, "file-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(join(skillDir, "SKILL.md"), `---
name: File Skill
description: Skill with files
---

Content.
`);
      await fs.writeFile(join(skillDir, "template.md"), "Template content");
      await fs.mkdir(join(skillDir, "subdir"), { recursive: true });
      await fs.writeFile(join(skillDir, "subdir", "data.json"), "{}");

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();

      const skill = loader.getSkill("File Skill");
      expect(skill).not.toBeNull();
      expect(skill!.additionalFiles.length).toBeGreaterThan(0);
    });

    it("handles skill name collision", async () => {
      // Create two skills with the same name in different directories
      await createTempSkill("skill1", `---
name: Same Name
description: First skill
---

Content 1.
`);

      await createTempSkill("skill2", `---
name: Same Name
description: Second skill
---

Content 2.
`);

      const loader = new SkillsLoader(tempDir);
      const count = await loader.loadSkills();
      expect(count).toBe(2);

      // Second one should overwrite the first
      const skill = loader.getSkill("Same Name");
      expect(skill).not.toBeNull();
      expect(skill!.description).toBe("Second skill");
    });
  });

  describe("getSkill / allSkills / activeSkills", () => {
    it("returns null for non-existent skill", () => {
      const loader = new SkillsLoader("/non-existent");
      expect(loader.getSkill("nonexistent")).toBeNull();
    });

    it("allSkills returns sorted skills", async () => {
      await createTempSkill("z-skill", `---
name: Z Skill
description: Last
---

Content.
`);
      await createTempSkill("a-skill", `---
name: A Skill
description: First
---

Content.
`);

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();

      const skills = loader.allSkills();
      expect(skills).toHaveLength(2);
      expect(skills[0]!.name).toBe("A Skill");
      expect(skills[1]!.name).toBe("Z Skill");
    });

    it("activeSkills returns only loaded skills", async () => {
      await createTempSkill("active-skill", `---
name: Active Skill
description: Active
---

Content.
`);
      await createTempSkill("inactive-skill", `---
name: Inactive Skill
description: Inactive
---

Content.
`);

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();

      expect(loader.activeSkills()).toHaveLength(0);

      loader.activateSkill("Active Skill");
      expect(loader.activeSkills()).toHaveLength(1);
      expect(loader.activeSkills()[0]!.name).toBe("Active Skill");
    });
  });

  describe("activateSkill / preloadSkills", () => {
    it("activates a skill by name", async () => {
      await createTempSkill("test-skill", `---
name: Test Skill
description: Test
---

Content.
`);

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();

      expect(loader.getSkill("Test Skill")!.loaded).toBe(false);
      loader.activateSkill("Test Skill");
      expect(loader.getSkill("Test Skill")!.loaded).toBe(true);
    });

    it("does nothing for non-existent skill name", () => {
      const loader = new SkillsLoader("/non-existent");
      // Should not throw
      loader.activateSkill("nonexistent");
    });

    it("preloads multiple skills", async () => {
      await createTempSkill("skill1", `---
name: Skill One
description: One
---

Content.
`);
      await createTempSkill("skill2", `---
name: Skill Two
description: Two
---

Content.
`);

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();

      loader.preloadSkills(["Skill One", "Skill Two"]);
      expect(loader.getSkill("Skill One")!.loaded).toBe(true);
      expect(loader.getSkill("Skill Two")!.loaded).toBe(true);
    });

    it("preloadSkills with empty array does nothing", async () => {
      await createTempSkill("test-skill", `---
name: Test Skill
description: Test
---

Content.
`);

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();

      loader.preloadSkills([]);
      expect(loader.getSkill("Test Skill")!.loaded).toBe(false);
    });
  });

  describe("setAvailableTools", () => {
    it("makes skills without dependencies visible", async () => {
      await createTempSkill("no-dep-skill", `---
name: No Dep Skill
description: No dependencies
---

Content.
`);

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();

      loader.setAvailableTools([]);
      expect(loader.getSkill("No Dep Skill")!.visible).toBe(true);
    });

    it("makes skills visible when dependencies match", async () => {
      await createTempSkill("dep-skill", `---
name: Dep Skill
description: Has dependencies
tool-dependencies: ["bash", "read"]
---

Content.
`);

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();

      // Initially not visible
      expect(loader.getSkill("Dep Skill")!.visible).toBe(false);

      // Set available tools that match
      loader.setAvailableTools(["bash", "overwrite"]);
      expect(loader.getSkill("Dep Skill")!.visible).toBe(true);
    });

    it("keeps skill hidden when no dependency matches", async () => {
      await createTempSkill("dep-skill", `---
name: Dep Skill
description: Has dependencies
tool-dependencies: ["bash", "read"]
---

Content.
`);

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();

      loader.setAvailableTools(["overwrite", "grep"]);
      expect(loader.getSkill("Dep Skill")!.visible).toBe(false);
    });

    it("matches wildcard dependencies", async () => {
      await createTempSkill("wildcard-dep-skill", `---
name: Wildcard Dep Skill
description: Has wildcard dependencies
tool-dependencies: ["core-*"]
---

Content.
`);

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();

      loader.setAvailableTools(["core-read", "other-tool"]);
      expect(loader.getSkill("Wildcard Dep Skill")!.visible).toBe(true);
    });
  });

  describe("agentViewableSkills", () => {
    it("returns skills not disabled for model invocation", async () => {
      await createTempSkill("visible-skill", `---
name: Visible Skill
description: Visible skill
---

Content.
`);
      await createTempSkill("hidden-skill", `---
name: Hidden Skill
description: Hidden from model
disable-model-invocation: true
---

Content.
`);

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();

      const viewable = loader.agentViewableSkills();
      expect(viewable).toHaveLength(1);
      expect(viewable[0]!.name).toBe("Visible Skill");
    });
  });

  describe("buildSkillsPreamble", () => {
    it("returns empty string when no visible skills", async () => {
      const loader = new SkillsLoader("/non-existent");
      await loader.loadSkills();
      const preamble = await loader.buildSkillsPreamble();
      expect(preamble).toBe("");
    });

    it("returns preamble with visible skills", async () => {
      await createTempSkill("test-skill", `---
name: Test Skill
description: A test skill
---

# Test Skill

This is the skill content.
`);

      const loader = new SkillsLoader(tempDir);
      await loader.loadSkills();
      const preamble = await loader.buildSkillsPreamble();
      expect(preamble).toContain("Test Skill");
    });
  });
});

// ── Skills Extension Tests ──────────────────────────────────────────────────

describe("Skills Extension", () => {
  let tempDir: string;

  async function createTempSkill(name: string, content: string): Promise<void> {
    const skillDir = join(tempDir, name);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(join(skillDir, "SKILL.md"), content);
  }

  beforeEach(async () => {
    tempDir = join(os.tmpdir(), `hotdog-skill-ext-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  function createMockCore(config: Record<string, unknown> = {}) {
    return {
      config: {
        skills: {
          path: tempDir,
          preloadSkills: [],
          ...config,
        },
      },
    } as any;
  }

  it("throws when skills path is not configured", async () => {
    const core = createMockCore({ path: undefined });
    await expect(create(core)).rejects.toThrow("skills path not configured");
  });

  it("creates extension with valid config", async () => {
    await createTempSkill("test-skill", `---
name: Test Skill
description: A test skill
---

Content.
`);

    const core = createMockCore();
    const ext = (await create(core)) as any;
    expect(ext).toBeDefined();
    expect(ext.loader).toBeDefined();
  });

  it("preloads skills from config", async () => {
    await createTempSkill("preload-skill", `---
name: Preload Skill
description: Preloaded
---

Content.
`);

    const core = createMockCore({ preloadSkills: ["Preload Skill"] });
    const ext = (await create(core)) as any;

    const skill = ext.loader.getSkill("Preload Skill");
    expect(skill).not.toBeNull();
    expect(skill!.loaded).toBe(true);
  });

  it("registers SYSTEM_PROMPT_BUILD hook", async () => {
    await createTempSkill("prompt-skill", `---
name: Prompt Skill
description: For system prompt
---

Content.
`);

    const core = createMockCore();
    const ext = (await create(core)) as any;

    expect(ext.hooks![HOOKS.SYSTEM_PROMPT_BUILD]).toBeDefined();
  });

  it("registers AGENT_TOOL_CONTEXT hook", async () => {
    const core = createMockCore();
    const ext = (await create(core)) as any;

    expect(ext.hooks![HOOKS.AGENT_TOOL_CONTEXT]).toBeDefined();

    // Test the hook
    const toolCtx: any = {};
    const setSpy = mock(() => {});
    toolCtx.set = setSpy;

    await ext.hooks![HOOKS.AGENT_TOOL_CONTEXT]({ toolCtx, toolName: "test", agent: {} });
    expect(setSpy).toHaveBeenCalledWith("skillsLoader", expect.anything());
  });

  it("registers TOOLS_REGISTER hook", async () => {
    const core = createMockCore();
    const ext = (await create(core)) as any;

    expect(ext.hooks![HOOKS.TOOLS_REGISTER]).toBeDefined();

    const registry: any = { register: mock(() => {}) };
    await ext.hooks![HOOKS.TOOLS_REGISTER](registry);
    expect(registry.register).toHaveBeenCalledWith("load_skill", expect.anything());
  });

  it("registers COMMANDS_REGISTER hook", async () => {
    const core = createMockCore();
    const ext = (await create(core)) as any;

    expect(ext.hooks![HOOKS.COMMANDS_REGISTER]).toBeDefined();

    const registry: any = { register: mock(() => {}) };
    await ext.hooks![HOOKS.COMMANDS_REGISTER]({ registry, agent: {} });
    expect(registry.register).toHaveBeenCalledWith("skill", expect.anything());
  });

  it("exposes getAllSkills method", async () => {
    await createTempSkill("all-skill", `---
name: All Skill
description: All skills test
---

Content.
`);

    const core = createMockCore();
    const ext = (await create(core)) as any;

    const skills = ext.getAllSkills();
    expect(skills).toHaveLength(1);
  });

  it("exposes getActiveSkills method", async () => {
    await createTempSkill("active-skill", `---
name: Active Skill
description: Active test
---

Content.
`);

    const core = createMockCore();
    const ext = (await create(core)) as any;

    const active = ext.getActiveSkills();
    expect(active).toHaveLength(0); // None loaded yet

    ext.loader.activateSkill("Active Skill");
    const activeAfter = ext.getActiveSkills();
    expect(activeAfter).toHaveLength(1);
  });

  it("exposes getCombinedToolPatterns method", async () => {
    await createTempSkill("pattern-skill", `---
name: Pattern Skill
description: Pattern test
include-tools: ["read", "overwrite"]
---

Content.
`);

    const core = createMockCore();
    const ext = (await create(core)) as any;

    // Initially empty (skill not loaded)
    expect(ext.getCombinedToolPatterns().size).toBe(0);

    // Load the skill
    ext.loader.activateSkill("Pattern Skill");
    const patterns = ext.getCombinedToolPatterns();
    expect(patterns.has("read")).toBe(true);
    expect(patterns.has("overwrite")).toBe(true);
  });

  it("isToolAllowed returns true when no patterns", async () => {
    const core = createMockCore();
    const ext = (await create(core)) as any;

    expect(ext.isToolAllowed("any-tool")).toBe(true);
  });

  it("isToolAllowed matches patterns", async () => {
    await createTempSkill("allowed-skill", `---
name: Allowed Skill
description: Allowed tools test
include-tools: ["read", "bash"]
---

Content.
`);

    const core = createMockCore();
    const ext = (await create(core)) as any;

    // Load the skill
    ext.loader.activateSkill("Allowed Skill");

    expect(ext.isToolAllowed("read")).toBe(true);
    expect(ext.isToolAllowed("bash")).toBe(true);
    expect(ext.isToolAllowed("overwrite")).toBe(false);
  });

  it("isToolAllowed is case insensitive", async () => {
    await createTempSkill("case-skill", `---
name: Case Skill
description: Case test
include-tools: ["Read"]
---

Content.
`);

    const core = createMockCore();
    const ext = (await create(core)) as any;

    ext.loader.activateSkill("Case Skill");

    expect(ext.isToolAllowed("read")).toBe(true);
    expect(ext.isToolAllowed("READ")).toBe(true);
  });

  it("skill command lists skills", async () => {
    await createTempSkill("list-skill", `---
name: List Skill
description: For listing
---

Content.
`);

    const core = createMockCore();
    const ext = (await create(core)) as any;

    const registry: any = { register: mock(() => {}) };
    await ext.hooks![HOOKS.COMMANDS_REGISTER]({ registry, agent: {} });

    // Get the registered command
    const skillCmd = registry.register.mock.calls[0]?.[1];
    const result = await skillCmd.handler({}, "skill");
    expect(result.action).toBe(ACTIONS.DISPLAY);
    expect(result.content).toContain("Available Skills");
  });

  it("skill:<name> command activates skill", async () => {
    await createTempSkill("activate-cmd-skill", `---
name: Activate Cmd Skill
description: For activation
---

Content.
`);

    const core = createMockCore();
    const ext = (await create(core)) as any;

    const registry: any = { register: mock(() => {}) };
    await ext.hooks![HOOKS.COMMANDS_REGISTER]({ registry, agent: {} });

    const skillCmd = registry.register.mock.calls[0]?.[1];
    const result = await skillCmd.handler({}, "skill:Activate Cmd Skill");
    expect(result.action).toBe(ACTIONS.DISPLAY);
    expect(result.content).toContain("activated");

    expect(ext.loader.getSkill("Activate Cmd Skill")!.loaded).toBe(true);
  });
});
