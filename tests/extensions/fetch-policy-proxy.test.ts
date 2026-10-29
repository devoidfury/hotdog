// Policy proxy: the child-process enforcement point. curl proves the
// forwarded http form end to end (auth, ask prompts, policy deny before any
// dial); raw sockets prove the CONNECT handshake shape (407 challenge, 403
// bad token, 403 deny, ask timeout) without touching the network.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import net from "node:net";
import { HookSystem, HOOKS } from "@core/hooks.ts";
import type { CoreContext, ExtensionInstance } from "@core/extensions/types.ts";
import { getSpawnEnvProvider } from "@utils/spawn-env.ts";
import { create, PROXY_NO_PROXY } from "@extensions/fetch-policy/index.ts";

let server: ReturnType<typeof Bun.serve> | null = null;
let origin = "";
let hits = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      hits++;
      return new Response("server body", { headers: { "Content-Type": "text/plain" } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop();
});

interface ProxyInstance extends ExtensionInstance {
  getProxyEnv(sessionId: string): Promise<Record<string, string> | null>;
}

const started: ProxyInstance[] = [];

function wire(
  cfg: Record<string, unknown>,
  liveInput?: { isInteractive: () => boolean; collectAnswers: (qs: unknown[], s?: AbortSignal | null) => unknown },
  liveSessionId = "s1",
): ProxyInstance {
  const core = { hooks: new HookSystem(), config: { fetchPolicy: cfg }, resolved: {} } as unknown as CoreContext;
  const instance = create(core) as ProxyInstance;
  if (liveInput) {
    const ctxHook = (instance.hooks as Record<string, (p: unknown) => void>)[HOOKS.AGENT_TOOL_CONTEXT];
    expect(ctxHook).toBeFunction();
    ctxHook!({
      toolCtx: { get: (k: string) => (k === "input" ? liveInput : undefined) },
      toolName: "bash",
      agent: { sessionId: liveSessionId },
    });
  }
  started.push(instance);
  return instance;
}

function proxyUrl(env: Record<string, string> | null): URL {
  expect(env).not.toBeNull();
  return new URL(env!["HTTP_PROXY"]!);
}

afterAll(async () => {
  for (const instance of started) await instance.shutdown?.();
});

function answerWith(...answers: string[]) {
  const asked: string[] = [];
  let n = 0;
  return {
    asked,
    input: {
      isInteractive: () => true,
      collectAnswers: (qs: unknown[]) => {
        asked.push(String((qs[0] as Record<string, unknown>)?.prompt ?? ""));
        return { approve: answers[Math.min(n++, answers.length - 1)] ?? "deny" };
      },
    },
  };
}

async function curl(proxyUrl: string, url: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["curl", "-sS", "-x", proxyUrl, "-w", "%{http_code}", url], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, // no NO_PROXY interference
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, out: out + err };
}

const b64 = (user: string, pass: string) => Buffer.from(`${user}:${pass}`).toString("base64");

/** Raw CONNECT handshake; resolves with the reply head. Never dials on 4xx. */
function rawConnect(
  port: number,
  auth: string | null,
  authority = "blocked.example:443",
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: Basic ${auth}\r\n` : ""}\r\n`,
      );
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\r\n\r\n")) {
        sock.destroy();
        resolve(buf);
      }
    });
    sock.on("error", reject);
    setTimeout(() => {
      sock.destroy();
      reject(new Error("no proxy reply"));
    }, 3000);
  });
}

describe("policy proxy", () => {
  it("hands out loopback proxy env with per-session credentials", async () => {
    const instance = wire({});
    const env = await instance.getProxyEnv("s1");
    expect(env).not.toBeNull();
    const url = proxyUrl(env);
    expect(url.protocol).toBe("http:");
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.username).toBe("s1");
    expect(url.password.length).toBeGreaterThan(20);
    expect(env!.NO_PROXY).toBe(PROXY_NO_PROXY);
    expect(env!.http_proxy).toBe(env!["HTTPS_PROXY"]!); // lowercase twins for old tools
    // Token is stable per session, distinct across sessions.
    const env2 = await instance.getProxyEnv("s1");
    const envOther = await instance.getProxyEnv("s2");
    expect(env2!["HTTP_PROXY"]!).toBe(env!["HTTPS_PROXY"]!);
    expect(proxyUrl(envOther).password).not.toBe(url.password);
  });

  it("returns null env when the proxy is disabled", async () => {
    const instance = wire({ proxyEnabled: false });
    expect(await instance.getProxyEnv("s1")).toBeNull();
  });

  it("curl forwards after an ask, through the shared prompt queue", async () => {
    const { input, asked } = answerWith("allow once");
    const instance = wire({ default: "ask" }, input);
    const env = (await instance.getProxyEnv("s1"))!;
    const r1 = await curl(env["HTTP_PROXY"]!, `${origin}/one`);
    expect(r1.out).toContain("server body200");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("child-process");
    expect(asked[0]).toContain(origin);
    const r2 = await curl(env["HTTP_PROXY"]!, `${origin}/two`);
    expect(r2.out).toContain("server body200");
    expect(asked).toHaveLength(2); // "once" means once, proxy included
  });

  it("allows proxied origins the config names without asking", async () => {
    const { input, asked } = answerWith("deny");
    const instance = wire({ default: "ask", allow: [origin] }, input);
    const env = (await instance.getProxyEnv("s1"))!;
    const r = await curl(env["HTTP_PROXY"]!, `${origin}/ok`);
    expect(r.out).toContain("server body200");
    expect(asked).toHaveLength(0);
  });

  it("session grants are shared with the proxy (same memo)", async () => {
    const { input, asked } = answerWith("allow origin for session");
    const instance = wire({ default: "ask" }, input);
    const env = (await instance.getProxyEnv("s1"))!;
    await curl(env["HTTP_PROXY"]!, `${origin}/first`);
    expect(asked).toHaveLength(1);
    const r = await curl(env["HTTP_PROXY"]!, `${origin}/second`); // memo, no prompt
    expect(r.out).toContain("server body200");
    expect(asked).toHaveLength(1);
  });

  it("challenges an unauthenticated CONNECT with 407, denies a bad token with 403", async () => {
    const instance = wire({ default: "allow" });
    const env = (await instance.getProxyEnv("s1"))!;
    const port = Number(proxyUrl(env).port);

    const noAuth = await rawConnect(port, null);
    expect(noAuth).toContain("407");
    expect(noAuth.toLowerCase()).toContain("proxy-authenticate: basic");

    const token = proxyUrl(env).password;
    const badPass = await rawConnect(port, b64("s1", token.slice(0, -2) + "xx"));
    expect(badPass).toContain("403");
    const badUser = await rawConnect(port, b64("s2", token));
    expect(badUser).toContain("403");
  });

  it("denies a CONNECT to a denied origin without dialing", async () => {
    const instance = wire({ default: "allow", deny: ["https://blocked.example"] });
    const env = (await instance.getProxyEnv("s1"))!;
    const port = Number(proxyUrl(env).port);
    const reply = await rawConnect(port, b64("s1", proxyUrl(env).password));
    expect(reply).toContain("403");
  });

  it("an ask with no live context fails closed at the proxy", async () => {
    // token issued for "s1" but no AGENT_TOOL_CONTEXT captured for it.
    const instance = wire({ default: "ask" });
    const env = (await instance.getProxyEnv("s1"))!;
    const port = Number(proxyUrl(env).port);
    const reply = await rawConnect(port, b64("s1", proxyUrl(env).password));
    expect(reply).toContain("403"); // nobody to ask -> deny, never a hole
  });

  it("an unanswered proxy ask times out to deny", async () => {
    const instance = wire(
      { default: "ask", proxyAskTimeoutMs: 150 },
      { isInteractive: () => true, collectAnswers: () => new Promise(() => {}) }, // never answers
    );
    const env = (await instance.getProxyEnv("s1"))!;
    const port = Number(proxyUrl(env).port);
    const t0 = Date.now();
    const reply = await rawConnect(port, b64("s1", proxyUrl(env).password));
    const waited = Date.now() - t0;
    expect(reply).toContain("403");
    expect(waited).toBeGreaterThanOrEqual(140);
  });
});

describe("spawn-env provider registration", () => {
  it("create installs, shutdown clears", async () => {
    const instance = wire({});
    const installed = getSpawnEnvProvider();
    expect(installed).toBeFunction();
    // The installed provider is the policy env answer, and it accepts MCP
    // owner ids too (stdio servers have no session of their own).
    const env = await installed!("mcp:files");
    expect(env).not.toBeNull();
    expect(new URL(env!["HTTP_PROXY"]!).username).toMatch(/^sid-/); // ':' got hashed
    await instance.shutdown!();
    expect(getSpawnEnvProvider()).toBeNull();
  });

  it("shutdown clears only its own registration", async () => {
    const a = wire({});
    const b = wire({});
    const mineB = getSpawnEnvProvider();
    await a.shutdown!(); // a was displaced by b: must not clear b's slot
    expect(getSpawnEnvProvider()).toBe(mineB);
    await b.shutdown!();
    expect(getSpawnEnvProvider()).toBeNull();
  });

  it("an mcp-attributed child prompts through the last live session", async () => {
    const { input, asked } = answerWith("allow once");
    const instance = wire({ default: "ask" }, input, "s-live");
    const env = (await instance.getProxyEnv("mcp:files"))!;
    const r = await curl(env["HTTP_PROXY"]!, `${origin}/mcp-ask`);
    expect(r.out).toContain("server body200");
    expect(asked).toHaveLength(1);
    // The prompt names the CHILD's attribution, not the hosting session.
    expect(asked[0]).toContain("mcp:files");
  });

  it("an mcp-attributed ask fails closed when no session is live", async () => {
    const instance = wire({ default: "ask" }); // no live input captured
    const env = (await instance.getProxyEnv("mcp:files"))!;
    const url = proxyUrl(env);
    const reply = await rawConnect(Number(url.port), b64(url.username, url.password));
    expect(reply).toContain("403");
  });
});
