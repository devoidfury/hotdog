// RoleMapping registry + selection (src/core/extensions/role-mapping.ts) and
// the built-in mappings from extensions/role-mapping-default.
//
// Core ships no mapping: the registry is the whole truth, the name comes from
// config, and an unresolvable name is a config error rather than a fallback.
// Without a mapping the serializer throws for any non-empty request, never
// passing a private convention through to the model.

import { describe, it, expect } from "bun:test";
import {
  createRoleMappingRegistry,
  resolveRoleMappingId,
} from "@core/extensions/role-mapping.ts";
import {
  systemFirstRoleMapping,
  developerRoleMapping,
  create as createRoleMappingExtension,
} from "@extensions/role-mapping-default/index.ts";
import { LlmClient } from "@core/llm-client/client.ts";
import { Message } from "@core/context/message.ts";
import type { ModelConfig, ProviderDef } from "@core/config/providers.ts";

function mc(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { name: "prov/model", temperature: null, contextLimit: 128000, tags: [], ...overrides };
}

describe("built-in mappings", () => {
  it("system-first: harness rides user, everything else is itself", () => {
    expect(systemFirstRoleMapping.wireRole("harness")).toBe("user");
    for (const r of ["system", "user", "assistant", "tool"]) {
      expect(systemFirstRoleMapping.wireRole(r)).toBe(r);
    }
  });

  it("developer: harness rides developer, everything else is itself", () => {
    expect(developerRoleMapping.wireRole("harness")).toBe("developer");
    for (const r of ["system", "user", "assistant", "tool"]) {
      expect(developerRoleMapping.wireRole(r)).toBe(r);
    }
  });

  it("the extension registers both under the config's names", () => {
    const registry = createRoleMappingRegistry();
    const core = { roleMappingRegistry: registry } as never;
    createRoleMappingExtension(core);
    expect(registry.names().sort()).toEqual(["developer", "system-first"]);
  });
});

describe("RoleMappingRegistry", () => {
  it("rejects mappings without an id", () => {
    expect(() => createRoleMappingRegistry().register({ ...systemFirstRoleMapping, id: "" })).toThrow(/id/);
  });
});

describe("resolveRoleMappingId (same chain as wireFormat)", () => {
  const providers: ProviderDef[] = [{ name: "prov", models: [], roleMapping: "developer" }];

  it("model-level wins over provider-level", () => {
    expect(
      resolveRoleMappingId({ name: "prov/model", roleMapping: "system-first" }, providers, "developer"),
    ).toBe("system-first");
  });

  it("provider-level applies when the model has none", () => {
    expect(resolveRoleMappingId({ name: "prov/model" }, providers, undefined)).toBe("developer");
  });

  it("nothing configured means NO id, not a core-invented one", () => {
    expect(resolveRoleMappingId({ name: "bare/model" }, undefined, undefined)).toBeUndefined();
  });
});

describe("the wire without a mapping", () => {
  function request(messages: Message[]) {
    const client = new LlmClient({ chatTimeoutSecs: 60, maxRetries: 3, markerMangler: null });
    return client.buildChatRequest(messages, mc(), null, false).messages as Array<{ role: string }>;
  }

  it("throws for ANY message -- the chain ends at core.config, not at a guessed convention", () => {
    expect(() => request([new Message({ role: "user", content: "hi", source: "user" })])).toThrow(
      /No role mapping is active/,
    );
    // Actionable: names the config key and the built-in extension.
    expect(() => request([new Message({ role: "user", content: "hi", source: "user" })])).toThrow(
      /modelRoleMapping/,
    );
    // Empty requests need nothing: there is no role to map.
    expect(request([])).toEqual([]);
  });

  it("a configured-but-unregistered mapping name is a config error naming the id", () => {
    const reg = createRoleMappingRegistry();
    reg.register(systemFirstRoleMapping);
    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 3,
      markerMangler: null,
      roleMapping: "nope",
      roleMappingRegistry: reg,
    });
    expect(() =>
      client.buildChatRequest([new Message({ role: "user", content: "hi", source: "user" })], mc(), null, false),
    ).toThrow(/Unknown role mapping "nope"/);
  });

  it("a configured mapping decides where harness rides", () => {
    const reg = createRoleMappingRegistry();
    reg.register(developerRoleMapping);
    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 3,
      markerMangler: null,
      roleMapping: "developer",
      roleMappingRegistry: reg,
    });
    const [wire] = client
      .buildChatRequest([new Message({ role: "harness", content: "ctx", source: "harness" })], mc(), null, false)
      .messages as Array<{ role: string }>;
    expect(wire!.role).toBe("developer");
  });
});

describe("resolveRoleMapping (tolerant resolver, non-request paths)", () => {
  it("resolves a registered name and returns null -- never throws -- for unresolvable ones", () => {
    const reg = createRoleMappingRegistry();
    reg.register(systemFirstRoleMapping);
    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 3,
      markerMangler: null,
      roleMapping: "system-first",
      roleMappingRegistry: reg,
    });
    expect(client.resolveRoleMapping(mc())?.id).toBe("system-first");
    // Tolerant on purpose: callers outside the request path (compaction, the
    // mangler union) must not throw on a broken or absent config. The strict
    // request path is the one that raises (pinned above).
    const unregistered = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 3,
      markerMangler: null,
      roleMapping: "nope",
      roleMappingRegistry: reg,
    });
    expect(unregistered.resolveRoleMapping(mc())).toBeNull();
    const unset = new LlmClient({ chatTimeoutSecs: 60, maxRetries: 3, markerMangler: null });
    expect(unset.resolveRoleMapping(mc())).toBeNull();
  });
});
