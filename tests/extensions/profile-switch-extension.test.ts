import { describe, it, expect } from "bun:test";
import { create as createProfileSwitchExtension } from "@extensions/profile-switch/index.ts";
import { ACTIONS } from "@core/commands.ts";
import { HookSystem, HOOKS } from "@core/hooks.ts";
import { createCommandRegistry } from "@core/extensions/registries.ts";

const PROFILES: Record<string, unknown> = {
  default: { body: "", model: null, whitelistTools: null, blacklistTools: [] },
  auditor: { body: "audit body", model: "m2", whitelistTools: ["read"], blacklistTools: ["bash"] },
};

function createMockCore(profileManager: unknown = { getProfilesForSwitch: () => PROFILES }) {
  return {
    hooks: new HookSystem(),
    config: {},
    resolved: profileManager ? { profileManager } : {},
  } as any;
}

function createMockAgent() {
  const agent: any = {
    profileName: "default",
    applied: null,
    events: [] as Array<{ type: string; data: Record<string, unknown> }>,
    hookCalls: [] as Array<{ name: string; payload: unknown }>,
    applyProfile(name: string, profile: unknown) {
      agent.profileName = name;
      agent.applied = profile;
    },
    emitOutput(type: string, data: Record<string, unknown>) {
      agent.events.push({ type, data });
    },
    hooks: {
      notifyHooks: async (name: string, payload: unknown) => {
        agent.hookCalls.push({ name, payload });
      },
    },
  };
  return agent;
}

async function register(core = createMockCore()) {
  const ext = createProfileSwitchExtension(core);
  const registry = createCommandRegistry();
  await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry } as any);
  return registry;
}

describe("profile-switch extension", () => {
  it("registers the /profile command", async () => {
    const registry = await register();
    expect(registry.has("profile")).toBe(true);
  });

  it("/profile lists profiles and marks the current one", async () => {
    const registry = await register();
    const agent = createMockAgent();
    const result = await registry.get("profile")!.handler!(agent as any, "profile");

    expect(result.content).toContain("Available profiles:");
    expect(result.content).toContain("default (current)");
    expect(result.content).toContain("auditor");
  });

  it("/profile with no profiles configured says so", async () => {
    const registry = await register(createMockCore({ getProfilesForSwitch: () => ({}) }));
    const result = await registry.get("profile")!.handler!(createMockAgent() as any, "profile");
    expect(result.content).toContain("No profiles configured");
  });

  it("/profile <name> switches profile", async () => {
    const registry = await register();
    const agent = createMockAgent();
    const result = await registry.get("profile")!.handler!(agent as any, "profile auditor");

    expect(result.content).toContain("Switched to profile: auditor");
    expect(agent.profileName).toBe("auditor");
    expect(agent.applied).toBe(PROFILES.auditor);
    expect(agent.events).toEqual([
      { type: "session_state", data: { key: "profile", value: "auditor" } },
    ]);
  });

  it("/profile <name> emits a PROFILE_SWITCH hook with from/to profiles", async () => {
    const registry = await register();
    const agent = createMockAgent();
    const result = await registry.get("profile")!.handler!(agent as any, "profile auditor");

    expect(result.content).toContain("Switched to profile: auditor");
    const hookCalls = (agent as any).hookCalls;
    const switchHook = hookCalls.find((h: any) => h.name === HOOKS.PROFILE_SWITCH);
    expect(switchHook).toBeDefined();
    expect(switchHook.payload.fromProfile).toBe("default");
    expect(switchHook.payload.toProfile).toBe("auditor");
  });

  it("/profile <name> emits PROFILE_SWITCH hook even when switching to the same profile", async () => {
    const registry = await register();
    const agent = createMockAgent();
    const result = await registry.get("profile")!.handler!(agent as any, "profile default");

    expect(result.content).toContain("Switched to profile: default");
    const hookCalls = (agent as any).hookCalls;
    const switchHook = hookCalls.find((h: any) => h.name === HOOKS.PROFILE_SWITCH);
    expect(switchHook).toBeDefined();
    expect(switchHook.payload.fromProfile).toBe("default");
    expect(switchHook.payload.toProfile).toBe("default");
  });

  it("/profile:<name> colon format switches profile", async () => {
    const registry = await register();
    const agent = createMockAgent();
    const result = await registry.get("profile")!.handler!(agent as any, "profile:auditor");

    expect(result.content).toContain("Switched to profile: auditor");
    expect(agent.profileName).toBe("auditor");
  });

  it("unknown profile is an error and does not switch", async () => {
    const registry = await register();
    const agent = createMockAgent();
    const result = await registry.get("profile")!.handler!(agent as any, "profile ghost");

    expect(result.action).toBe(ACTIONS.ERROR);
    expect(result.error).toContain('"ghost" not found');
    expect(agent.profileName).toBe("default");
    expect(agent.applied).toBeNull();
  });

  it("matches exact, space, and colon forms but not lookalikes", async () => {
    const registry = await register();
    const def = registry.get("profile")!;
    expect(def.matches!("profile")).toBe(true);
    expect(def.matches!("profile auditor")).toBe(true);
    expect(def.matches!("profile:auditor")).toBe(true);
    expect(def.matches!("profiles")).toBe(false);
    expect(def.matches!("profiley")).toBe(false);
  });

  it("completion lists profile names filtered by prefix", async () => {
    const registry = await register();
    const completion = registry.get("profile")!.completion!;
    const ctx = { line: "/profile ", cursorPos: 9, command: "profile", commandArg: "", agent: {} } as any;
    expect(completion(ctx)).toEqual([{ value: "default" }, { value: "auditor" }]);
    expect(
      completion({ ...ctx, commandArg: "AUD" }),
    ).toEqual([{ value: "auditor" }]);
  });

  it("works when profileManager is missing (empty list, no crash)", async () => {
    const registry = await register(createMockCore(null));
    const agent = createMockAgent();
    const list = await registry.get("profile")!.handler!(agent as any, "profile");
    expect(list.content).toContain("No profiles configured");
    const switchRes = await registry.get("profile")!.handler!(agent as any, "profile auditor");
    expect(switchRes.action).toBe(ACTIONS.ERROR);
  });
});
