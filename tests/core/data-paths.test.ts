import { describe, it, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir, joinDataDir, sessionsDir } from "@core/session/session-log.ts";

describe("data dir resolution", () => {
  const savedData = process.env.HOTDOG_DATA_DIR;
  const savedSessions = process.env.HOTDOG_SESSIONS_DIR;

  function withEnv(
    data: string | undefined,
    sessions: string | undefined,
    fn: () => void,
  ): void {
    if (data === undefined) delete process.env.HOTDOG_DATA_DIR;
    else process.env.HOTDOG_DATA_DIR = data;
    if (sessions === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
    else process.env.HOTDOG_SESSIONS_DIR = sessions;
    try {
      fn();
    } finally {
      if (savedData === undefined) delete process.env.HOTDOG_DATA_DIR;
      else process.env.HOTDOG_DATA_DIR = savedData;
      if (savedSessions === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
      else process.env.HOTDOG_SESSIONS_DIR = savedSessions;
    }
  }

  it("dataDir uses HOTDOG_DATA_DIR when set", () => {
    withEnv("/tmp/hotdog-data-test", undefined, () => {
      expect(dataDir()).toBe("/tmp/hotdog-data-test");
    });
  });

  it("dataDir defaults to ~/.cache/hotdog", () => {
    withEnv(undefined, undefined, () => {
      expect(dataDir()).toBe(join(homedir(), ".cache", "hotdog"));
    });
  });

  it("sessionsDir is one level inside the data dir", () => {
    withEnv("/tmp/hotdog-data-test", undefined, () => {
      expect(sessionsDir()).toBe("/tmp/hotdog-data-test/sessions");
    });
  });

  it("sessionsDir default is ~/.cache/hotdog/sessions (unchanged from pre-split)", () => {
    withEnv(undefined, undefined, () => {
      expect(sessionsDir()).toBe(join(homedir(), ".cache", "hotdog", "sessions"));
    });
  });

  it("HOTDOG_SESSIONS_DIR wins over HOTDOG_DATA_DIR (narrower override)", () => {
    withEnv("/tmp/hotdog-data-test", "/tmp/hotdog-sessions-test", () => {
      expect(sessionsDir()).toBe("/tmp/hotdog-sessions-test");
      // The narrower override must not move the data dir itself.
      expect(dataDir()).toBe("/tmp/hotdog-data-test");
    });
  });

  it("joinDataDir joins parts onto the data dir", () => {
    withEnv("/tmp/hotdog-data-test", undefined, () => {
      expect(joinDataDir("workflows")).toBe("/tmp/hotdog-data-test/workflows");
      expect(joinDataDir("workflows", "runs")).toBe("/tmp/hotdog-data-test/workflows/runs");
    });
  });
});
