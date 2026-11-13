/**
 * The provider list and the speech-to-text target, through the real write
 * transaction against a live host.
 *
 * Pinned here, in the order the mechanism actually runs:
 *  - a provider list change re-points the ONE client object the agent plane
 *    uses, so the next provider resolution goes to the new endpoint (the
 *    observable that makes the row more than a store write).
 *  - a catalog read that can be reached UPSERTS its entries into the registry
 *    object the published generation carries -- the identity every running
 *    session already holds is the object that gains the entries.
 *  - a catalog read that cannot be reached degrades WITHOUT corrupting
 *    anything: the store keeps the new value, the reply is ok, the hook report
 *    says degraded, the endpoint is named by host only, and no credential byte
 *    appears in the reply, the notice or the audit surface. The notice also
 *    states the one thing this host does not rebuild: the health sweep's probe
 *    set.
 *  - the STT rebuild resolves the new target and pushes the enabled flip over
 *    the session-state channel exactly when it flips, and stays quiet when it
 *    does not.
 *  - the plane-posture keys (execFence/toolExec) audit the change WITH the
 *    writing session and name what the write does not move; writing the same
 *    posture back is silent.
 *  - the keys this batch did not rule live still answer restart-required.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { applyConfigKeyEdit } from "@extensions/websocket/handlers-config.ts";
import { sessionCreatedPayload } from "@extensions/websocket/session-created.ts";
import { registerConfigAuditSurface } from "@core/config/audit.ts";
import { bootLive, fsDeps, seedFile, withShadowEnvCleared, type LiveEnv } from "./probes.ts";
import type { SessionRegistry } from "@extensions/websocket/session-registry.ts";

let env: LiveEnv;
let notices: string[] = [];
let releaseSurface: (() => void) | null = null;

beforeAll(async () => {
  env = await bootLive();
  releaseSurface = registerConfigAuditSurface((text) => notices.push(text));
});

afterAll(() => {
  releaseSurface?.();
  env?.cleanup();
});

/** Run one write, capturing every audit-surface notice it emits. */
async function write(
  keyPath: string,
  input: Parameters<typeof applyConfigKeyEdit>[2],
): Promise<{ res: Awaited<ReturnType<typeof applyConfigKeyEdit>>; notices: string[]; wire: string }> {
  notices = [];
  const res = await withShadowEnvCleared(() => applyConfigKeyEdit(env.core, keyPath, input, { deps: fsDeps }));
  return { res, notices: [...notices], wire: JSON.stringify(res) };
}

/** As write(), arriving on a session: the actor rides the audit lines. */
async function writeWithActor(
  keyPath: string,
  input: Parameters<typeof applyConfigKeyEdit>[2],
  actor: string,
): Promise<{ res: Awaited<ReturnType<typeof applyConfigKeyEdit>>; notices: string[] }> {
  notices = [];
  const res = await withShadowEnvCleared(() =>
    applyConfigKeyEdit(env.core, keyPath, input, { deps: fsDeps, actor }),
  );
  return { res, notices: [...notices] };
}

describe("provider list: the shared-client re-point and the catalog sweep", () => {
  it("the endpoint a write installs is the endpoint a provider resolves through afterwards", async () => {
    const { res, notices, wire } = await write("providers[0].url", {
      value: "http://live-provider.invalid/v1",
    });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (res.ok) expect(res.applied).toBe("live");

    // The shared client object is the one the agent plane holds; its provider
    // list is what the next resolution reads.
    expect(env.ws.llmClient.providers.map((p) => p.url)).toEqual(["http://live-provider.invalid/v1"]);
    expect(env.ws.llmClient.resolveProviderSettings("seedcard/anything").url).toBe(
      "http://live-provider.invalid/v1",
    );

    const audit = notices.find((n) => n.startsWith("providers:"));
    expect(audit, `the re-point logged an audit line: ${JSON.stringify(notices)}`).toBeDefined();
    expect(audit).toContain("1 entries");
    expect(audit).toContain("probe set: restart-bound");
    expect(wire).not.toContain("boot-key"); // no credential rode the reply
  });

  it("a catalog read that cannot be reached degrades without corrupting anything, and leaks no secret", async () => {
    // Three child writes, in the order that makes the degrade land on the last
    // one: the credential goes in while nothing is being fetched, then the
    // endpoint (still no fetch), then `fetchModels` opts the entry into the
    // sweep the apply hook runs. Port 1 on loopback refuses instantly, so the
    // degrade path is observed rather than waited out.
    const key = await write("providers[0].apiKey", { valueText: "CANARY-provider-key" });
    expect(key.res.ok, key.res.ok ? "" : key.res.error).toBe(true);
    // The writeOnly channel: a reply never echoes a replacement credential.
    expect(key.wire).not.toContain("CANARY-provider-key");
    for (const n of key.notices) expect(n).not.toContain("CANARY-provider-key");

    const endpoint = await write("providers[0].url", { value: "http://127.0.0.1:1/v1" });
    expect(endpoint.res.ok, endpoint.res.ok ? "" : endpoint.res.error).toBe(true);

    const { res, notices: sweepNotices, wire } = await write("providers[0].fetchModels", { value: true });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (res.ok) {
      // The values landed (file and store both moved) while the side effect
      // that could not run is reported as such: a failed apply never re-swaps.
      const stored = (env.store.current().config as Record<string, unknown>).providers as Record<
        string,
        unknown
      >[];
      expect(stored[0]).toMatchObject({
        name: "seedcard",
        url: "http://127.0.0.1:1/v1",
        fetchModels: true,
      });
      expect(res.applied).toBe("restart-required");
      expect(res.needsRestart).toBe(true);
      const report = (res.applyHooks ?? []).find((h) => h.keyPath === "providers");
      expect(report?.status).toBe("degraded");
    }

    // Degrade is not destructive: the client still carries the stored list.
    expect(env.ws.llmClient.providers.map((p) => p.url)).toEqual(["http://127.0.0.1:1/v1"]);

    const audit = sweepNotices.find((n) => n.startsWith("providers:"));
    expect(audit, `the degrade logged an audit line: ${JSON.stringify(sweepNotices)}`).toBeDefined();
    expect(audit).toContain("model catalog INCOMPLETE");
    expect(audit).toContain("127.0.0.1:1"); // named by host:port, never by URL-with-credential
    expect(audit).toContain("the health sweep retries");
    expect(audit).toContain("probe set: restart-bound");
    // Canary: the credential appears nowhere a log reader or a panel could see
    // it -- not in the reply, not in any notice this transaction emitted.
    expect(wire).not.toContain("CANARY-provider-key");
    for (const n of sweepNotices) expect(n).not.toContain("CANARY-provider-key");
  });

  it("a catalog read that IS reachable lands its entries inside the registry the store carries", async () => {
    // The success half of the same row. The entries must land INSIDE the
    // `modelRegistry` object the published generation carries -- live sessions,
    // locked placements and the profile manager all hold that identity, so an
    // upsert is the only shape this side effect may take; a replacement would
    // be invisible to everything already running. A loopback catalog is the
    // honest fixture: the request, the parse and the merge are production's.
    const catalog = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json({
          data: [
            { id: "remote-one", owned_by: "seedcard" },
            { id: "remote-two", owned_by: "seedcard", architecture: { input_modalities: ["text"] } },
          ],
        }),
    });
    try {
      const carried = env.store.current().resolved!.modelRegistry as Record<string, unknown>;
      expect(carried["seedcard/remote-one"]).toBeUndefined();

      // `fetchModels` is already true (the degrade row opted this entry in), so
      // pointing the entry at the endpoint that answers is the whole fixture.
      const { res, notices, wire } = await write("providers[0].url", {
        value: `http://127.0.0.1:${catalog.port}/v1`,
      });
      expect(res.ok, res.ok ? "" : res.error).toBe(true);
      if (res.ok) {
        expect(res.applied).toBe("live");
        const reports = (res.applyHooks ?? []).filter((h) => h.keyPath === "providers" && h.phase === "apply");
        expect(reports.length).toBeGreaterThan(0);
        expect(reports.every((r) => r.status === "applied"), JSON.stringify(reports)).toBe(true);
      }

      // Same object, new entries: piggybacked, never replaced.
      expect(env.store.current().resolved!.modelRegistry as Record<string, unknown>).toBe(carried);
      expect(Object.keys(carried).filter((k) => k.startsWith("seedcard/")).sort()).toEqual([
        "seedcard/remote-one",
        "seedcard/remote-two",
      ]);
      // The agent plane reads the endpoint off the same shared client it read
      // before the write, so the catalog and the list agree.
      expect(env.ws.llmClient.providers.map((p) => p.url)).toEqual([`http://127.0.0.1:${catalog.port}/v1`]);

      const audit = notices.find((n) => n.startsWith("providers:"));
      expect(audit, `the refresh logged an audit line: ${JSON.stringify(notices)}`).toBeDefined();
      expect(audit).toContain("model catalog refreshed into the live registry");
      expect(audit).not.toContain("INCOMPLETE");
      expect(wire).not.toContain("CANARY-provider-key");
      for (const n of notices) expect(n).not.toContain("CANARY-provider-key");
    } finally {
      catalog.stop(true);
    }
  });
});

describe("speech-to-text: the rebuild and its enabled flip", () => {
  /** Record what the registry pushes on the session-state channel. */
  function recordSessionState(registry: SessionRegistry): {
    frames: Record<string, unknown>[];
    stop(): void;
  } {
    const frames: Record<string, unknown>[] = [];
    const original = registry.broadcastScoped.bind(registry);
    registry.broadcastScoped = (sessionId: string, msg: Record<string, unknown>) => {
      frames.push({ ...msg, __sessionId: sessionId });
      original(sessionId, msg);
    };
    return { frames, stop: () => void (registry.broadcastScoped = original) };
  }

  it("an endpoint write resolves a target, advertises it, and pushes the flip", async () => {
    expect(env.ws.sessionRegistry.sttEnabled).toBe(false);
    // A flip is only worth pushing to somebody: with no live session there is
    // nobody to tell, and the hook says so without pretending otherwise. The
    // empty-host control runs first so the push below is the addressing, not
    // the write.
    const control = recordSessionState(env.ws.sessionRegistry);
    const { res: quiet } = await write("sttModel", { value: "whisper-none" });
    expect(quiet.ok, quiet.ok ? "" : quiet.error).toBe(true);
    expect(control.frames.filter((f) => f.key === "sttEnabled")).toEqual([]); // target still absent
    control.stop();

    const { sessionId } = await env.ws.sessionRegistry.create();
    expect(env.ws.sessionRegistry.list().map((r) => r.id)).toContain(sessionId);
    // Control, from the one payload builder every create/attach path shares:
    // a session born before the flip advertises no mic.
    expect(sessionCreatedPayload(env.ws.sessionRegistry, sessionId).sttEnabled).toBe(false);
    const spy = recordSessionState(env.ws.sessionRegistry);
    try {
      const { res, notices } = await write("sttUrl", { value: "http://stt.invalid/v1/audio/transcriptions" });
      expect(res.ok, res.ok ? "" : res.error).toBe(true);
      if (res.ok) expect(res.applied).toBe("live");
      expect(env.ws.sessionRegistry.sttEnabled).toBe(true);
      expect(env.ws.sessionRegistry.sttTarget?.url).toBe("http://stt.invalid/v1/audio/transcriptions");

      const flips = spy.frames.filter((f) => f.key === "sttEnabled");
      expect(flips.length).toBeGreaterThan(0); // the affordance moved: say so
      expect(flips.every((f) => f.value === true && f.__sessionId === sessionId)).toBe(true);

      // The endpoint change is audited by host only: a URL can carry
      // credentials in its userinfo and this line is written to a log.
      const audit = notices.find((n) => n.startsWith("sttUrl:"));
      expect(audit, `the endpoint change logged an audit line: ${JSON.stringify(notices)}`).toBeDefined();
      expect(audit).toContain("host:port only, value not shown");
      expect(audit).toContain("sttEnabled=true");

      // The push only tells sessions that already exist. One born AFTER the
      // flip must be advertised with the mic it actually has, through the same
      // payload builder the attach and create replies use.
      const { sessionId: late } = await env.ws.sessionRegistry.create();
      expect(sessionCreatedPayload(env.ws.sessionRegistry, late).sttEnabled).toBe(true);
    } finally {
      spy.stop();
    }
  });

  it("a model write re-resolves without a second flip (no push, no spam)", async () => {
    const spy = recordSessionState(env.ws.sessionRegistry);
    try {
      const { res } = await write("sttModel", { value: "whisper-quiet" });
      expect(res.ok, res.ok ? "" : res.error).toBe(true);
      if (res.ok) expect(res.applied).toBe("live");
      expect(env.ws.sessionRegistry.sttTarget?.model).toBe("whisper-quiet");
      expect(spy.frames.filter((f) => f.key === "sttEnabled")).toEqual([]);
    } finally {
      spy.stop();
    }
  });

  it("clearing the endpoint takes the mic away and pushes the flip back", async () => {
    expect(env.ws.sessionRegistry.list().length).toBeGreaterThan(0); // the session the flip addresses
    const spy = recordSessionState(env.ws.sessionRegistry);
    try {
      const { res } = await write("sttUrl", { value: "" });
      expect(res.ok, res.ok ? "" : res.error).toBe(true);
      expect(env.ws.sessionRegistry.sttEnabled).toBe(false);
      const flips = spy.frames.filter((f) => f.key === "sttEnabled");
      expect(flips.length).toBeGreaterThan(0);
      expect(flips.every((f) => f.value === false)).toBe(true);
    } finally {
      spy.stop();
    }
  });
});

describe("the keys this batch did not rule live still answer restart-required", () => {
  // A key with no row in the static table cannot claim a live class whatever
  // the running host registered. These are the ruled exceptions: a subprocess
  // env map (a code-execution channel) and an extension's on/off switch (its
  // hook rows exist or they do not) stay boot decisions, so the reply must keep
  // saying restart-required no matter how much machinery is live nearby.
  let scopeEnv: LiveEnv;

  beforeAll(async () => {
    // Both keys carry a value in the file: a key the server has no schema entry
    // for AND no file value for is refused outright, which is a different
    // promise than the one being pinned here.
    scopeEnv = await bootLive({
      ...seedFile(),
      bashTool: { env: { HOTDOG_PROBE: "0" } },
      webui: { port: 3000, host: "127.0.0.1", apiKey: "scope-key" },
    });
  });

  afterAll(() => scopeEnv?.cleanup());

  // Containers travel as JSON text through the write gate (the file shape is
  // the gate for a file-only container), exactly as the panel sends them.
  const outOfScope: Array<[string, Record<string, unknown>]> = [
    ["bashTool.env", { valueText: JSON.stringify({ HOTDOG_PROBE: "1" }) }],
    ["webui.host", { value: "0.0.0.0" }],
  ];

  for (const [keyPath, input] of outOfScope) {
    it(`${keyPath}: persisted, restart-required, nothing claiming live`, async () => {
      notices = [];
      const res = await withShadowEnvCleared(() =>
        applyConfigKeyEdit(scopeEnv.core, keyPath, input, { deps: fsDeps }),
      );
      expect(res.ok, res.ok ? "" : res.error).toBe(true);
      if (res.ok) {
        expect(res.applied).toBe("restart-required");
        expect(res.needsRestart).toBe(true);
      }
      // And nothing in this batch's machinery claimed the key: no notice, and
      // no apply-hook report pretending a holder moved.
      expect(notices).toEqual([]);
      expect(res.ok ? (res.applyHooks ?? []) : []).toEqual([]);
    });
  }
});

describe("the plane-posture keys audit the change (who wrote, what still stands)", () => {
  // execFence and toolExec reach the pool and the next build, never a running
  // artifact -- the audit line is therefore where the reply stops claiming, and
  // it has to carry the whole truth: the new posture, the writing session, and
  // the two things the write explicitly does NOT move.
  it("an execFence posture write is audited with the actor and the new-entries-only truth", async () => {
    const { res, notices } = await writeWithActor("execFence", { value: "off" }, "panel-posture-a");
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (res.ok) expect(res.applied).toBe("next-session");
    const audit = notices.find((n) => n.startsWith("execFence:"));
    expect(audit, `the posture change logged an audit line: ${JSON.stringify(notices)}`).toBeDefined();
    expect(audit).toContain("written by session panel-posture-a");
    expect(audit).toContain("running entry keeps its kernel fence");
    expect(audit).toContain("/fence override still outranks the file");
  });

  it("a plane write audited for the next build, and the same value again says nothing", async () => {
    const { res, notices } = await writeWithActor("toolExec", { value: "inline" }, "panel-posture-b");
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (res.ok) expect(res.applied).toBe("next-session");
    const audit = notices.find((n) => n.startsWith("toolExec:"));
    expect(audit, `the plane change logged an audit line: ${JSON.stringify(notices)}`).toBeDefined();
    expect(audit).toContain("for the next agent build");
    expect(audit).toContain("written by session panel-posture-b");
    expect(audit).toContain("running agents keep the plane they were built on");

    // The value-changed guard: writing the posture back says nothing at all.
    const again = await writeWithActor("toolExec", { value: "inline" }, "panel-posture-b");
    expect(again.res.ok, again.res.ok ? "" : again.res.error).toBe(true);
    expect(again.notices).toEqual([]);
  });
});
