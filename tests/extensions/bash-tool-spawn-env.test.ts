// The policy env lane into agent-spawned shells: agentSpawnEnv merge order
// (policy LAST, over the scrubbed base and over bashTool.env) and the
// ctx.get("spawnEnv") read in BashTool.execute. The executor-side resolution
// lives in tool-exec-plane.test.ts; the provider slot in spawn-env.test.ts.

import { describe, it, expect } from "bun:test";
import { agentSpawnEnv, BashTool } from "@extensions/bash-tool/index.ts";
import { ToolContext } from "@core/extensions/tool-context.ts";
import { resultStr } from "../helpers.ts";

const POLICY = {
  HTTP_PROXY: "http://s1:tok@127.0.0.1:5999",
  HTTPS_PROXY: "http://s1:tok@127.0.0.1:5999",
  NO_PROXY: "127.0.0.1,localhost,::1",
};

describe("agentSpawnEnv merge order", () => {
  it("policy env beats the user's bashTool.env vars", () => {
    const env = agentSpawnEnv(
      undefined,
      { HTTP_PROXY: "http://user-config:3128" },
      true,
      POLICY,
    );
    expect(env.HTTP_PROXY).toBe(POLICY.HTTP_PROXY);
  });

  it("policy env beats a surviving base-env value", () => {
    // Not a secret-shaped name, so the scrub keeps the base copy -- the
    // policy must still win over it.
    process.env.POLICY_MERGE_PROBE = "from-host-env";
    try {
      const base = agentSpawnEnv(undefined, undefined, true, null);
      expect(base.POLICY_MERGE_PROBE).toBe("from-host-env");
      const merged = agentSpawnEnv(undefined, { POLICY_MERGE_PROBE: "from-bash-tool" }, true, {
        POLICY_MERGE_PROBE: "from-policy",
      });
      expect(merged.POLICY_MERGE_PROBE).toBe("from-policy");
    } finally {
      delete process.env.POLICY_MERGE_PROBE;
    }
  });

  it("no policy env changes nothing", () => {
    const env = agentSpawnEnv(undefined, { FOO: "bar" }, true, null);
    expect(env.FOO).toBe("bar");
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
  });

  it("the env scrubber never eats the proxy keys it would inject", () => {
    // Injection lands post-scrub, but a scrub pattern matching *_PROXY would
    // also evict the operator's own proxy config; assert none does.
    const env = agentSpawnEnv(undefined, POLICY, true, null);
    expect(env.HTTP_PROXY).toBe(POLICY.HTTP_PROXY);
    expect(env.NO_PROXY).toBe(POLICY.NO_PROXY);
  });
});

describe("BashTool.execute spawn env", () => {
  it("injects the policy env the executor mounted on the context", async () => {
    const tool = new BashTool({ timeoutMs: 15000, maxOutputLines: 100 });
    const ctx = new ToolContext();
    ctx.set("spawnEnv", POLICY);
    const result = await tool.execute(JSON.stringify({ command: "printenv HTTP_PROXY NO_PROXY" }), ctx);
    const out = resultStr(result);
    expect(out).toContain(POLICY.HTTP_PROXY);
    expect(out).toContain(POLICY.NO_PROXY);
  });

  it("the policy wins over bashTool.env for the same key", async () => {
    const tool = new BashTool({
      timeoutMs: 15000,
      maxOutputLines: 100,
      env: { HTTP_PROXY: "http://user-config:3128" },
    });
    const ctx = new ToolContext();
    ctx.set("spawnEnv", POLICY);
    const result = await tool.execute(JSON.stringify({ command: "printenv HTTP_PROXY" }), ctx);
    expect(resultStr(result).trim()).toBe(POLICY.HTTP_PROXY);
  });

  it("without policy env the child keeps today's posture (nothing injected)", async () => {
    // Robust either way: hotdog must ADD nothing, so the child's proxy keys
    // must be exactly whatever the host already had (pass-through is the
    // operator's own doing, not injection).
    const tool = new BashTool({ timeoutMs: 15000, maxOutputLines: 100 });
    const probe =
      'bun -e "console.log(JSON.stringify({h: process.env.HTTP_PROXY ?? null, n: process.env.NO_PROXY ?? null}))"';
    const out = resultStr(await tool.execute(JSON.stringify({ command: probe }), {} as never));
    const seen = JSON.parse(out.trim());
    expect(seen.h).toBe(process.env.HTTP_PROXY ?? null);
    expect(seen.n).toBe(process.env.NO_PROXY ?? null);
  });
});
