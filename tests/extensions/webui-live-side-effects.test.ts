/**
 * The webui host's side-effect class, end to end: a real config transaction
 * against a real served webui.
 *
 * What is pinned here is the part a table of probes cannot say:
 *  - an auth REBUILD is a policy swap, not a restart: a token issued before
 *    the write still validates to the expiry stamped at ITS issuance, issuance
 *    after the write carries the new TTL, a throttle bucket a probing client
 *    already climbed survives, the x-forwarded-for warning fires once per
 *    server rather than once per policy, and the process keeps exactly one
 *    cleanup sweep. Every consumer (both token-checking routes, the login
 *    route, the websocket AUTH chain and the upgrade-time check) resolves the
 *    rebuilt policy because they all hold the facade, not an instance.
 *  - a bad candidate is refused BEFORE anything moves: a malformed proxy
 *    matcher and a blank credential leave the running middleware in charge,
 *    the file keeps the write, and the reply carries the boot wording.
 *  - webui.port rebinds: the reply leaves the socket first (it claims
 *    "rebind" + a brief drop), then the listener moves; writing back the port
 *    that is already listening claims no such act; a refused port puts
 *    the old listener back and says so on the log + the generation's degraded
 *    list; the transport frame cap is rebuilt from the live upload limits, so
 *    a cap raised before the move rides the same rebind.
 *  - a stopped server holds nothing: its hooks are gone, and a later write to
 *    its key answers restart-required because there is genuinely no holder.
 *  - the audit lines carry no credential bytes.
 *
 * No mocks: the store, the write transaction, the HTTP surface and the
 * websocket transport are the production ones; only the agent builder is a
 * stub (these tests never run a turn).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TMP_PARENT } from "../mocks/io.ts";
import { getDefaultConfig } from "@core/config/index.ts";
import { createConfigStore, type ConfigStore } from "@core/config/store.ts";
import { createCore, type CoreInfrastructure } from "@core/main.ts";
import { createSubcommandRegistry } from "@core/extensions/registries.ts";
import type { ResolvedConfig } from "@core/extensions/types.ts";
import { registeredHooks } from "@core/config/apply-hooks.ts";
import { registerConfigAuditSurface } from "@core/config/audit.ts";
import { applyConfigKeyEdit, type ConfigEditDeps } from "@extensions/websocket/handlers-config.ts";
import { createWebuiServer } from "@extensions/webui/server.ts";
import { C2S } from "@extensions/websocket/protocol.ts";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";

const fsDeps: ConfigEditDeps = {
  readFile: (p) => readFile(p, "utf-8"),
  writeFile: (p, data) => writeFile(p, data, "utf-8"),
  rename: (from, to) => rename(from, to),
  unlink: (p) => unlink(p),
};

/** Schema mirrors of the real extension entries (the same shape the
 *  config-live harness hand-mirrors for `websocket`): the write gate and the
 *  re-resolve's extension tail need something to resolve and validate against. */
const ENTRIES = [
  {
    key: "websocket",
    description: "websocket config",
    defaults: {},
    schema: {
      type: "object",
      properties: {
        sessionTimeoutMin: { type: "number", default: 30, description: "Idle session cleanup timeout (minutes)" },
        questionTimeoutSecs: { type: "number", default: 300, description: "Default question timeout (seconds)" },
      },
      layers: [{ source: "config", key: "websocket" }, { default: {} }],
    },
    layers: [{ source: "config", key: "websocket" }, { default: {} }],
  },
  {
    key: "webui",
    description: "webui config",
    defaults: {},
    schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", default: true, description: "Whether this extension is enabled" },
        port: { type: "number", default: 3000, description: "WebUI server port" },
        host: { type: "string", default: "127.0.0.1", description: "WebUI server host" },
        apiKey: { type: "string", default: null, description: "API key for login authentication" },
        sessionTokenTtlMin: { type: "number", default: 1440, description: "Session token TTL in minutes" },
        trustedProxy: { type: "string", default: "", description: "Trusted reverse proxy IP or CIDR" },
      },
      layers: [{ source: "config", key: "webui" }, { default: {} }],
    },
    layers: [{ source: "config", key: "webui" }, { default: {} }],
  },
];

function fakeRegistry(): never {
  return {
    getConfigParams: () => ENTRIES,
    getCliFlags: () => [],
    getConfigParamsRaw: () => ENTRIES,
  } as never;
}

const KEY = "side-effect-boot-key";
const MAX_IMAGE_SIZE = 10485760;

interface Host {
  dir: string;
  core: CoreInfrastructure;
  store: ConfigStore;
  webui: Awaited<ReturnType<typeof createWebuiServer>>;
  file(): string;
  fileBytes(): string;
  baseUrl(): string;
  port(): number;
  cleanup(): void;
}

async function bootHost(over: Record<string, unknown> = {}): Promise<Host> {
  const dir = mkdtempSync(join(TMP_PARENT, "hotdog-webui-live-"));
  const seed = {
    aiUrl: "http://boot.invalid/v1",
    defaultModel: "boot/model",
    apiKey: "boot-key",
    hookTrace: false,
    websocket: { sessionTimeoutMin: 30, questionTimeoutSecs: 300 },
    webui: { port: 0, host: "127.0.0.1", apiKey: KEY, sessionTokenTtlMin: 600 },
    ...over,
  };
  writeFileSync(join(dir, "defaults.json"), JSON.stringify(seed, null, 2) + "\n");
  const store = createConfigStore();
  const core = createCore(
    { ...getDefaultConfig(), ...seed } as never,
    fakeRegistry(),
    createSubcommandRegistry(),
    { store },
  );
  core.resolved = {
    configDir: dir,
    modelRegistry: {},
    baseUrl: "http://boot.invalid/v1",
    apiKey: "boot-key",
    hookTrace: false,
    model: "boot/model",
    maxIterations: 50,
    contextLimit: 128000,
    profilesPath: "./config/profiles",
    profileBody: "",
    profileName: "default",
    workspaceRoots: [dir],
    workspaceDeny: [],
    toolExec: "worker",
    execFence: "probe",
    sttUrl: null,
    sttModel: null,
    uploadLimits: { maxFileSize: 102400, maxImageSize: MAX_IMAGE_SIZE, maxFiles: 10 },
  } as unknown as ResolvedConfig;

  const block = (core.config as Record<string, unknown>).webui as Record<string, unknown>;
  const webui = await createWebuiServer(core, {
    port: block.port as number,
    host: block.host as string,
    apiKey: block.apiKey as string,
    sessionTokenTtlMin: block.sessionTokenTtlMin as number,
  });

  return {
    dir,
    core,
    store,
    webui,
    file: () => join(dir, "defaults.json"),
    fileBytes: () => readFileSync(join(dir, "defaults.json"), "utf-8"),
    baseUrl: () => `http://127.0.0.1:${webui.server.port}`,
    port: () => webui.server.port as number,
    cleanup: () => {
      webui.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A port the OS just handed out and released -- spare enough to bind, and
 *  not a number any other test in this file is holding. */
async function sparePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

async function login(baseUrl: string, apiKey: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ apiKey }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function verify(baseUrl: string, token: string): Promise<number> {
  return (await fetch(`${baseUrl}/verify`, { headers: { "x-hotdog-token": token } })).status;
}

async function refusesConnection(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/verify`, {
      headers: { "x-hotdog-token": "anything" },
      signal: AbortSignal.timeout(1500),
    });
    return res.status !== 401; // a live webui answers 401; anything else means something else is home
  } catch {
    return true; // connection refused / timed out: nobody is listening
  }
}

/** Settle helper for the deferred rebind: poll until the predicate holds. */
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 4000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe("webui live config: the auth rebuild over the carried state", () => {
  let host: Host;

  beforeAll(async () => {
    host = await bootHost();
  });
  afterAll(() => host?.cleanup());

  it("tokens, throttle buckets, the xff once-flag and the sweep all outlive the swap; issuance follows the new TTL", async () => {
    const base = host.baseUrl();
    const auth = host.webui.authMiddleware;

    // A token issued under the boot TTL, and a throttle bucket under the same
    // client ip the rebuild will be tested against.
    const first = await login(base, KEY);
    expect(first.status).toBe(200);
    const preToken = String(first.body!.token);
    expect(await verify(base, preToken)).toBe(200);

    // One bad attempt: the ladder's first rung, keyed on the direct peer.
    const bad = await login(base, "wrong-key");
    expect(bad.status).toBe(401);
    const bucketKey = [...auth.state().rateLimits.keys()][0] ?? "";
    const bucket = auth.state().rateLimits.get(bucketKey);
    expect(bucket?.failures).toBe(1);

    // The xff warning fires exactly once per server, and the flag lives on the
    // carried state (an instance-local flag would re-warn after the swap).
    await login(base, "wrong-key", { "x-forwarded-for": "203.0.113.9" });
    expect(auth.state().xffWarned).toBe(true);

    const sweepBefore = auth.state().cleanupInterval;
    expect(sweepBefore).not.toBeNull();

    // The write: TTL 600 -> 5, and nothing else -- the credential this server
    // booted with stays the credential (the rotation is a later row). The audit
    // surface stays watched ACROSS the rebind's deferral window: this write
    // lives under the same ROOT the port row registered on, so the port hook's
    // own keyPath compare is the only thing keeping an auth write from stopping
    // and re-serving the listener ("...connected sockets dropped") over a port
    // nobody asked to move.
    const listenerBefore = host.webui.server;
    const portBefore = host.port();
    const surface: string[] = [];
    const releaseSurface = registerConfigAuditSurface((text) => surface.push(text));
    let res: Awaited<ReturnType<typeof applyConfigKeyEdit>>;
    try {
      res = await applyConfigKeyEdit(
        host.core,
        "webui.sessionTokenTtlMin",
        { value: 5 },
        { deps: fsDeps },
      );
      expect(res.ok, res.ok ? "" : res.error).toBe(true);
      if (res.ok) {
        expect(res.applied).toBe("live");
        expect(JSON.stringify(res.appliedNotices ?? [])).not.toContain("expect a brief drop");
      }
      // Comfortably past the deferred move's grace, so a rebind that was
      // scheduled has stopped, re-served and logged by now.
      await Bun.sleep(150);
    } finally {
      releaseSurface();
    }
    expect(surface.filter((n) => n.startsWith("webui.port:"))).toEqual([]);
    expect(host.webui.server).toBe(listenerBefore); // no stop/re-serve happened
    expect(host.port()).toBe(portBefore);
    expect(await verify(base, preToken)).toBe(200);

    // Pre-write token: still valid, and still at the expiry ITS issuance
    // stamped -- not stretched, not shortened by the new TTL.
    const stamped = auth.state().sessions.get(preToken);
    expect(stamped).toBeDefined();
    expect(stamped!.expiresAt - stamped!.createdAt).toBe(600 * 60_000);
    expect(await verify(base, preToken)).toBe(200);

    // Carried state, checked before any successful login (one clears its own
    // bucket by design): the failed attempts' ladder is the SAME entry object
    // the pre-write middleware built -- a rebuild that reset it would hand a
    // probing client a fresh ladder mid-probe. The once-flag stayed set, the
    // sweep handle never changed hands, and no token was dropped.
    expect(auth.state().rateLimits.get(bucketKey)).toBe(bucket);
    expect(auth.state().xffWarned).toBe(true);
    expect(auth.state().cleanupInterval).toBe(sweepBefore);
    expect(auth.state().sessions.has(preToken)).toBe(true);

    // A token issued AFTER the write carries the NEW TTL, and the credential
    // that booted this server is still the credential it authenticates: this
    // write moved the TTL only. (A rebuild that changed more than it was told
    // would show up here as a locked-out operator.)
    expect((await login(base, "boot-key-rotated")).status).toBe(401);
    const stillIn = await login(base, KEY);
    expect(stillIn.status, `boot key must still log in: ${JSON.stringify(stillIn)}`).toBe(200);
    const fresh = auth.state().sessions.get(String(stillIn.body!.token));
    expect(fresh!.expiresAt - fresh!.createdAt).toBe(5 * 60_000);
  });

  it("the websocket side holds the same facade: AUTH validates against the rebuilt policy", async () => {
    const base = host.baseUrl();
    const res = await login(base, KEY);
    expect(res.status).toBe(200);
    const token = String(res.body!.token);

    // The AUTH chain resolves the CURRENT instance per message, so a token
    // minted after the rebuild passes over a socket whose server booted with
    // the old credential.
    // The upgrade gate wants a same-origin Origin; Bun's client sends none.
    const ws = new WebSocket(base.replace("http", "ws") + "/ws", { headers: { Origin: base } } as never);
    const frames: Record<string, unknown>[] = [];
    ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("ws connect failed"));
    });
    ws.send(JSON.stringify({ type: C2S.AUTH, token }));
    await until(() => frames.some((f) => f.type === "authOk" || f.type === "error"), "the AUTH verdict", 4000);
    ws.close();
    expect(frames.some((f) => f.type === "authOk"), JSON.stringify(frames)).toBe(true);
  });

  it("a malformed trustedProxy refuses the swap: file keeps it, store and middleware do not, and boot's wording is the reply", async () => {
    const base = host.baseUrl();
    const genBefore = host.store.current();
    const res = await applyConfigKeyEdit(
      host.core,
      "webui.trustedProxy",
      { value: "not-a-cidr" },
      { deps: fsDeps },
    );
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (res.ok) {
      expect(res.applied).toBe("restart-required");
      expect(res.needsRestart).toBe(true);
      const text = JSON.stringify(res);
      // The verbatim boot message -- one home for it, so the panel says what
      // a failed boot would have said.
      expect(text).toContain("Invalid webui.trustedProxy");
      expect(text).toContain("not-a-cidr");
    }
    // The file is the operator's write; the running generation is not.
    expect(host.fileBytes()).toContain("not-a-cidr");
    expect(host.store.current()).toBe(genBefore);
    expect((host.store.current().config as Record<string, unknown>).webui).toMatchObject({
      trustedProxy: "",
    });
    // And the server that refused it is still serving on the same listener.
    expect(await verify(base, "nope")).toBe(401);

    // Clear it again through the same transaction (an empty matcher is valid,
    // so this swap lands). Left in the file it would hold every later write on
    // this host at the same refusal -- true, but not what the other rows here
    // are about; they get a clean candidate.
    const clear = await applyConfigKeyEdit(host.core, "webui.trustedProxy", { value: "" }, { deps: fsDeps });
    expect(clear.ok, clear.ok ? "" : clear.error).toBe(true);
    if (clear.ok) expect(clear.applied).toBe("live");
  });

  it("a blank credential refuses the swap: a running server keeps the key it authenticated with", async () => {
    const before = JSON.stringify((host.store.current().config as Record<string, unknown>).webui);
    const res = await applyConfigKeyEdit(host.core, "webui.apiKey", { valueText: "   " }, { deps: fsDeps });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (res.ok) {
      expect(res.applied).toBe("restart-required");
      expect(JSON.stringify(res)).toContain("webui.apiKey is empty");
    }
    expect(JSON.stringify((host.store.current().config as Record<string, unknown>).webui)).toBe(before);
    // The refused write never reached the policy: the live key still logs in.
    expect((await login(host.baseUrl(), KEY)).status).toBe(200);
  });

  it("a credential rotation lands, is audited without its bytes, and reaches every consumer", async () => {
    // The audit seam, observed at its registered surface: the primitive hands
    // the exact text the log line carries to whatever sink the served host
    // installed, so this is the same string a live session sees.
    const notices: string[] = [];
    const release = registerConfigAuditSurface((text) => notices.push(text));
    let status = 0;
    try {
      const res = await applyConfigKeyEdit(
        host.core,
        "webui.apiKey",
        { valueText: "canary-bytes-DO-NOT-LEAK" },
        { deps: fsDeps },
      );
      expect(res.ok, res.ok ? "" : res.error).toBe(true);
      if (res.ok) {
        expect(res.applied).toBe("live");
        // The reply never echoes a writeOnly replacement.
        expect(JSON.stringify(res)).not.toContain("canary-bytes-DO-NOT-LEAK");
      }
      status = (await login(host.baseUrl(), "canary-bytes-DO-NOT-LEAK")).status;
      // And the boot credential is out of the running policy: the rebuild is
      // what /login compares against now, with no restart in between.
      expect((await login(host.baseUrl(), KEY)).status).toBe(401);
    } finally {
      release();
    }
    expect(status).toBe(200);
    const audit = notices.find((n) => n.startsWith("webui:"));
    expect(audit, `the swap logged an audit line: ${JSON.stringify(notices)}`).toBeDefined();
    expect(audit).toContain("login credential replaced");
    expect(audit!).not.toContain("canary-bytes-DO-NOT-LEAK");
    expect(audit).toContain("auth middleware rebuilt over the carried sessions");
  });
});

describe("webui live config: the port rebind", () => {
  let host: Host;

  beforeAll(async () => {
    host = await bootHost();
  });
  afterAll(() => host?.cleanup());

  it("the reply answers first, then the listener moves: the old port empties, the new one serves", async () => {
    const from = host.port();
    expect(from).toBeGreaterThan(0); // port 0 resolved to a real one at boot
    const to = await sparePort();

    const res = await applyConfigKeyEdit(host.core, "webui.port", { value: to }, { deps: fsDeps });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (res.ok) {
      // The class the panel renders BEFORE any drop happens, with the honest
      // warning attached: the reply cannot be retracted once it is out.
      expect(res.applied).toBe("rebind");
      expect(res.needsRestart).toBe(false);
      expect(JSON.stringify(res.appliedNotices ?? [])).toContain("expect a brief drop");
      // And at the moment the transaction resolved, the old listener was
      // still the one answering: the move is deferred past the reply.
      expect(host.port()).toBe(from);
    }

    await until(async () => {
      try {
        const r = await fetch(`${host.baseUrl()}/verify`, { headers: { "x-hotdog-token": "x" } });
        return r.status === 401 && host.port() === to;
      } catch {
        return false;
      }
    }, "the listener to move to the new port");

    expect(await refusesConnection(from)).toBe(true); // nothing of ours is home any more
    // A token issued before the move still works on the new listener: the
    // state carried across the socket drop.
    const session = await login(host.baseUrl(), KEY);
    expect(session.status).toBe(200);
  });

  it("a refused port puts the old listener back and decorates the generation with the truth", async () => {
    // Occupy a port so the bind genuinely fails: the decoy is what stays home.
    const decoy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("decoy") });
    const taken = decoy.port as number;
    const from = host.port();
    try {
      const res = await applyConfigKeyEdit(host.core, "webui.port", { value: taken }, { deps: fsDeps });
      expect(res.ok, res.ok ? "" : res.error).toBe(true);
      if (res.ok) expect(res.applied).toBe("rebind"); // the promise, made before the attempt

      await until(() => host.port() === from, "the recovery re-listen on the old port");
      await until(() => {
        const degraded = host.store.current().degraded ?? [];
        return degraded.some((d) => d.keyPath === "webui.port");
      }, "the degraded report on the published generation");

      // The old port answers again, the taken one still belongs to the decoy.
      expect(await verify(host.baseUrl(), "nope")).toBe(401);
      expect(await fetch(`http://127.0.0.1:${taken}/`).then((r) => r.text())).toBe("decoy");
      const why = (host.store.current().degraded ?? []).find((d) => d.keyPath === "webui.port")!.why;
      expect(why).toContain(String(taken));
    } finally {
      decoy.stop(true);
    }
  });

  it("a cap raised before the move rides the same rebind (no setter exists, so the bind is the moment)", async () => {
    // The transport bound derives from uploadLimits.maxImageSize, so a frame
    // between the boot bound and the raised one dies at the socket before the
    // move and reaches the APPLICATION after it -- the only honest observable
    // for a value Bun freezes into the handler at construction time.
    const from = host.port();
    const to = await sparePort();
    const bootBound = 4 * Math.ceil(MAX_IMAGE_SIZE / 3) + 1024 * 1024;
    const raised = 4 * Math.ceil((MAX_IMAGE_SIZE * 2) / 3) + 1024 * 1024;
    // One frame, sized to land between the two bounds (the 80 is the JSON
    // envelope around the filler).
    const frame = (filler: number) =>
      JSON.stringify({ type: C2S.SEND, sessionId: "frame-bound-probe", content: "a".repeat(filler) });
    const filler = Math.floor((bootBound + raised) / 2) - 80;
    expect(frame(filler).length).toBeGreaterThan(bootBound);
    expect(frame(filler).length).toBeLessThan(raised);

    expect(await transportRefuses(from, frame(filler))).toBe(true);

    const capWrite = await applyConfigKeyEdit(
      host.core,
      "uploadLimits.maxImageSize",
      { value: MAX_IMAGE_SIZE * 2 },
      { deps: fsDeps },
    );
    expect(capWrite.ok, capWrite.ok ? "" : capWrite.error).toBe(true);
    // The cap alone never reaches a live transport: no rebind, no setter.
    expect(await transportRefuses(host.port(), frame(filler))).toBe(true);

    const move = await applyConfigKeyEdit(host.core, "webui.port", { value: to }, { deps: fsDeps });
    expect(move.ok, move.ok ? "" : move.error).toBe(true);
    await until(() => host.port() === to, "the rebind after the cap change");
    expect(await transportRefuses(host.port(), frame(filler))).toBe(false);
  });

  it("an unchanged port value promises no drop: rebind is an act, not a class the table hands out", async () => {
    // The table gives this key the rebind class; the reply may only claim the
    // ACT when the value actually moved. Writing back the port that is already
    // listening must not promise a disconnect, must not schedule a listener
    // move, and must not burn the rebind's notices.
    const port = host.port();
    const res = await applyConfigKeyEdit(host.core, "webui.port", { value: port }, { deps: fsDeps });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (res.ok) {
      expect(res.applied).toBe("live");
      expect(res.needsRestart).toBe(false);
      const text = JSON.stringify(res.appliedNotices ?? []);
      expect(text).not.toContain("expect a brief drop");
      expect(text).toContain("nothing had to be rebound");
    }
    // Past the deferral window a real move would have used: same listener,
    // still answering.
    await Bun.sleep(80);
    expect(host.port()).toBe(port);
    expect(await verify(host.baseUrl(), "nope")).toBe(401);
  });

  it("dispose() takes the hooks with it: a stopped host answers restart-required for its own key", async () => {
    const hooked = () => registeredHooks().filter((h) => h.keyPath === "webui.port" || h.keyPath === "webui");
    expect(hooked().length).toBe(3); // the rebind row + the shared auth pair

    host.webui.dispose();
    expect(hooked()).toEqual([]);

    const res = await applyConfigKeyEdit(
      host.core,
      "webui.port",
      { value: await sparePort() },
      { deps: fsDeps },
    );
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (res.ok) {
      expect(res.applied).toBe("restart-required");
      expect(JSON.stringify(res.appliedNotices ?? [])).toContain("no live holder");
    }
    // Idempotent: the shutdown path may be entered more than once.
    host.webui.dispose();
  });
});

/**
 * Send one frame over a fresh socket and report whether the TRANSPORT refused
 * it. A refused frame kills the socket with no application frame in answer; a
 * frame the bound accepts reaches the websocket layer, which always answers
 * (this probe names a session that does not exist, so the answer is an error
 * frame -- the point is only that the application saw the bytes at all).
 */
async function transportRefuses(port: number, frame: string): Promise<boolean> {
  const base = `http://127.0.0.1:${port}`;
  const ws = new WebSocket(base.replace("http", "ws") + "/ws", { headers: { Origin: base } } as never);
  const verdict = new Promise<"answered" | "closed">((resolve) => {
    let sent = false;
    ws.onmessage = (ev) => {
      const text = String(ev.data);
      // The attach greeting arrives before anything was sent; the probe frame
      // goes out behind it so every later close is attributable to the size.
      if (!sent && text.includes('"authRequired"')) {
        sent = true;
        ws.send(frame);
        return;
      }
      resolve("answered");
    };
    ws.onclose = () => resolve("closed");
    ws.onerror = () => resolve("closed");
  });
  const outcome = await Promise.race([verdict, Bun.sleep(5000).then(() => "closed" as const)]);
  try {
    ws.close();
  } catch {
    /* already gone */
  }
  return outcome === "closed";
}
