// fetch-policy extension: the gate attached to the fetch tool, and the ask
// flow behind it. Two local servers stand in for two origins (distinct
// ports); a hit counter proves denials never touch the network, and a
// cross-port redirect proves the per-hop re-check. The prompt seam
// (toolCtx "input") is faked at its natural boundary -- no UI, no network
// beyond localhost.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookSystem, HOOKS } from "@core/hooks.ts";
import type { CoreContext, ToolContext, ToolsRegisterPayload } from "@core/extensions/types.ts";
import { FetchTool } from "@extensions/fetch-tool/index.ts";
import { create } from "@extensions/fetch-policy/index.ts";
import { getDisplay } from "../helpers.ts";

let serverA: ReturnType<typeof Bun.serve> | null = null;
let serverB: ReturnType<typeof Bun.serve> | null = null;
let originA = "";
let originB = "";
const hits = { a: 0, b: 0 };

function makeServer(which: "a" | "b"): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      hits[which]++;
      const url = new URL(req.url);
      if (which === "a" && url.pathname === "/to-b") {
        return new Response(null, { status: 302, headers: { Location: `${originB}/ok` } });
      }
      return new Response(`${which} body`, { headers: { "Content-Type": "text/plain" } });
    },
  });
}

beforeAll(() => {
  serverA = makeServer("a");
  serverB = makeServer("b");
  originA = `http://127.0.0.1:${serverA.port}`;
  originB = `http://127.0.0.1:${serverB.port}`;
});

afterAll(() => {
  serverA?.stop();
  serverB?.stop();
});

function wire(
  cfg: Record<string, unknown>,
  opts: { configDir?: string; allowPrivateHosts?: boolean } = {},
) {
  const tool = new FetchTool({
    timeoutMs: 5000,
    maxBodyLength: 8000,
    maxImageSize: 1048576,
    allowedSchemes: ["http", "https"],
    allowPrivateHosts: opts.allowPrivateHosts ?? true,
  });
  const core = {
    hooks: new HookSystem(),
    config: { fetchPolicy: cfg },
    resolved: opts.configDir ? { configDir: opts.configDir } : {},
  } as unknown as CoreContext;
  const instance = create(core);
  const register = (instance.hooks as Record<string, (p: ToolsRegisterPayload) => void> | undefined)?.[
    HOOKS.TOOLS_REGISTER
  ];
  if (register) register({ register: () => {}, getAll: () => [["fetch", tool]] });
  return { tool, instance };
}

interface FakeInput {
  isInteractive: () => boolean;
  collectAnswers: (
    qs: Record<string, unknown>[],
    signal?: AbortSignal | null,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

function answerWith(...answers: string[]): { input: FakeInput; asked: string[] } {
  const asked: string[] = [];
  let n = 0;
  return {
    asked,
    input: {
      isInteractive: () => true,
      collectAnswers: (qs) => {
        asked.push(String(qs[0]?.prompt ?? ""));
        const answer = answers[Math.min(n++, answers.length - 1)] ?? "deny";
        return { approve: answer };
      },
    },
  };
}

function fakeCtx(
  opts: { input?: FakeInput; sessionId?: string; signal?: AbortSignal } = {},
): ToolContext {
  const store: Record<string, unknown> = {};
  if (opts.input !== undefined) store.input = opts.input;
  if (opts.sessionId !== undefined) store.agent = { sessionId: opts.sessionId };
  if (opts.signal !== undefined) store.abortSignal = opts.signal;
  return { get: (k: string) => store[k] } as unknown as ToolContext;
}

describe("fetch-policy gate", () => {
  it("attaches nothing when disabled", async () => {
    const { tool } = wire({ enabled: false });
    expect(tool.originGate).toBeNull();
    const result = await tool.execute(JSON.stringify({ url: `${originA}/ok` }));
    expect(getDisplay(result)).toContain("a body");
  });

  it("denies with no interactive UI, with the persist hint and no network hit", async () => {
    const before = hits.a;
    const { tool } = wire({ default: "ask" });
    const result = await tool.execute(JSON.stringify({ url: `${originA}/ok` }));
    const text = getDisplay(result);
    expect(text).toContain("Fetch blocked");
    expect(text).toContain(originA);
    expect(text).toContain('"fetchPolicy": { "allow": [');
    expect(text).toContain("no interactive UI");
    expect(hits.a).toBe(before);
  });

  it("allows origins the config names", async () => {
    const { tool } = wire({ default: "ask", allow: [originA] });
    const result = await tool.execute(JSON.stringify({ url: `${originA}/ok` }));
    expect(getDisplay(result)).toContain("a body");
  });

  it("deny beats allow and never touches the network", async () => {
    const before = hits.b;
    const { tool } = wire({ allow: [originB], deny: [`http://127.0.0.1:*`] });
    const result = await tool.execute(JSON.stringify({ url: `${originB}/ok` }));
    const text = getDisplay(result);
    expect(text).toContain("Fetch blocked");
    expect(text).toContain("deny rule");
    expect(text).toContain("cannot be overridden");
    expect(hits.b).toBe(before);
  });

  it("merges persisted approvals from the state file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fetch-policy-ext-"));
    writeFileSync(
      join(dir, "fetch-policy.json"),
      JSON.stringify({ version: 1, allow: [{ origin: originA, addedAt: "2026-10-29T00:00:00.000Z" }] }),
    );
    const { tool } = wire({ default: "ask" }, { configDir: dir });
    const result = await tool.execute(JSON.stringify({ url: `${originA}/ok` }));
    expect(getDisplay(result)).toContain("a body");
  });

  it("a malformed rule blocks every fetch with the reason", async () => {
    const { tool } = wire({ default: "ask", allow: ["nonsense-with-paths/x"] });
    const result = await tool.execute(JSON.stringify({ url: `${originA}/ok` }));
    expect(getDisplay(result)).toContain("config is invalid");
  });

  describe("redirect hops re-pass policy", () => {
    it("blocks a redirect to an origin the policy does not cover", async () => {
      const before = hits.b;
      const { tool } = wire({ default: "allow", deny: [`${originB}`] });
      const result = await tool.execute(JSON.stringify({ url: `${originA}/to-b` }));
      const text = getDisplay(result);
      expect(text).toContain("Fetch blocked");
      expect(text).toContain(originB);
      expect(hits.b).toBe(before);
    });

    it("follows when both origins are allowed", async () => {
      const { tool } = wire({ default: "allow" });
      const result = await tool.execute(JSON.stringify({ url: `${originA}/to-b` }));
      expect(getDisplay(result)).toContain("b body");
    });

    it("hop checks run even with allowPrivateHosts on (policy demands manual following)", async () => {
      const before = hits.b;
      const { tool } = wire({ default: "allow", deny: [originB] }, { allowPrivateHosts: true });
      const result = await tool.execute(JSON.stringify({ url: `${originA}/to-b` }));
      expect(getDisplay(result)).toContain("Fetch blocked");
      expect(hits.b).toBe(before);
    });
  });
});

describe("fetch-policy ask flow", () => {
  it("'allow once' prompts with the url, origin and hint; next call prompts again", async () => {
    const { input, asked } = answerWith("allow once");
    const { tool } = wire({ default: "ask" });
    const ctx = fakeCtx({ input, sessionId: "s1" });
    const r1 = await tool.execute(JSON.stringify({ url: `${originA}/ok?x=1` }), ctx);
    expect(getDisplay(r1)).toContain("a body");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`${originA}/ok?x=1`);
    expect(asked[0]).toContain(originA);
    expect(asked[0]).toContain('"fetchPolicy": { "allow": [');
    const r2 = await tool.execute(JSON.stringify({ url: `${originA}/ok?x=2` }), ctx);
    expect(getDisplay(r2)).toContain("a body");
    expect(asked).toHaveLength(2); // once means once
  });

  it("'allow origin for session' is memoized per session", async () => {
    const { input, asked } = answerWith("allow origin for session");
    const { tool } = wire({ default: "ask" });
    const ctx = fakeCtx({ input, sessionId: "s1" });
    expect(getDisplay(await tool.execute(JSON.stringify({ url: `${originA}/ok` }), ctx))).toContain("a body");
    expect(getDisplay(await tool.execute(JSON.stringify({ url: `${originA}/other` }), ctx))).toContain("a body");
    expect(asked).toHaveLength(1);
    // A different session must not inherit the grant.
    expect(getDisplay(await tool.execute(JSON.stringify({ url: `${originA}/ok` }), fakeCtx({ input, sessionId: "s2" })))).toContain(
      "a body",
    );
    expect(asked).toHaveLength(2);
  });

  it("grants die on session end", async () => {
    const { input, asked } = answerWith("allow origin for session");
    const { tool, instance } = wire({ default: "ask" });
    const ctx = fakeCtx({ input, sessionId: "s1" });
    await tool.execute(JSON.stringify({ url: `${originA}/ok` }), ctx);
    const sessionEnd = (instance.hooks as Record<string, (p: { sessionId: string }) => void>)[
      HOOKS.SESSION_END
    ];
    expect(sessionEnd).toBeFunction();
    sessionEnd!({ sessionId: "s1" });
    await tool.execute(JSON.stringify({ url: `${originA}/ok` }), ctx);
    expect(asked).toHaveLength(2);
  });

  it("'always allow' writes the state file and survives an extension rebuild", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fetch-policy-persist-"));
    const { input, asked } = answerWith("always allow (persist)");
    const { tool } = wire({ default: "ask" }, { configDir: dir });
    const ctx = fakeCtx({ input, sessionId: "s1" });
    expect(getDisplay(await tool.execute(JSON.stringify({ url: `${originA}/ok` }), ctx))).toContain("a body");
    expect(asked).toHaveLength(1);

    const saved = JSON.parse(readFileSync(join(dir, "fetch-policy.json"), "utf-8"));
    expect(saved.version).toBe(1);
    expect(saved.allow[0].origin).toBe(originA);
    expect(saved.allow[0].note).toBe("approved in prompt");

    // Fresh extension over the same dir: the origin is allowed with no prompt.
    const { input: input2, asked: asked2 } = answerWith("deny");
    const { tool: tool2 } = wire({ default: "ask" }, { configDir: dir });
    expect(
      getDisplay(await tool2.execute(JSON.stringify({ url: `${originA}/ok` }), fakeCtx({ input: input2, sessionId: "s9" }))),
    ).toContain("a body");
    expect(asked2).toHaveLength(0);
  });

  it("a lost persist write does not revoke the session grant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fetch-policy-fail-"));
    // A DIRECTORY at the state file path: the append's rename hits EISDIR
    // (even as root), exactly the shape of a disk that cannot take the write.
    mkdirSync(join(dir, "fetch-policy.json"));
    const { input } = answerWith("always allow (persist)");
    const { tool } = wire({ default: "ask" }, { configDir: dir });
    const ctx = fakeCtx({ input, sessionId: "s1" });
    expect(getDisplay(await tool.execute(JSON.stringify({ url: `${originA}/ok` }), ctx))).toContain("a body");
  });

  it("a deny answer blocks with the reason and the hint", async () => {
    const before = hits.a;
    const { input } = answerWith("deny");
    const { tool } = wire({ default: "ask" });
    const ctx = fakeCtx({ input, sessionId: "s1" });
    const text = getDisplay(await tool.execute(JSON.stringify({ url: `${originA}/ok` }), ctx));
    expect(text).toContain("Fetch blocked");
    expect(text).toContain("user denied");
    expect(text).toContain('"fetchPolicy": { "allow": [');
    expect(hits.a).toBe(before);
  });

  it("an aborted run denies instead of dangling on the prompt", async () => {
    const before = hits.a;
    const controller = new AbortController();
    const { tool } = wire({ default: "ask" });
    const input: FakeInput = {
      isInteractive: () => true,
      collectAnswers: () => new Promise(() => {}), // nobody answers
    };
    setTimeout(() => controller.abort(), 10);
    const text = getDisplay(
      await tool.execute(JSON.stringify({ url: `${originA}/ok` }), fakeCtx({ input, signal: controller.signal })),
    );
    expect(text).toContain("cancelled while awaiting approval");
    expect(hits.a).toBe(before);
  });

  it("tokenizes spoofing code points in the echoed URL", async () => {
    const { input, asked } = answerWith("deny");
    const { tool } = wire({ default: "ask" });
    const ctx = fakeCtx({ input, sessionId: "s1" });
    await tool.execute(JSON.stringify({ url: `${originA}/ok\u200b\u202e` }), ctx);
    expect(asked[0]).toContain("[U+200B]");
    expect(asked[0]).toContain("[U+202E]");
  });

  it("parallel asks for one origin prompt once (memo re-check at the queue head)", async () => {
    const { input, asked } = answerWith("allow origin for session");
    const { tool } = wire({ default: "ask" });
    const ctx = fakeCtx({ input, sessionId: "s1" });
    const results = await Promise.all([
      tool.execute(JSON.stringify({ url: `${originA}/one` }), ctx),
      tool.execute(JSON.stringify({ url: `${originA}/two` }), ctx),
    ]);
    for (const r of results) expect(getDisplay(r)).toContain("a body");
    expect(asked).toHaveLength(1);
  });

  it("asks at the redirect hop and follows on allow", async () => {
    const { input, asked } = answerWith("allow once");
    const { tool } = wire({ default: "ask", allow: [originA] });
    const ctx = fakeCtx({ input, sessionId: "s1" });
    const result = await tool.execute(JSON.stringify({ url: `${originA}/to-b` }), ctx);
    expect(getDisplay(result)).toContain("b body");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(originB);
  });
});
