import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSystemPrompt,
  SystemPromptBuilder,
  createSystemPromptBuilder,
  collectSystemPromptChunks,
} from "@core/context/system-prompt.ts";
import { loadProfileFile } from "@core/config/profiles.ts";
import { Message } from "@core/context/message.ts";

describe("buildSystemPrompt", () => {
  it("builds a system prompt with body and chunks", async () => {
    const result = await buildSystemPrompt(
      "Test body content",
      "qwen3.5-0.8b",
      "test",
      [
        {
          name: "test:chunk",
          priority: 100,
          content: "\n# Test Chunk\n\nTest content here",
        },
      ],
    );
    expect(typeof result).toBe("string");
    expect(result).toContain("Test body content");
    expect(result).toContain("Test content here");
  });

  it("renders chunks in the order provided", async () => {
    const result = await buildSystemPrompt(
      "test",
      "test",
      "test",
      [
        { name: "a:first", priority: 100, content: "\n# First" },
        { name: "a:second", priority: 200, content: "\n# Second" },
      ],
    );
    const firstIdx = result.indexOf("# First");
    const secondIdx = result.indexOf("# Second");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("handles empty chunks and inputs gracefully", async () => {
    const result = await buildSystemPrompt("test", "test", "test", []);
    expect(typeof result).toBe("string");
    expect(result).toContain("test");
  });

  it("includes body when provided", async () => {
    const result = await buildSystemPrompt(
      "Custom body text",
      "test",
      "test",
      [],
    );
    expect(result).toContain("Custom body text");
  });
});

describe("buildSystemPrompt with explicit template", () => {
  it("renders the supplied template text without touching disk", async () => {
    const result = await buildSystemPrompt(
      "Explicit body",
      "model-x",
      "default",
      [],
      "TEMPLATE: {{ body }} / {{ model }} / {{ profile_name }}",
    );
    expect(result).toBe("TEMPLATE: Explicit body / model-x / default");
  });
});

describe("collectSystemPromptChunks", () => {
  it("collects chunks from hook results", () => {
    const results = [
      { result: { name: "chunk1", priority: 100, content: "content1" }, source: "ext1" },
      { result: { name: "chunk2", priority: 50, content: "content2" }, source: null },
    ];
    const chunks = collectSystemPromptChunks(results);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.name).toBe("chunk2"); // lower priority first
    expect(chunks[1]!.name).toBe("ext1:chunk1");
  });

  it("handles arrays of chunks from a single result", () => {
    const results = [
      {
        result: [
          { name: "a", priority: 10, content: "A" },
          { name: "b", priority: 20, content: "B" },
        ],
        source: "ext",
      },
    ];
    const chunks = collectSystemPromptChunks(results);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.name).toBe("ext:a");
    expect(chunks[1]!.name).toBe("ext:b");
  });

  it("ignores invalid items", () => {
    const results = [
      { result: { name: "valid", priority: 10, content: "ok" }, source: null },
      { result: { name: "no-content", priority: 10 }, source: null },
      { result: null, source: null },
      { result: {}, source: null },
    ];
    const chunks = collectSystemPromptChunks(results);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.name).toBe("valid");
  });
});

describe("SystemPromptBuilder", () => {
  const mockHooks = {
    runHookPipeline: async (_name: string, _data: unknown) => ({
      results: [
        {
          result: { name: "test-chunk", priority: 100, content: "\n# Test" },
          source: "test",
        },
      ],
    }),
  };

  const mockConfig = {
    profileBody: "Test body",
    model: "test-model",
    profileName: "test-profile",
  };

  it("starts with no cached prompt", () => {
    const builder = new SystemPromptBuilder();
    expect(builder.getPrompt()).toBeNull();
    expect(builder.isBuilt()).toBe(false);
  });

  it("builds and caches the system prompt", async () => {
    const builder = new SystemPromptBuilder();
    const prompt = await builder.build(mockHooks, {}, mockConfig);
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("Test body");
    expect(builder.getPrompt()).toBe(prompt);
    expect(builder.isBuilt()).toBe(true);
  });

  it("ensureBuilt returns cached prompt without rebuilding", async () => {
    const builder = new SystemPromptBuilder();
    const first = await builder.ensureBuilt(mockHooks, {}, mockConfig);
    const second = await builder.ensureBuilt(mockHooks, {}, mockConfig);
    expect(first).toBe(second);
  });

  it("clear removes the cached prompt", async () => {
    const builder = new SystemPromptBuilder();
    await builder.build(mockHooks, {}, mockConfig);
    expect(builder.isBuilt()).toBe(true);
    builder.clear();
    expect(builder.getPrompt()).toBeNull();
    expect(builder.isBuilt()).toBe(false);
  });

  it("uses default values for missing config fields", async () => {
    const builder = new SystemPromptBuilder();
    const prompt = await builder.build(mockHooks, {}, {
      profileBody: undefined,
      model: "fallback-model",
      profileName: undefined,
    });
    expect(typeof prompt).toBe("string");
  });

  it("uses the explicitly supplied template instead of config-dir resolution", async () => {
    const builder = new SystemPromptBuilder("X: {{ profile_name }}");
    const prompt = await builder.build(mockHooks, {}, mockConfig);
    expect(prompt).toContain("X: test-profile");
  });
});

describe("createSystemPromptBuilder", () => {
  it("creates a new SystemPromptBuilder instance", () => {
    const builder = createSystemPromptBuilder();
    expect(builder).toBeInstanceOf(SystemPromptBuilder);
    expect(builder.getPrompt()).toBeNull();
  });
});

// New invariant after the profile-`role` removal: a profile file that still
// carries a legacy `role:` line must yield a system prompt with NO injected
// role section, and the prompt pipeline must not crash on such input. The
// message-role (wire/format) encoding is a separate, untouched concept and is
// asserted here too, to prove the two never got conflated.
describe("profile role input is ignored by prompt assembly", () => {
  const mockHooks = {
    runHookPipeline: async () => ({ results: [] }),
  };

  it("a legacy role line in a profile file never reaches the system prompt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-roleless-"));
    try {
      fs.writeFileSync(
        path.join(dir, "legacy.profile.md"),
        [
          "---",
          "name: legacy",
          "description: profile that still has a legacy role line",
          "role: INJECTED ROLE MUST NOT APPEAR",
          "---",
          "Body of the profile.",
          "",
        ].join("\n"),
        "utf-8",
      );

      // Parsing must not crash, and must drop the role field entirely.
      const profile = await loadProfileFile(dir, "legacy");
      expect(profile).not.toBeNull();
      expect(profile!.body).toContain("Body of the profile.");
      expect(profile!.role).toBeUndefined();

      // Prompt assembly from that profile carries only the body: no role text.
      const builder = new SystemPromptBuilder("PROMPT: {{ body }}|{{ role }}");
      const prompt = await builder.build(mockHooks, {}, {
        profileBody: profile!.body,
        model: "m",
        profileName: "legacy",
      });
      // `{{ role }}` is no longer in the render context: it renders empty.
      expect(prompt).toBe(`PROMPT: ${profile!.body}|`);
      expect(prompt).not.toContain("INJECTED ROLE");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a legacy role key in a config-defined profile is dropped by ProfileManager", async () => {
    const { ProfileManager } = await import("@core/config/profiles.ts");
    const manager = new ProfileManager("/nonexistent-profiles-dir", {
      "cfg-profile": { name: "cfg-profile", role: "CONFIG ROLE" } as never,
    });
    const p = manager.getProfile("cfg-profile");
    expect(p).not.toBeNull();
    expect(p!.role).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("CONFIG ROLE");
  });

  it("message-role encoding still round-trips untouched", () => {
    for (const role of ["user", "assistant", "tool", "harness", "system"]) {
      const msg = new Message({ role, content: `hello ${role}` });
      const restored = Message.fromJSON(msg.toJSON());
      expect(restored.role).toBe(role);
    }
  });
});
