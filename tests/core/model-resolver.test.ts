import { describe, expect, it } from "bun:test";
import {
  planSpawn,
  laneKeyOf,
  type ModelRequirements,
} from "@core/session/model-resolver.ts";
import type { ModelConfig } from "@core/config/providers.ts";

function entry(name: string, over: Partial<ModelConfig> = {}): ModelConfig {
  return { name, temperature: null, contextLimit: 131072, tags: [], ...over };
}

// Fleet-shaped registry (cf. the 2026-09-23 /v1/models snapshot): some
// entries carry annotations, some do not.
const registry: Record<string, ModelConfig> = {
  "ai365/big": entry("ai365/big", {
    contextLimit: 262144,
    capabilities: { vision: true, toolCalling: true },
    maxToolDifficulty: 4,
  }),
  "ai365/small": entry("ai365/small", {
    contextLimit: 131072,
    capabilities: {},
  }),
  "ai365/vision-only": entry("ai365/vision-only", { capabilities: { vision: true } }),
  "mf-ai/mid": entry("mf-ai/mid", {
    contextLimit: 262144,
    capabilities: { toolCalling: true },
    maxToolDifficulty: 3,
  }),
  "mf-ai/tiny": entry("mf-ai/tiny", { contextLimit: 65536, capabilities: {} }),
};

const ok = async (input: Parameters<typeof planSpawn>[0]) => {
  const r = await planSpawn(input);
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return { model: r.candidates[0]!.key, provider: r.candidates[0]!.provider };
};

describe("laneKeyOf", () => {
  it("splits provider from model and buckets bare names", () => {
    expect(laneKeyOf("ai365/qwen3.8-27b")).toBe("ai365");
    expect(laneKeyOf("qwen3.8-27b")).toBe("");
  });
});

describe("planSpawn: pins", () => {
  it("qualified pin resolves to its registry key and lane", async () => {
    expect(await ok({ registry, pin: { model: "mf-ai/mid" } })).toEqual({
      model: "mf-ai/mid",
      provider: "mf-ai",
    });
  });

  it("bare pin suffix-matches a single provider's model", async () => {
    expect(await ok({ registry, pin: { model: "tiny" } })).toEqual({
      model: "mf-ai/tiny",
      provider: "mf-ai",
    });
  });

  it("bare pin with provider qualifier resolves within that provider", async () => {
    // "big" exists only on ai365; pinning a different provider must fail.
    expect(await ok({ registry, pin: { model: "big", provider: "ai365" } }).then((r) => r.model)).toBe("ai365/big");
    const bad = await planSpawn({ registry, pin: { model: "big", provider: "mf-ai" } });
    expect(bad.ok).toBe(false);
  });

  it("unknown pin errors against a non-empty catalog", async () => {
    const r = await planSpawn({ registry, pin: { model: "ghost" } });
    expect(!r.ok && r.error).toContain("not in the model catalog");
  });

  it("qualified pin with wrong provider reports where the model lives", async () => {
    const r = await planSpawn({ registry, pin: { model: "ai365/big", provider: "mf-ai" } });
    expect(!r.ok && r.error).toContain("lives on provider 'ai365'");
  });

  it("empty registry passes pins through unvalidated", async () => {
    expect(await ok({ registry: {}, pin: { model: "x/y" } })).toEqual({ model: "x/y", provider: "x" });
    expect(await ok({ registry: {}, pin: { model: "bare" } })).toEqual({ model: "bare", provider: "" });
  });

  it("pin violating declared requirements fails loud", async () => {
    const r = await planSpawn({
      registry,
      pin: { model: "ai365/small" },
      requires: { vision: true },
    });
    expect(!r.ok && r.error).toContain("violates requirements");
    expect(!r.ok && r.error).toContain("vision");
  });
});

describe("planSpawn: requirements", () => {
  const req = (requires: ModelRequirements) => planSpawn({ registry, requires });

  it("ctx filter excludes small models", async () => {
    const r = await req({ ctx: 200000 });
    expect(r.ok && r.candidates[0]!.key).toContain("/");
    const picked = r.ok ? r.candidates[0]!.key : "";
    expect(["ai365/big", "mf-ai/mid"]).toContain(picked);
  });

  it("vision requires the capability (not inferred from absence)", async () => {
    const r = await req({ vision: true });
    expect(r.ok && r.candidates[0]!.key).toBe("ai365/big"); // only ai365/big + vision-only; difficulty tie-break picks big
  });

  it("toolCalls filters on the parsed function_calling capability", async () => {
    const r = await req({ toolCalls: true });
    const picked = r.ok ? r.candidates[0]!.key : "";
    expect(["ai365/big", "mf-ai/mid"]).toContain(picked);
  });

  it("toolDifficulty excludes unannotated models", async () => {
    const r = await req({ toolDifficulty: 4 });
    expect(r.ok && r.candidates[0]!.key).toBe("ai365/big");
  });

  it("provider pin narrows the candidate set", async () => {
    const r = await planSpawn({ registry, pin: { provider: "mf-ai" }, requires: { ctx: 200000 } });
    expect(r.ok && r.candidates[0]!.key).toBe("mf-ai/mid");
  });

  it("provider pin alone resolves within the provider", async () => {
    const r = await planSpawn({ registry, pin: { provider: "mf-ai" } });
    expect(r.ok && r.candidates[0]!.provider).toBe("mf-ai");
  });

  it("unsatisfiable requirements error with a constraint summary", async () => {
    const r = await req({ ctx: 200000, vision: true, toolDifficulty: 5 });
    expect(!r.ok && r.error).toContain("no catalog model satisfies");
    expect(!r.ok && r.error).toContain("ctx>=200000");
    expect(!r.ok && r.error).toContain("tool-difficulty>=5");
  });

  it("empty catalog cannot resolve requirements", async () => {
    const r = await planSpawn({ registry: {}, requires: { vision: true } });
    expect(!r.ok && r.error).toContain("without a model catalog");
  });
});

describe("planSpawn: loaded-model preference", () => {
  it("prefers the provider that already has a compatible model loaded", async () => {
    // ai365/big has difficulty 4 but is not loaded; mf-ai/mid (3) is.
    const peekLoaded = async (provider: string) =>
      provider === "mf-ai" ? new Set(["mid"]) : new Set<string>();
    const r = await planSpawn({ registry, requires: { ctx: 200000 }, peekLoaded });
    expect(r.ok && r.candidates[0]!.key).toBe("mf-ai/mid");
  });

  it("without a peek, ties break on difficulty then provider", async () => {
    const r = await planSpawn({ registry, requires: { ctx: 200000 } });
    expect(r.ok && r.candidates[0]!.key).toBe("ai365/big"); // difficulty 4 > 3
  });

  it("peek compares the bare llama-swap id, not the registry key", async () => {
    const peekLoaded = async (provider: string) =>
      provider === "ai365" ? new Set(["small"]) : new Set<string>();
    const r = await planSpawn({
      registry,
      requires: { ctx: 131072, vision: true },
      peekLoaded,
    });
    // Only ai365 models satisfy vision here: small does NOT satisfy vision,
    // so the loaded-but-incompatible model must not be picked.
    expect(r.ok && r.candidates[0]!.key).toBe("ai365/big");
  });

  it("bare registry keys are compared to the peek set unsliced", async () => {
    // Bare-keyed entries (plain baseUrl setups) live on the "" lane.
    const bareRegistry: Record<string, ModelConfig> = {
      solo: entry("solo"),
      "p/strong": entry("p/strong", { maxToolDifficulty: 2 }),
    };
    const peekLoaded = async (provider: string) =>
      provider === "" ? new Set(["solo"]) : new Set<string>();
    const r = await planSpawn({
      registry: bareRegistry,
      requires: { ctx: 65536 },
      peekLoaded,
    });
    // Cache warmth beats difficulty: the loaded bare model wins ("solo".slice(1)
    // would be "olo", which no peek set would ever contain).
    expect(r.ok && r.candidates[0]!.key).toBe("solo");
  });
});

describe("planSpawn: fallback", () => {
  it("fallback used only when no pin/requires", async () => {
    expect(await ok({ registry, fallback: "ai365/small" })).toEqual({
      model: "ai365/small",
      provider: "ai365",
    });
    expect(await ok({ registry, fallback: "bare-model" })).toEqual({
      model: "bare-model",
      provider: "",
    });
  });

  it("nothing at all errors", async () => {
    const r = await planSpawn({ registry });
    expect(!r.ok && r.error).toContain("no model");
  });
});

// ---------------------------------------------------------------------------
// planSpawn: placement plans (copies, groups, noSpread, warm ordering)
// ---------------------------------------------------------------------------

import { parseGroupRef, warmSortCandidates } from "@core/session/model-resolver.ts";

const planOk = async (input: Parameters<typeof planSpawn>[0]) => {
  const p = await planSpawn(input);
  if (!p.ok) throw new Error(`expected ok, got error: ${p.error}`);
  return p;
};

describe("planSpawn: copy expansion", () => {
  const fleet: Record<string, ModelConfig> = {
    "n1/qwen": entry("n1/qwen"),
    "n2/qwen": entry("n2/qwen"),
    "n1/other": entry("n1/other"),
  };

  it("expands a qualified chain winner across providers holding the name", async () => {
    const p = await planOk({ registry: fleet, expand: "n1/qwen", cold: true });
    expect(p.intent).toBe("n1/qwen");
    expect(p.candidates.map((c) => c.key)).toEqual(["n1/qwen", "n2/qwen"]);
    expect(p.candidates.map((c) => c.provider)).toEqual(["n1", "n2"]);
  });

  it("noSpread providers are excluded; the winner's own provider is not", async () => {
    const p = await planOk({
      registry: fleet,
      expand: "n1/qwen",
      cold: true,
      noSpread: new Set(["n2"]),
    });
    expect(p.candidates.map((c) => c.key)).toEqual(["n1/qwen"]);
    const origin = await planOk({
      registry: fleet,
      expand: "n2/qwen",
      cold: true,
      noSpread: new Set(["n2"]),
    });
    expect(origin.candidates.map((c) => c.key).includes("n2/qwen")).toBe(true);
  });

  it("zero copies falls back to a single unvalidated candidate", async () => {
    const p = await planOk({ registry: fleet, expand: "wherever/ghost", cold: true });
    expect(p.candidates).toEqual([{ key: "wherever/ghost", provider: "wherever", member: 0 }]);
  });

  it("pins stay strict even when copies exist", async () => {
    const p = await planOk({ registry: fleet, pin: { model: "n1/qwen" } });
    expect(p.candidates).toEqual([{ key: "n1/qwen", provider: "n1", member: 0 }]);
  });
});

describe("planSpawn: model groups", () => {
  const fleet: Record<string, ModelConfig> = {
    "n1/qwen": entry("n1/qwen"),
    "n2/qwen": entry("n2/qwen"),
    "n1/other": entry("n1/other", { contextLimit: 8192 }),
  };
  const modelGroups = { mid: ["qwen", "n1/other"] };

  it("bare members expand across providers; declaration order survives", async () => {
    const p = await planOk({ registry: fleet, group: "mid", modelGroups, cold: true });
    expect(p.intent).toBe("group:mid");
    expect(p.candidates).toEqual([
      { key: "n1/qwen", provider: "n1", member: 0 },
      { key: "n2/qwen", provider: "n2", member: 0 },
      { key: "n1/other", provider: "n1", member: 1 },
    ]);
  });

  it("warmth outranks member order", async () => {
    const peekLoaded = async (provider: string) =>
      provider === "n1" ? new Set(["other"]) : new Set<string>();
    const p = await planOk({ registry: fleet, group: "mid", modelGroups, peekLoaded });
    expect(p.candidates[0]!.key).toBe("n1/other"); // member 1 but loaded
  });

  it("unknown group errors with the known names", async () => {
    const r = await planSpawn({ registry: fleet, group: "ghost", modelGroups });
    expect(!r.ok && r.error).toContain("unknown model group 'ghost'");
    expect(!r.ok && r.error).toContain("mid");
  });

  it("a missing qualified member is a loud config error", async () => {
    const r = await planSpawn({
      registry: fleet,
      group: "mid",
      modelGroups: { mid: ["qwen", "n9/ghost"] },
    });
    expect(!r.ok && r.error).toContain("member 'n9/ghost' is not in the model catalog");
  });

  it("requires filters members per-catalog-entry (ctx drift caught)", async () => {
    const p = await planSpawn({
      registry: fleet,
      group: "mid",
      modelGroups,
      requires: { ctx: 16384 },
      cold: true,
    });
    // n1/other only carries 8192 ctx: dropped, the qwen copies survive.
    expect(p.ok && p.candidates.map((c) => c.key)).toEqual(["n1/qwen", "n2/qwen"]);
  });

  it("noSpread providers are excluded from bare member expansion", async () => {
    const p = await planOk({
      registry: fleet,
      group: "mid",
      modelGroups,
      cold: true,
      noSpread: new Set(["n2"]),
    });
    expect(p.candidates.map((c) => c.key)).toEqual(["n1/qwen", "n1/other"]);
  });
});

describe("warmSortCandidates", () => {
  it("re-ranks by current cache warmth (late peek beats stale plan order)", async () => {
    const reg = { "n1/q": entry("n1/q"), "n2/q": entry("n2/q") };
    const peekLoaded = async (provider: string) =>
      provider === "n2" ? new Set(["q"]) : new Set<string>();
    const sorted = await warmSortCandidates(
      reg,
      [
        { key: "n1/q", provider: "n1", member: 0 },
        { key: "n2/q", provider: "n2", member: 0 },
      ],
      peekLoaded,
    );
    expect(sorted.map((c) => c.key)).toEqual(["n2/q", "n1/q"]);
  });
});

describe("parseGroupRef", () => {
  it("recognizes the group: prefix form only", () => {
    expect(parseGroupRef("group:mid-level")).toBe("mid-level");
    expect(parseGroupRef("group:")).toBeUndefined();
    expect(parseGroupRef("plain/model")).toBeUndefined();
    expect(parseGroupRef(undefined)).toBeUndefined();
  });
});
