// Tests for config/profiles.ts — the ProfileManager class:
// create/load/reload, getProfile merge semantics, getAllProfiles,
// getProfilesForAgent.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ProfileManager, type ProfileDef } from "../../src/core/config/profiles.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function cfgProfile(overrides: Partial<ProfileDef> = {}): ProfileDef {
  return {
    name: "",
    description: "",
    role: null,
    body: "",
    model: null,
    blacklistTools: [],
    whitelistTools: null,
    manager: false,
    visibleWorker: false,
    ...overrides,
  };
}

describe("ProfileManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-mgr-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeProfile(fileName: string, frontMatter: string, body = "Body") {
    fs.writeFileSync(
      path.join(tmpDir, `${fileName}.profile.md`),
      `---\n${frontMatter}\n---\n${body}`,
    );
  }

  describe("create / load / reload", () => {
    it("create() loads profiles from disk", async () => {
      writeProfile("alpha", "role: Alpha role\ndescription: alpha desc", "alpha body");

      const manager = await ProfileManager.create(tmpDir);

      expect(manager.getAllNames()).toEqual(["alpha"]);
      const p = manager.getProfile("alpha");
      expect(p).not.toBeNull();
      expect(p!.role).toBe("Alpha role");
      expect(p!.description).toBe("alpha desc");
      expect(p!.body).toBe("alpha body");
    });

    it("load() picks up files added after construction", async () => {
      const manager = new ProfileManager(tmpDir);
      expect(manager.getAllNames()).toEqual([]);

      writeProfile("beta", "role: Beta role");
      await manager.load();

      expect(manager.getAllNames()).toEqual(["beta"]);
    });

    it("reload() replaces stale state: deletions and edits", async () => {
      writeProfile("gamma", "description: v1");
      const manager = await ProfileManager.create(tmpDir);
      expect(manager.getProfile("gamma")!.description).toBe("v1");

      fs.rmSync(path.join(tmpDir, "gamma.profile.md"));
      writeProfile("delta", "description: v2");
      await manager.reload();

      expect(manager.getAllNames()).toEqual(["delta"]);
      expect(manager.getProfile("gamma")).toBeNull();
      expect(manager.getProfile("delta")!.description).toBe("v2");
    });

    it("treats a non-existent profiles directory as empty", async () => {
      const manager = await ProfileManager.create("/nonexistent-dir-12345");
      expect(manager.getAllNames()).toEqual([]);
    });
  });

  describe("getProfile merge", () => {
    it("returns null for unknown names", () => {
      const manager = new ProfileManager(tmpDir);
      expect(manager.getProfile("nope")).toBeNull();
    });

    it("serves config-only profiles with their config fields", () => {
      const manager = new ProfileManager(tmpDir, {
        cfg: cfgProfile({
          description: "cfg desc",
          role: "cfg role",
          model: "cfg-model",
          blacklistTools: ["bash"],
        }),
      });

      const p = manager.getProfile("cfg");
      expect(p).not.toBeNull();
      expect(p!.role).toBe("cfg role");
      expect(p!.description).toBe("cfg desc");
      expect(p!.model).toBe("cfg-model");
      expect(p!.blacklistTools).toEqual(["bash"]);
      expect(p!.whitelistTools).toBeNull();
    });

    it("file profiles override config profiles of the same name", async () => {
      writeProfile("both", "role: file role\ndescription: file desc\nmodel: file-model", "file body");

      const manager = await ProfileManager.create(tmpDir, {
        both: cfgProfile({ role: "cfg role", description: "cfg desc", model: "cfg-model" }),
        other: cfgProfile({ description: "other cfg" }),
      });

      const p = manager.getProfile("both");
      expect(p!.role).toBe("file role");
      expect(p!.description).toBe("file desc");
      expect(p!.model).toBe("file-model");
      expect(p!.body).toBe("file body");

      // Names are the union; the config-only entry is still reachable.
      expect(manager.getProfile("other")!.description).toBe("other cfg");
      expect(manager.getAllNames()).toEqual(["both", "other"]);
    });
  });

  describe("getAllProfiles", () => {
    it("returns merged entries for the union of file and config names, sorted", async () => {
      writeProfile("one", "role: file one");
      const manager = await ProfileManager.create(tmpDir, {
        two: cfgProfile({ role: "cfg two" }),
      });

      const all = manager.getAllProfiles();
      expect(Object.keys(all)).toEqual(["one", "two"]);
      expect(all["one"].role).toBe("file one");
      expect(all["two"].role).toBe("cfg two");
      expect(all["one"].name).toBe("one");
    });
  });

  describe("getProfilesForAgent", () => {
    it("includes only file profiles marked visible-worker, merged with config", async () => {
      writeProfile("worker", "role: Worker role\nvisible-worker: true", "worker body");
      writeProfile("plain", "role: Plain role");

      const manager = await ProfileManager.create(tmpDir, {
        worker: cfgProfile({ model: "task-model", whitelistTools: ["read"] }),
        // visibleWorker in a config profile alone does NOT qualify it:
        // the scan is over file profiles only.
        cfgonly: cfgProfile({ role: "cfg only", visibleWorker: true }),
      });

      const forAgent = manager.getProfilesForAgent();
      expect(Object.keys(forAgent)).toEqual(["worker"]);
      expect(forAgent["worker"].role).toBe("Worker role");
      expect(forAgent["worker"].body).toBe("worker body");
      // resolveSwitchProfile: model comes from the config layer; the file
      // side contributes no whitelist, so the config whitelist applies.
      expect(forAgent["worker"].model).toBe("task-model");
      expect(forAgent["worker"].whitelistTools).toEqual(["read"]);
      expect(forAgent["worker"].blacklistTools).toEqual([]);
    });
  });
});
