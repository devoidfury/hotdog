import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  create as createShowMe,
  extractGeneratedImage,
  generateImage,
  normalizeSize,
  parseShowMeArgs,
  pickImageModel,
  selectImageModelEntry,
  type ImageChatClient,
} from "@experimental/show-me/index.ts";
import { HOOKS } from "@core/hooks.ts";
import { ACTIONS } from "@core/commands.ts";
import { ToolError } from "@core/error.ts";
import type { ModelConfig } from "@core/config/providers.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_B64 = PNG_BYTES.toString("base64");

const REGISTRY: Record<string, unknown> = {
  "picgen/draw-1": {
    name: "picgen/draw-1",
    inputModalities: ["text"],
    outputModalities: ["image"],
  },
  "picgen/draw-vision": {
    name: "picgen/draw-vision",
    inputModalities: ["text", "image"],
    outputModalities: ["image"],
  },
  "chat/chatty": {
    name: "chat/chatty",
    inputModalities: ["text"],
    outputModalities: ["text"],
  },
  "mystery/box": { name: "mystery/box" },
};

interface Captured {
  requests?: Record<string, unknown>[];
  paths?: string[];
  modelConfigs?: Record<string, unknown>[];
}

/**
 * Faked client (duck-typed, never mock.module): records what the extension
 * asked to send and answers with a canned JSON Response. No network involved.
 */
function makeFakeClient(payload: unknown, captured: Captured) {
  const client = {
    resolveProviderSettings: () => ({ url: "http://fake.test", apiKey: "k", provider: null }),
    _doRequest: async (
      _url: string,
      _key: string | null,
      request: Record<string, unknown>,
      _signal: AbortSignal | null,
      modelConfig: ModelConfig,
      path: string,
    ) => {
      (captured.requests ??= []).push(request);
      (captured.paths ??= []).push(path);
      (captured.modelConfigs ??= []).push(modelConfig as unknown as Record<string, unknown>);
      return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
      });
    },
  };
  return client as unknown as ImageChatClient;
}

function imagePayload(b64: string = PNG_B64) {
  return { created: 1700000000, data: [{ b64_json: b64 }] };
}

function makeCore(showMe: Record<string, unknown> = {}) {
  return {
    config: {
      showMe: { enabled: true, imageModel: "picgen/draw-1", ...showMe },
    },
  } as any;
}

function makeAgent(client: ImageChatClient, registry: Record<string, unknown> = REGISTRY) {
  const emitted: Array<[string, unknown]> = [];
  const agent = {
    llmClient: client,
    modelRegistry: registry,
    contextLimit: 4096,
    sessionId: "s1",
    abortSignal: null,
    emitOutput: (type: string, data: unknown) => emitted.push([type, data]),
  } as any;
  return { agent, emitted };
}

function toolCtx(agent: unknown) {
  return { get: (key: string) => (key === "agent" ? agent : undefined) } as any;
}

// ── Size Parsing ────────────────────────────────────────────────────────────

describe("parseShowMeArgs", () => {
  it("defaults to 1024x1024 when no size token is present", () => {
    expect(parseShowMeArgs("a kitten")).toEqual({ size: "1024x1024", prompt: "a kitten" });
  });

  it("parses a leading WIDTHxHEIGHT token", () => {
    const { size, prompt } = parseShowMeArgs(
      "1024x768 A kitten falling into a puddle, it's glassy reflection smirking back at it, abstract",
    );
    expect(size).toBe("1024x768");
    expect(prompt).toBe(
      "A kitten falling into a puddle, it's glassy reflection smirking back at it, abstract",
    );
  });

  it("accepts uppercase X and normalizes to lowercase", () => {
    expect(parseShowMeArgs("512X512 cat")).toEqual({ size: "512x512", prompt: "cat" });
  });

  it("keeps a zero-dimension token in the prompt", () => {
    expect(parseShowMeArgs("0x0 cat")).toEqual({ size: "1024x1024", prompt: "0x0 cat" });
  });

  it("handles a size-only argument (empty prompt)", () => {
    expect(parseShowMeArgs("800x600")).toEqual({ size: "800x600", prompt: "" });
  });
});

describe("normalizeSize", () => {
  it("defaults when absent", () => {
    expect(normalizeSize(undefined)).toBe("1024x1024");
    expect(normalizeSize("")).toBe("1024x1024");
  });

  it("trims and normalizes", () => {
    expect(normalizeSize(" 800x600 ")).toBe("800x600");
  });

  it("rejects malformed sizes", () => {
    expect(() => normalizeSize("wide")).toThrow(ToolError);
    expect(() => normalizeSize("0x10")).toThrow(/Invalid size/);
    expect(() => normalizeSize(123 as unknown as string)).toThrow(/Invalid size/);
  });
});

// ── Model Selection ─────────────────────────────────────────────────────────

describe("selectImageModelEntry", () => {
  it("refuses unknown models", () => {
    expect(() => selectImageModelEntry(REGISTRY, "picgen/nope")).toThrow(/not found/);
  });

  it("refuses models without image output", () => {
    expect(() => selectImageModelEntry(REGISTRY, "chat/chatty")).toThrow(
      /does not declare image output/,
    );
  });

  it("refuses models with unknown modalities", () => {
    expect(() => selectImageModelEntry(REGISTRY, "mystery/box")).toThrow(
      /does not declare image output/,
    );
  });

  it("accepts an image-output model by full key or bare suffix", () => {
    expect(selectImageModelEntry(REGISTRY, "picgen/draw-1").name).toBe("picgen/draw-1");
    expect(selectImageModelEntry(REGISTRY, "draw-1").name).toBe("picgen/draw-1");
  });
});

// ── Auto Model Selection ────────────────────────────────────────────────────

describe("pickImageModel (auto mode)", () => {
  it("auto-selects the declared text->image entry when no model is configured", () => {
    const picked = pickImageModel(REGISTRY, "");
    expect(picked.auto).toBe(true);
    expect(picked.key).toBe("picgen/draw-1");
    expect(picked.name).toBe("picgen/draw-1");
  });

  it("skips entries with absent modality data and non-image-output entries", () => {
    // mystery/box (no modalities) sorts first here; it must never be auto-picked.
    const registry = {
      "mystery/box": { name: "mystery/box" },
      "chat/chatty": REGISTRY["chat/chatty"],
      "picgen/draw-1": REGISTRY["picgen/draw-1"],
    };
    expect(pickImageModel(registry, "").key).toBe("picgen/draw-1");
  });

  it("is deterministic across runs (first in registry iteration order wins)", () => {
    const registry = {
      "picgen/draw-1": REGISTRY["picgen/draw-1"],
      "picgen/draw-vision": REGISTRY["picgen/draw-vision"],
    };
    const first = pickImageModel(registry, "").key;
    for (let i = 0; i < 5; i++) {
      expect(pickImageModel({ ...registry }, "").key).toBe(first);
    }
    expect(first).toBe("picgen/draw-1");
  });

  it("errors helpfully on an empty registry, without crashing", () => {
    expect(() => pickImageModel({}, "")).toThrow(
      /no image model configured and no model in the registry declares .*outputModalities include "image".*showMe\.imageModel/,
    );
  });
});

// ── Response Decoding ───────────────────────────────────────────────────────

describe("extractGeneratedImage", () => {
  it("decodes a b64_json entry (defaults to png)", () => {
    const img = extractGeneratedImage(imagePayload());
    expect(img).not.toBeNull();
    expect(img!.mimeType).toBe("image/png");
    expect(img!.data.equals(PNG_BYTES)).toBe(true);
  });

  it("decodes a base64 data URL in a url entry", () => {
    const img = extractGeneratedImage({ created: 1, data: [{ url: `data:image/jpeg;base64,${PNG_B64}` }] });
    expect(img!.mimeType).toBe("image/jpeg");
    expect(img!.data.equals(PNG_BYTES)).toBe(true);
  });

  it("takes the first decodable entry", () => {
    const payload = { data: [{ revised_prompt: "safer" }, { b64_json: PNG_B64 }] };
    expect(extractGeneratedImage(payload)!.data.equals(PNG_BYTES)).toBe(true);
  });

  it("tolerates whitespace and newlines inside base64", () => {
    const split = `${PNG_B64.slice(0, 4)}\n${PNG_B64.slice(4)}`;
    const img = extractGeneratedImage(imagePayload(split));
    expect(img!.data.equals(PNG_BYTES)).toBe(true);
  });

  it("returns null for payloads without image bytes", () => {
    expect(extractGeneratedImage({ data: [] })).toBeNull();
    expect(extractGeneratedImage({ data: [{ revised_prompt: "safer" }] })).toBeNull();
    expect(extractGeneratedImage({})).toBeNull();
    expect(extractGeneratedImage(null)).toBeNull();
  });

  it("returns null for invalid base64 and remote (non-data) URLs", () => {
    expect(extractGeneratedImage(imagePayload("!!!!"))).toBeNull();
    expect(extractGeneratedImage({ data: [{ url: "https://example.com/cat.png" }] })).toBeNull();
  });
});

// ── Generation (faked protocol/client) ──────────────────────────────────────

describe("generateImage", () => {
  it("writes decoded bytes to output_path and emits the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "show-me-"));
    try {
      const outPath = join(dir, "deep", "kitten.png");
      const captured: Captured = {};
      const client = makeFakeClient(imagePayload(), captured);
      const emitted: string[] = [];

      const written = await generateImage({
        client,
        modelRegistry: REGISTRY,
        imageModel: "picgen/draw-1",
        contextLimit: 4096,
        prompt: "A kitten falling into a puddle",
        size: "1024x768",
        outputPath: outPath,
        emit: (line) => emitted.push(line),
      });

      expect(written).toBe(outPath);
      expect((await readFile(outPath)).equals(PNG_BYTES)).toBe(true);
      expect(emitted).toEqual([`Image saved: ${outPath}`]);

      // Request shape: Images API path, provider prefix stripped, size as its own field.
      expect(captured.paths).toEqual(["/v1/images/generations"]);
      expect(captured.modelConfigs![0]!.name).toBe("picgen/draw-1");
      expect(captured.requests![0]).toEqual({
        model: "draw-1",
        prompt: "A kitten falling into a puddle",
        size: "1024x768",
        response_format: "b64_json",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("errors without writing when the response carries no image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "show-me-"));
    try {
      const outPath = join(dir, "none.png");
      const client = makeFakeClient({ data: [{ revised_prompt: "no pic for you" }] }, {});

      await expect(
        generateImage({
          client,
          modelRegistry: REGISTRY,
          imageModel: "picgen/draw-1",
          contextLimit: 4096,
          prompt: "anything",
          size: "1024x1024",
          outputPath: outPath,
        }),
      ).rejects.toThrow(/returned no image/);
      expect(existsSync(outPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("auto mode (empty imageModel) generates with the picked model and announces it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "show-me-"));
    try {
      const outPath = join(dir, "auto.png");
      const captured: Captured = {};
      const client = makeFakeClient(imagePayload(), captured);
      const emitted: string[] = [];

      await generateImage({
        client,
        modelRegistry: REGISTRY,
        imageModel: "",
        contextLimit: 4096,
        prompt: "auto kitten",
        size: "1024x1024",
        outputPath: outPath,
        emit: (line) => emitted.push(line),
      });

      expect((await readFile(outPath)).equals(PNG_BYTES)).toBe(true);
      expect(captured.modelConfigs![0]!.name).toBe("picgen/draw-1");
      expect(emitted[0]).toBe("Using image model: picgen/draw-1");
      expect(emitted[1]).toBe(`Image saved: ${outPath}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("defaults to a timestamped file under ./generated/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "show-me-cwd-"));
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      const client = makeFakeClient(imagePayload(), {});
      const written = await generateImage({
        client,
        modelRegistry: REGISTRY,
        imageModel: "picgen/draw-1",
        contextLimit: 4096,
        prompt: "default path",
        size: "1024x1024",
      });
      expect(written.startsWith(join(dir, "generated") + "/")).toBe(true);
      expect(written).toMatch(/show-me-\d{4}-\d{2}-\d{2}T.*\.png$/);
      expect((await readFile(written)).equals(PNG_BYTES)).toBe(true);
    } finally {
      process.chdir(prevCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── Extension Wiring ────────────────────────────────────────────────────────

describe("show-me extension", () => {
  it("returns no hooks when disabled", () => {
    expect(createShowMe(makeCore({ enabled: false })).hooks).toBeUndefined();
  });

  it("registers the show_me tool", async () => {
    const inst = createShowMe(makeCore());
    const registered = new Map<string, any>();
    await inst.hooks![HOOKS.TOOLS_REGISTER]!({
      register: (name: string, tool: unknown) => registered.set(name, tool),
      getAll: () => [],
    } as any);

    const tool = registered.get("show_me");
    expect(tool).toBeDefined();
    const def = tool.toToolDef();
    expect(def.function.name).toBe("show_me");
    expect(def.function.parameters.required).toEqual(["description"]);
    expect(Object.keys(def.function.parameters.properties)).toEqual([
      "description",
      "size",
      "output_path",
    ]);
    expect(tool.metadata.sideEffects).toBe(true);
  });

  it("executes the tool through the faked client and emits the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "show-me-"));
    try {
      const outPath = join(dir, "tool.png");
      const captured: Captured = {};
      const client = makeFakeClient(imagePayload(), captured);
      const { agent, emitted } = makeAgent(client);

      const inst = createShowMe(makeCore());
      const registered = new Map<string, any>();
      await inst.hooks![HOOKS.TOOLS_REGISTER]!({
        register: (name: string, tool: unknown) => registered.set(name, tool),
        getAll: () => [],
      } as any);

      const result = await registered.get("show_me").execute(
        { description: "a kitten", size: "640x480", output_path: outPath },
        toolCtx(agent),
      );
      expect(result.isOk()).toBe(true);
      expect(result.output).toContain(outPath);
      expect((await readFile(outPath)).equals(PNG_BYTES)).toBe(true);
      expect(emitted).toEqual([["command_result", { content: `Image saved: ${outPath}` }]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("omitting the imageModel key entirely (no default injected) still enables auto mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "show-me-"));
    try {
      const outPath = join(dir, "bare.png");
      const client = makeFakeClient(imagePayload(), {});
      const { agent } = makeAgent(client);

      const inst = createShowMe({ config: { showMe: { enabled: true } } } as any);
      const registered = new Map<string, any>();
      await inst.hooks![HOOKS.TOOLS_REGISTER]!({
        register: (name: string, tool: unknown) => registered.set(name, tool),
        getAll: () => [],
      } as any);

      const result = await registered
        .get("show_me")
        .execute({ description: "a kitten", output_path: outPath }, toolCtx(agent));
      expect(result.isOk()).toBe(true);
      expect((await readFile(outPath)).equals(PNG_BYTES)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("auto mode: tool runs with the auto-picked model and shows its name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "show-me-"));
    try {
      const outPath = join(dir, "auto-tool.png");
      const client = makeFakeClient(imagePayload(), {});
      const { agent, emitted } = makeAgent(client);

      const inst = createShowMe(makeCore({ imageModel: "" }));
      const registered = new Map<string, any>();
      await inst.hooks![HOOKS.TOOLS_REGISTER]!({
        register: (name: string, tool: unknown) => registered.set(name, tool),
        getAll: () => [],
      } as any);

      const result = await registered
        .get("show_me")
        .execute({ description: "a kitten", output_path: outPath }, toolCtx(agent));
      expect(result.isOk()).toBe(true);
      expect(result.output).toContain(outPath);
      const lines = emitted.map(([, data]) => (data as { content: string }).content);
      expect(lines).toContain("Using image model: picgen/draw-1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("auto mode with no candidate: tool returns a helpful error, no crash", async () => {
    const client = makeFakeClient(imagePayload(), {});
    const { agent } = makeAgent(client, { "chat/chatty": REGISTRY["chat/chatty"] });

    const inst = createShowMe(makeCore({ imageModel: "" }));
    const registered = new Map<string, any>();
    await inst.hooks![HOOKS.TOOLS_REGISTER]!({
      register: (name: string, tool: unknown) => registered.set(name, tool),
      getAll: () => [],
    } as any);

    const result = await registered
      .get("show_me")
      .execute({ description: "a kitten" }, toolCtx(agent));
    expect(result.isErr()).toBe(true);
    expect(result.error).toContain('outputModalities include "image"');
    expect(result.error).toContain("showMe.imageModel");
  });

  it("auto mode with an empty registry: /show-me surfaces an ERROR action", async () => {
    const client = makeFakeClient(imagePayload(), {});
    const { agent } = makeAgent(client, {});

    const inst = createShowMe(makeCore({ imageModel: "" }));
    const commands = new Map<string, any>();
    await inst.hooks![HOOKS.COMMANDS_REGISTER]!({
      registry: { register: (name: string, def: unknown) => commands.set(name, def) },
      agent,
    } as any);

    const res = await commands.get("show-me").handler(agent, "show-me a kitten");
    expect(res.action).toBe(ACTIONS.ERROR);
    expect(res.error).toContain('outputModalities include "image"');
    expect(res.error).toContain("showMe.imageModel");
  });

  it("registers and runs the /show-me command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "show-me-cmd-"));
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      const captured: Captured = {};
      const client = makeFakeClient(imagePayload(), captured);
      const { agent, emitted } = makeAgent(client);

      const inst = createShowMe(makeCore());
      const commands = new Map<string, any>();
      await inst.hooks![HOOKS.COMMANDS_REGISTER]!({
        registry: { register: (name: string, def: unknown) => commands.set(name, def) },
        agent,
      } as any);

      const cmd = commands.get("show-me");
      expect(cmd).toBeDefined();
      expect(cmd.matches("show-me 1024x768 a kitten")).toBe(true);
      expect(cmd.matches("show-me-other")).toBe(false);

      const usage = await cmd.handler(agent, "show-me");
      expect(usage.action).toBe(ACTIONS.DISPLAY);
      expect(usage.content).toContain("Usage: /show-me");

      const result = await cmd.handler(
        agent,
        "show-me 1024x768 A kitten falling into a puddle, it's glassy reflection smirking back at it, abstract",
      );
      expect(result.action).toBe(ACTIONS.DISPLAY);
      expect(captured.paths).toEqual(["/v1/images/generations"]);
      expect((captured.requests![0] as { size: string; prompt: string }).size).toBe("1024x768");
      expect((captured.requests![0] as { prompt: string }).prompt).toContain(
        "A kitten falling into a puddle",
      );
      expect(emitted).toHaveLength(1);
      const [type, data] = emitted[0]!;
      expect(type).toBe("command_result");
      expect((data as { content: string }).content).toMatch(/^Image saved: .*generated[/\\]show-me-.*\.png$/);

      // Model refusal surfaces as an ERROR action, not a crash.
      const { agent: badAgent } = makeAgent(client, {
        "picgen/draw-1": { name: "picgen/draw-1", outputModalities: ["text"] },
      });
      const bad = await cmd.handler(badAgent, "show-me a kitten");
      expect(bad.action).toBe(ACTIONS.ERROR);
      expect(bad.error).toContain("does not declare image output");
    } finally {
      process.chdir(prevCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
