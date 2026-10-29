// The spawn-env provider slot: install/clear ownership, null semantics, and
// the never-fail-open rule (a rejecting provider kills the spawn).

import { describe, it, expect, afterEach } from "bun:test";
import {
  getSpawnEnvProvider,
  isMcpOwnerSession,
  mcpOwnerSession,
  setSpawnEnvProvider,
  spawnEnvFor,
  getHardEgressProvider,
  HARD_EGRESS_PROXY_PORT,
  HARD_EGRESS_PROXY_URL,
  hardEgressFor,
  JAIL_EGRESS_SOCKET,
  setHardEgressProvider,
} from "@utils/spawn-env.ts";
import { ToolError } from "@core/error.ts";

afterEach(() => setSpawnEnvProvider(null));

describe("spawn-env provider slot", () => {
  it("set, get, clear", () => {
    expect(getSpawnEnvProvider()).toBeNull();
    const provider = async () => null;
    setSpawnEnvProvider(provider);
    expect(getSpawnEnvProvider()).toBe(provider);
    setSpawnEnvProvider(null);
    expect(getSpawnEnvProvider()).toBeNull();
  });

  it("spawnEnvFor answers null with no provider and for a null session", async () => {
    expect(await spawnEnvFor("s1")).toBeNull();
    let called = false;
    setSpawnEnvProvider(async () => {
      called = true;
      return { X: "1" };
    });
    // No session means nothing to attribute: never ask, never inject.
    expect(await spawnEnvFor(null)).toBeNull();
    expect(called).toBe(false);
    expect(await spawnEnvFor("s1")).toEqual({ X: "1" });
    expect(called).toBe(true);
  });

  it("a provider rejection is fatal to the spawn (ToolError, never fail-open)", async () => {
    setSpawnEnvProvider(async () => {
      throw new Error("proxy bind refused");
    });
    let err: unknown = null;
    try {
      await spawnEnvFor("s1");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ToolError);
    const msg = (err as Error).message;
    expect(msg).toContain("Spawn refused");
    expect(msg).toContain("proxy bind refused");
    expect(msg).toContain("proxyEnabled");
  });

  it("a non-Error rejection is still a refusal", async () => {
    setSpawnEnvProvider(async () => {
      // eslint-disable-next-line no-throw-literal
      throw "socket table exhausted";
    });
    await expect(spawnEnvFor("s1")).rejects.toThrow(/Spawn refused/);
  });
});

describe("MCP owner ids", () => {
  it("mints and recognizes mcp:<name>", () => {
    expect(mcpOwnerSession("files")).toBe("mcp:files");
    expect(isMcpOwnerSession(mcpOwnerSession("files"))).toBe(true);
    expect(isMcpOwnerSession("3f2b6c1a-0d4e-4a5b-9c8d-7e6f5a4b3c2d")).toBe(false);
    // Only the exact prefix counts; a session id merely containing it does not.
    expect(isMcpOwnerSession("x-mcp:files")).toBe(false);
    expect(isMcpOwnerSession("MCP:files")).toBe(false);
  });
});

describe("hard egress directive slot", () => {
  afterEach(() => setHardEgressProvider(null));

  it("set, get, clear -- independent of the spawn-env slot", () => {
    expect(getHardEgressProvider()).toBeNull();
    const provider = async () => null;
    setHardEgressProvider(provider);
    expect(getHardEgressProvider()).toBe(provider);
    setHardEgressProvider(null);
    expect(getHardEgressProvider()).toBeNull();
  });

  it("hardEgressFor answers null with no provider and for a null session", async () => {
    expect(await hardEgressFor("s1")).toBeNull();
    let called = false;
    setHardEgressProvider(async () => {
      called = true;
      return { socketPath: "/x/s.sock", strict: true };
    });
    expect(await hardEgressFor(null)).toBeNull();
    expect(called).toBe(false);
    expect(await hardEgressFor("s1")).toEqual({ socketPath: "/x/s.sock", strict: true });
  });

  it("a provider rejection is fatal to the spawn (ToolError)", async () => {
    setHardEgressProvider(async () => {
      throw new Error("hardEgress requires the netns shim");
    });
    let err: unknown = null;
    try {
      await hardEgressFor("s1");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toContain("Spawn refused");
    expect((err as Error).message).toContain("hardEgress requires the netns shim");
  });

  it("the jail constants are the shared contract", () => {
    expect(HARD_EGRESS_PROXY_PORT).toBe(18080);
    expect(HARD_EGRESS_PROXY_URL).toBe(`http://127.0.0.1:${HARD_EGRESS_PROXY_PORT}`);
    expect(JAIL_EGRESS_SOCKET.startsWith("/tmp/")).toBe(true);
  });
});
