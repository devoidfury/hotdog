// Tests for config/profiles.js — profile loading and resolution.

import { describe, it, expect, beforeEach } from "bun:test";
import {
  resolveProfilesPath,
  loadProfileFile,
  loadProfileFiles,
  getVisibleWorkerProfiles,
  allProfilesForSwitch,
} from "../../src/core/config/profiles.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("resolveProfilesPath", () => {
  it("resolves CLI profiles path", () => {
    const result = resolveProfilesPath("/cli/path", null, null);
    expect(result).toBe("/cli/path");
  });

  it("resolves config profiles path", () => {
    const result = resolveProfilesPath(null, null, "/config/path");
    expect(result).toBe("/config/path");
  });

  it("resolves from config dir", () => {
    const result = resolveProfilesPath(null, "/config/dir", null);
    expect(result).toBe("/config/dir/profiles");
  });

  it("falls back to default path", () => {
    const result = resolveProfilesPath(null, null, null);
    expect(result).toBe("./config/profiles");
  });

  it("CLI path takes priority over config path", () => {
    const result = resolveProfilesPath("/cli", null, "/config");
    expect(result).toBe("/cli");
  });

  it("CLI path takes priority over config dir", () => {
    const result = resolveProfilesPath("/cli", "/config/dir", null);
    expect(result).toBe("/cli");
  });
});

describe("loadProfileFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-test-"));
  });

  it("loads a profile from a .profile.md file", async () => {
    const content = `---
name: test-profile
role: Test role
model: test-model
blacklist-tools:
  - bash
whitelist-tools:
  - read
  - overwrite
manager: true
visible-worker: true
---
Profile body content here`;

    fs.writeFileSync(path.join(tmpDir, "test-profile.profile.md"), content);

    const profile = await loadProfileFile(tmpDir, "test-profile");

    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("test-profile");
    expect(profile!.role).toBe("Test role");
    expect(profile!.model).toBe("test-model");
    expect(profile!.blacklistTools).toEqual(["bash"]);
    expect(profile!.whitelistTools).toEqual(["read", "overwrite"]);
    expect(profile!.manager).toBe(true);
    expect(profile!.visibleWorker).toBe(true);
    expect(profile!.body).toBe("Profile body content here");
  });

  it("returns null for non-existent profile", async () => {
    const profile = await loadProfileFile(tmpDir, "nonexistent");
    expect(profile).toBeNull();
  });

  it("returns null for invalid front matter", async () => {
    fs.writeFileSync(path.join(tmpDir, "bad.profile.md"), "no front matter here");
    const profile = await loadProfileFile(tmpDir, "bad");
    expect(profile).toBeNull();
  });

  it("uses filename as name when not specified in front matter", async () => {
    const content = `---
role: Some role
---
Body`;
    fs.writeFileSync(path.join(tmpDir, "my-profile.profile.md"), content);

    const profile = await loadProfileFile(tmpDir, "my-profile");
    expect(profile!.name).toBe("my-profile");
    expect(profile!.role).toBe("Some role");
  });

  it("handles snake_case front matter keys", async () => {
    const content = `---
name: snake-profile
blacklist_tools:
  - bash
whitelist_tools:
  - read
visible_worker: true
---
Body`;
    fs.writeFileSync(path.join(tmpDir, "snake-profile.profile.md"), content);

    const profile = await loadProfileFile(tmpDir, "snake-profile");
    expect(profile!.blacklistTools).toEqual(["bash"]);
    expect(profile!.whitelistTools).toEqual(["read"]);
    expect(profile!.visibleWorker).toBe(true);
  });

  it("preserves arbitrary front matter keys", async () => {
    const content = `---
name: custom-profile
custom_field: custom-value
another_field: 123
---
Body`;
    fs.writeFileSync(path.join(tmpDir, "custom-profile.profile.md"), content);

    const profile = await loadProfileFile(tmpDir, "custom-profile");
    expect(profile!.customField).toBe("custom-value");
    expect(profile!.anotherField).toBe(123);
  });

  it("handles empty profile directory", async () => {
    const profile = await loadProfileFile("/nonexistent-dir-12345", "test");
    expect(profile).toBeNull();
  });
});

describe("loadProfileFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-test-"));
  });

  it("loads all .profile.md files from directory", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "profile-a.profile.md"),
      `---
name: profile-a
role: Role A
---
Body A`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "profile-b.profile.md"),
      `---
name: profile-b
role: Role B
---
Body B`,
    );

    const profiles = await loadProfileFiles(tmpDir);

    expect(Object.keys(profiles)).toHaveLength(2);
    expect(profiles["profile-a"]!.role).toBe("Role A");
    expect(profiles["profile-b"]!.role).toBe("Role B");
  });

  it("ignores non-.profile.md files", async () => {
    fs.writeFileSync(path.join(tmpDir, "readme.md"), "Not a profile");
    fs.writeFileSync(path.join(tmpDir, "data.json"), "{}");

    const profiles = await loadProfileFiles(tmpDir);
    expect(Object.keys(profiles)).toHaveLength(0);
  });

  it("returns empty object for non-existent directory", async () => {
    const profiles = await loadProfileFiles("/nonexistent-dir-12345");
    expect(profiles).toEqual({});
  });

  it("skips files with invalid content", async () => {
    fs.writeFileSync(path.join(tmpDir, "valid.profile.md"), `---\nname: valid\n---\nBody`);
    fs.writeFileSync(path.join(tmpDir, "invalid.profile.md"), "invalid content");

    const profiles = await loadProfileFiles(tmpDir);
    expect(Object.keys(profiles)).toHaveLength(1);
    expect(profiles["valid"]).toBeDefined();
  });

  it("includes description in loaded profiles", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "described.profile.md"),
      `---
name: described
description: A described profile
role: Role
---
Body`,
    );

    const profiles = await loadProfileFiles(tmpDir);
    expect(profiles["described"]!.description).toBe("A described profile");
  });
});

describe("getVisibleWorkerProfiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-test-"));
  });

  it("returns profiles with visibleWorker: true", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "visible.profile.md"),
      `---
name: visible
visible-worker: true
---
Body`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "hidden.profile.md"),
      `---
name: hidden
visible-worker: false
---
Body`,
    );

    const profiles = await getVisibleWorkerProfiles(tmpDir);
    expect(profiles).toEqual(["visible"]);
  });

  it("returns empty array when no visible workers", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "hidden.profile.md"),
      `---
name: hidden
---
Body`,
    );

    const profiles = await getVisibleWorkerProfiles(tmpDir);
    expect(profiles).toEqual([]);
  });

  it("returns empty array for non-existent directory", async () => {
    const profiles = await getVisibleWorkerProfiles("/nonexistent-dir-12345");
    expect(profiles).toEqual([]);
  });
});

describe("allProfilesForSwitch", () => {
  it("merges file and config profiles", () => {
    const fileProfiles = {
      file1: { role: "file role", body: "file body" },
    };
    const configProfiles = {
      config1: { role: "config role" },
    };

    const result = allProfilesForSwitch({
      profileFiles: fileProfiles,
      configProfiles,
    });

    expect(Object.keys(result)).toHaveLength(2);
    expect(result["file1"]!.role).toBe("file role");
    expect(result["config1"]!.role).toBe("config role");
  });

  it("file profile role wins over config role", () => {
    const fileProfiles = {
      shared: { role: "file role", body: "file body" },
    };
    const configProfiles = {
      shared: { role: "config role" },
    };

    const result = allProfilesForSwitch({
      profileFiles: fileProfiles,
      configProfiles,
    });

    expect(result["shared"]!.role).toBe("file role");
  });

  it("handles empty inputs", () => {
    const result = allProfilesForSwitch({});
    expect(result).toEqual({});
  });

  it("handles null inputs", () => {
    const result = allProfilesForSwitch({
      profileFiles: null,
      configProfiles: null,
    });
    expect(result).toEqual({});
  });

  it("includes model from config profile", () => {
    const configProfiles = {
      withModel: { role: "role", model: "gpt-4" },
    };

    const result = allProfilesForSwitch({
      profileFiles: {},
      configProfiles,
    });

    expect(result["withModel"]!.model).toBe("gpt-4");
  });
});
