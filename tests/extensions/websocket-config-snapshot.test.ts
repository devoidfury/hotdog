// Config-snapshot handler tests (settings viewer): redaction, findings,
// layer slots, requestId correlation, reply-only-to-requesting-socket, and
// the auth gate (configSnapshot is dispatched through the existing gate in
// message-routing.ts -- it fires BEFORE the handler table, so the gate test
// proves the new message type inherits it).
//
// The redaction sweep is one big assertion: every secret-shaped value in the
// fixture carries a distinctive SENTINEL token, and none of those tokens may
// appear anywhere in the JSON-serialized reply (file values, env values,
// resolved values, provider keys, unknown-key values alike).

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TMP_PARENT } from "../mocks/io.ts";
import { routeMessage } from "@extensions/websocket/message-routing.ts";
import { handleConfigSnapshot, buildConfigSnapshot } from "@extensions/websocket/handlers-config.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import type { AuthMiddleware } from "@extensions/websocket/auth.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import { createWsMockWs } from "../mocks/websocket.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TMP = mkdtempSync(join(TMP_PARENT, "hotdog-cfgsnap-"));

// Distinctive sentinels: each SECRET-shaped slot in the fixture carries a
// different one, so the sweep also proves WHICH layer leaked if any does.
// (Owner ruling 2026-11-09, ALL-the-settings editor: NON-secret values --
// including unknown file-only keys' values -- legitimately ride rows now;
// the sweep's contract is secrets, exactly as isSecretConfigPath defines.)
const SENTINELS = [
  "SENTINEL-FILE-API", // defaults.json apiKey
  "SENTINEL-ENV-API", // HOTDOG_API_KEY
  "SENTINEL-RESOLVED-API", // core.resolved.apiKey
  "SENTINEL-WEBUI-FILE", // defaults.json webui.apiKey (via core.config)
  "SENTINEL-WEBUI-ENV", // HOTDOG_WEBUI_API_KEY
  "SENTINEL-PROV-RUN", // core.config.providers[0].apiKey (runtime shape)
  "SENTINEL-UNKNOWN-TOKEN", // value of an UNKNOWN secret-shaped key (rides no row)
  "SENTINEL-PASS", // X-ADMIN-PASS inside a container value
  "SENTINEL-CERT", // X-DB-CERT inside a container value
  "SENTINEL-CREDS", // X-AWS-CREDS inside a container value
  "SENTINEL-URLAUTH", // basic-auth userinfo inside a provider url
  "SENTINEL-ENVNAME", // secret-shaped env var NAME behind a non-secret key
  "SENTINEL-BODY", // profile body text (systemPrompt) -- structure shows, prose does not
];

const CONFIG_TEXT = `{
  // a comment (JSONC) -- rescue fix repairs this
  "apiKey": "SENTINEL-FILE-API",
  "theme": "dark",
  "themee": "glow",
  "theme": "light",
  "bashTool": { "maxToolOutputLines": 4000 },
  "webui": { "port": 4321, "apiKey": "SENTINEL-WEBUI-FILE", "headers": { "X-ADMIN-PASS": "SENTINEL-PASS", "X-DB-CERT": "SENTINEL-CERT", "X-AWS-CREDS": "SENTINEL-CREDS" } },
  "myFtToken": "SENTINEL-UNKNOWN-TOKEN"
}
`;

// Mirrors the webui extension's real configSchema entry (layers on the key,
// apiKey with its env source, plain-default siblings).
const WEBUI_SCHEMA = {
  type: "object",
  properties: {
    port: { type: "number", default: 3000, description: "WebUI server port" },
    apiKey: {
      type: "string",
      default: null,
      description: "API key for login authentication.",
      layers: [
        { source: "config", key: "webui.apiKey" },
        { source: "env", key: "HOTDOG_WEBUI_API_KEY" },
        { default: null },
      ],
    },
    sessionTokenTtlMin: { type: "number", default: 1440, description: "Session token TTL in minutes" },
    headers: { type: "object", default: {}, description: "Extra response headers (container walk)" },
    loginCache: {
      type: "string",
      default: null,
      description: "Login cache namespace (env var name is secret-shaped).",
      // The config layer is what keeps this row in the snapshot: a leaf whose
      // only layers are env + default is unreachable from settings.json, so it
      // ships no row at all (notFileResolvable) and this probe would have
      // nothing to read. The env-name redaction being pinned is unchanged.
      layers: [
        { source: "env", key: "HOTDOG_LOGIN_TOKEN" },
        { source: "config", key: "webui.loginCache" },
        { default: null },
      ],
    },
  },
  layers: [{ source: "config", key: "webui" }, { default: {} }],
};

function fakeCore(configDir: string): CoreContext {
  return {
    // The merged/loaded config the running server holds (extension keys are
    // the resolved blocks; providers ride as the passthrough array).
    config: {
      theme: "light",
      webui: { port: 4321, apiKey: "SENTINEL-WEBUI-FILE", sessionTokenTtlMin: 1440, headers: { "X-ADMIN-PASS": "SENTINEL-PASS", "X-DB-CERT": "SENTINEL-CERT", "X-AWS-CREDS": "SENTINEL-CREDS" } },
      profiles: {
        manager: { model: "m1", systemPrompt: "SENTINEL-BODY " + "p".repeat(300) },
        bare: {},
      },
      providers: [
        { name: "p1", url: "http://127.0.0.1:8000/v1", apiKey: "SENTINEL-PROV-RUN", models: [{ name: "m1" }] },
        { name: "p2", url: "http://127.0.0.1:8001/v1", models: [{ name: "m9" }] },
        { name: "p3", url: "http://user:SENTINEL-URLAUTH@proxy.internal:3128/v1", models: [{ name: "m3" }] },
      ],
    },
    configRegistry: {
      getConfigParams: () => [
        { key: "webui", description: "", defaults: {}, schema: WEBUI_SCHEMA, layers: WEBUI_SCHEMA.layers },
      ],
      getCliFlags: () => [],
    },
    resolved: { configDir, theme: "light", apiKey: "SENTINEL-RESOLVED-API" },
  } as unknown as CoreContext;
}

const bridgeStub = {
  peek: () => null,
  cancel: () => {},
  answer: () => false,
  clear: () => {},
} as unknown as WebSocketQuestionBridge;

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

let core: CoreContext;

beforeAll(() => {
  writeFileSync(join(TMP, "defaults.json"), CONFIG_TEXT);
  core = fakeCore(TMP);
  process.env.HOTDOG_API_KEY = "SENTINEL-ENV-API";
  process.env.HOTDOG_WEBUI_API_KEY = "SENTINEL-WEBUI-ENV";
  process.env.HOTDOG_LOGIN_TOKEN = "SENTINEL-ENVNAME";
});

afterAll(() => {
  delete process.env.HOTDOG_API_KEY;
  delete process.env.HOTDOG_WEBUI_API_KEY;
  delete process.env.HOTDOG_LOGIN_TOKEN;
  rmSync(TMP, { recursive: true, force: true });
});

// ── Redaction is the whole ballgame ──────────────────────────────────────────

describe("configSnapshot redaction", () => {
  it("no sentinel value appears anywhere in the serialized reply", async () => {
    const ws = createWsMockWs();
    await handleConfigSnapshot({ ws, msg: { type: C2S.CONFIG_SNAPSHOT, requestId: 1 }, registry: {} as never, authMiddleware: undefined, bridge: bridgeStub, core });
    expect(ws.messages).toHaveLength(1);
    const reply = ws.messages[0]!;
    for (const s of SENTINELS) {
      expect(reply.includes(s)).toBe(false);
    }
    // And the parse error / file bytes never ride either: the reply carries no
    // raw config text (the file's comment line is a fingerprint).
    expect(reply.includes("rescue fix repairs")).toBe(false);
  });

  it("secret rows carry redacted:true + null values; the leaf-secret marker rides", async () => {
    const payload = await buildConfigSnapshot(core);
    const coreKeyRow = payload.sections.find((s) => s.name === "core")!.rows.find((r) => r.key === "apiKey")!;
    expect(coreKeyRow.leafSecret).toBe(true);
    expect(coreKeyRow.redacted).toBe(true);
    expect(coreKeyRow.resolved).toBeNull();
    expect(coreKeyRow.file).toBeNull();
    // The env slot attests SET without shipping the value.
    expect(coreKeyRow.env).toBeDefined();
    expect(coreKeyRow.env!.set).toBe(true);
    expect(coreKeyRow.env!.source).toBe("HOTDOG_API_KEY");
    expect("value" in coreKeyRow.env!).toBe(false);

    const webuiRow = payload.sections.find((s) => s.name === "webui")!.rows.find((r) => r.key === "webui.apiKey")!;
    expect(webuiRow.leafSecret).toBe(true);
    expect(webuiRow.redacted).toBe(true);
    expect(webuiRow.env!.source).toBe("HOTDOG_WEBUI_API_KEY");
    expect("value" in webuiRow.env!).toBe(false);

    // providers.*.apiKey: set provider redacted, unset provider not.
    const provRows = payload.sections.find((s) => s.name === "providers")!.rows;
    const p1key = provRows.find((r) => r.key === "providers.p1.apiKey")!;
    expect(p1key.leafSecret).toBe(true);
    expect(p1key.redacted).toBe(true);
    const p2key = provRows.find((r) => r.key === "providers.p2.apiKey")!;
    expect(p2key.leafSecret).toBe(true);
    expect(p2key.redacted).toBeUndefined();
  });

  it("unset secret distinguishes from set (env set:false, no redacted)", async () => {
    // webui.apiKey WITHOUT its env set and without a file value: the row
    // still exists (leaf-secret) but is honest about being unset. (The main
    // fixture file sets webui.apiKey, so this probe needs its own empty dir.)
    delete process.env.HOTDOG_WEBUI_API_KEY;
    const emptyDir = mkdtempSync(join(TMP_PARENT, "hotdog-cfgsnap-unset-"));
    try {
      const bare = fakeCore(emptyDir) as unknown as { config: Record<string, unknown> };
      bare.config = { providers: [] }; // no webui block at all: nothing sets the key
      const payload = await buildConfigSnapshot(bare as unknown as CoreContext);
      const row = payload.sections.find((s) => s.name === "webui")!.rows.find((r) => r.key === "webui.apiKey")!;
      expect(row.leafSecret).toBe(true);
      expect(row.redacted).toBeUndefined();
      expect(row.env).toEqual({ set: false, source: "HOTDOG_WEBUI_API_KEY" });
    } finally {
      process.env.HOTDOG_WEBUI_API_KEY = "SENTINEL-WEBUI-ENV";
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ── Key-level findings (rescue machinery, no values) ────────────────────────

describe("configSnapshot findings", () => {
  it("unknown key: key + line + did-you-mean, never the value", async () => {
    const payload = await buildConfigSnapshot(core);
    const unknown = payload.findings.find((f) => f.type === "unknown-key" && f.key === "themee");
    expect(unknown).toBeDefined();
    expect(unknown!.line).toBe(5);
    expect(unknown!.didYouMean).toContain("theme");
    // The finding object itself serializes without the value (the ROW for
    // the unknown key carries it -- ALL-the-settings; the FINDINGS never do).
    expect(JSON.stringify(unknown).includes("glow")).toBe(false);
  });

  it("duplicate key points at both lines", async () => {
    const payload = await buildConfigSnapshot(core);
    const dup = payload.findings.find((f) => f.type === "duplicate-key" && f.key === "theme");
    expect(dup).toBeDefined();
    expect(dup!.firstLine).toBe(4);
    expect(dup!.line).toBe(6);
  });

  it("removed key tombstones at ANY nesting depth", async () => {
    const payload = await buildConfigSnapshot(core);
    const removed = payload.findings.find((f) => f.type === "removed-key" && f.key === "maxToolOutputLines");
    expect(removed).toBeDefined();
    expect(removed!.message).toContain("maxToolResultChars");
  });

  it("broken JSONC file: status broken, kinds + line numbers, fixable", async () => {
    const payload = await buildConfigSnapshot(core);
    expect(payload.configDir).toBe(TMP);
    expect(payload.files).toHaveLength(1);
    const file = payload.files[0]!;
    expect(file.inUse).toBe(true);
    expect(file.status).toBe("broken");
    expect(file.fixable).toBe(true);
    expect(file.parseError).toBeTruthy();
    const comment = file.jsoncIssues!.find((i) => i.kind === "comment");
    expect(comment!.lines).toEqual([2]);
  });

  it("missing config file reports status missing", async () => {
    const emptyDir = mkdtempSync(join(TMP_PARENT, "hotdog-cfgsnap-missing-"));
    try {
      const payload = await buildConfigSnapshot(fakeCore(emptyDir));
      expect(payload.files[0]!.status).toBe("missing");
      expect(payload.files[0]!.path).toBe(join(emptyDir, "defaults.json"));
      expect(payload.findings).toEqual([]);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ── Layer slots ──────────────────────────────────────────────────────────────

describe("configSnapshot layer slots", () => {
  it("default / file / resolved slots; env omitted when undeclared", async () => {
    const payload = await buildConfigSnapshot(core);
    const ttl = payload.sections.find((s) => s.name === "webui")!.rows.find((r) => r.key === "webui.sessionTokenTtlMin")!;
    expect(ttl.default).toBe(1440);
    // No env layer in the schema => no env slot at all (never invented).
    expect("env" in ttl).toBe(false);
    // Resolved rides the merged extension block (the truth the extension reads).
    expect(ttl.resolved).toBe(1440);
  });

  it("cli attestation: only a flag literally present in the argv ships a cli slot", async () => {
    const withFlag = await buildConfigSnapshot(core, { argv: ["bun", "hotdog", "--tokens", "webui"] });
    const row = withFlag.sections.find((s) => s.name === "core")!.rows.find((r) => r.key === "showTokenUse")!;
    expect(row.cli).toEqual({ flag: "--tokens", value: true });

    const withoutFlag = await buildConfigSnapshot(core, { argv: ["bun", "hotdog", "webui"] });
    const row2 = withoutFlag.sections.find((s) => s.name === "core")!.rows.find((r) => r.key === "showTokenUse")!;
    expect("cli" in row2).toBe(false);
  });

  it("an explicit --config on the argv re-points the in-use file", async () => {
    const otherDir = mkdtempSync(join(TMP_PARENT, "hotdog-cfgsnap-explicit-"));
    const explicit = join(otherDir, "custom.json");
    writeFileSync(explicit, '{ "theme": "light" }');
    try {
      const payload = await buildConfigSnapshot(fakeCore(TMP), { argv: ["bun", "hotdog", "--config", explicit] });
      expect(payload.files[0]!.path).toBe(explicit);
      expect(payload.files[0]!.status).toBe("ok");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("long string values truncate with the marker", async () => {
    const fatCore = fakeCore(TMP) as unknown as { config: Record<string, unknown> };
    // systemPromptTemplate, not `prompt`: the prose-shaped key the panel can
    // actually reach (prompt declares no config layer, so it ships no row).
    fatCore.config.systemPromptTemplate = "P".repeat(5000);
    const payload = await buildConfigSnapshot(fatCore as unknown as CoreContext);
    const row = payload.sections.find((s) => s.name === "core")!.rows.find((r) => r.key === "systemPromptTemplate")!;
    expect(typeof row.resolved).toBe("string");
    expect((row.resolved as string).length).toBeLessThan(5000);
    expect((row.resolved as string).endsWith("...[truncated]")).toBe(true);
  });
});

// ── Correlation, socket scoping, and the auth gate ──────────────────────────

describe("configSnapshot plumbing", () => {
  it("requestId is echoed; a second socket receives nothing", async () => {
    const wsA = createWsMockWs();
    const wsB = createWsMockWs();
    await routeMessage(wsA, { type: C2S.CONFIG_SNAPSHOT, requestId: 42 } as never, {} as never, undefined, bridgeStub, core);
    await flush();
    expect(wsA.messages).toHaveLength(1);
    const parsed = JSON.parse(wsA.messages[0]!) as Record<string, unknown>;
    expect(parsed.type).toBe(S2C.CONFIG_SNAPSHOT_RESULT);
    expect(parsed.requestId).toBe(42);
    expect(parsed.ts).toBeNumber();
    expect(wsB.messages).toHaveLength(0);
  });

  it("the auth gate fires BEFORE dispatch: pre-auth configSnapshot gets auth_required, never a snapshot", async () => {
    const auth = { validateToken: (t: string) => t === "good" } as unknown as AuthMiddleware;
    const anon = createWsMockWs();
    await routeMessage(anon, { type: C2S.CONFIG_SNAPSHOT, requestId: 7 } as never, {} as never, auth, bridgeStub, core);
    await flush();
    expect(anon.messages).toHaveLength(1);
    const parsed = JSON.parse(anon.messages[0]!) as Record<string, unknown>;
    expect(parsed.type).toBe(S2C.AUTH_ERROR);
    expect(parsed.code).toBe("auth_required");

    const authed = createWsMockWs();
    authed.authToken = "good";
    await routeMessage(authed, { type: C2S.CONFIG_SNAPSHOT, requestId: 7 } as never, {} as never, auth, bridgeStub, core);
    await flush();
    expect(authed.messages).toHaveLength(1);
    expect(JSON.parse(authed.messages[0]!).type).toBe(S2C.CONFIG_SNAPSHOT_RESULT);
  });
});

// ── Wire-surface hardening (judge follow-ups 2026-11-09) ────────────────────

describe("configSnapshot wire-surface hardening", () => {
  it("secret-shaped entries inside a container value null out on every short suffix", async () => {
    const payload = await buildConfigSnapshot(core);
    const row = payload.sections.find((s) => s.name === "webui")!.rows.find((r) => r.key === "webui.headers")!;
    expect(row.redacted).toBe(true);
    for (const slot of [row.file, row.resolved]) {
      const headers = slot as Record<string, unknown>;
      expect(headers["X-ADMIN-PASS"]).toBeNull();
      expect(headers["X-DB-CERT"]).toBeNull();
      expect(headers["X-AWS-CREDS"]).toBeNull();
    }
  });

  it("URL userinfo is scrubbed; a plain url rides untouched", async () => {
    const payload = await buildConfigSnapshot(core);
    const rows = payload.sections.find((s) => s.name === "providers")!.rows;
    expect(rows.find((r) => r.key === "providers.p3.url")!.resolved).toBe("http://***@proxy.internal:3128/v1");
    expect(rows.find((r) => r.key === "providers.p1.url")!.resolved).toBe("http://127.0.0.1:8000/v1");
  });

  it("a secret-shaped env var NAME redacts its slot behind a non-secret key path", async () => {
    const payload = await buildConfigSnapshot(core);
    const row = payload.sections.find((s) => s.name === "webui")!.rows.find((r) => r.key === "webui.loginCache")!;
    expect(row.leafSecret).toBeUndefined(); // the key path itself is not secret-shaped
    expect(row.redacted).toBe(true);
    expect(row.env).toEqual({ set: true, source: "HOTDOG_LOGIN_TOKEN", value: null });
  });

  it("a parse error quotes nothing: a file broken after boot cannot echo its bytes", async () => {
    const echoDir = mkdtempSync(join(TMP_PARENT, "hotdog-cfgsnap-echo-"));
    const echoFile = join(echoDir, "defaults.json");
    // A bare identifier is what engines quote ("Unexpected identifier X");
    // scrubbing must survive the engine-specific message shape.
    writeFileSync(echoFile, '{ "theme": BARESENTINEL }');
    try {
      const payload = await buildConfigSnapshot(fakeCore(TMP), { argv: ["bun", "hotdog", "--config", echoFile] });
      const file = payload.files.find((f) => f.path === echoFile)!;
      expect(file.status).toBe("broken");
      expect(file.parseError).toBeTruthy(); // the diagnosis survives...
      expect(file.parseError).not.toContain("BARESENTINEL"); // ...the echo does not
      expect(JSON.stringify(payload).includes("BARESENTINEL")).toBe(false);
    } finally {
      rmSync(echoDir, { recursive: true, force: true });
    }
  });

  it("profile bodies are omitted inside container values; structure survives", async () => {
    const payload = await buildConfigSnapshot(core);
    const row = payload.sections.find((s) => s.name === "core")!.rows.find((r) => r.key === "profiles")!;
    const profiles = row.resolved as Record<string, Record<string, unknown>>;
    expect(profiles.bare).toEqual({});
    expect(profiles.manager!.model).toBe("m1"); // short scalars ride
    expect(String(profiles.manager!.systemPrompt)).toMatch(/^\[\d+-char text omitted\]$/);
    // And a top-level long string keeps the OLD truncation posture (the
    // "systemPromptTemplate" test in layer slots) -- the stub is
    // container-members only.
  });

  it("unknown file-only keys become ROWS: non-secret rides stamped, secret-shaped redacts to a writeOnly box", async () => {
    const payload = await buildConfigSnapshot(core);
    const all = payload.sections.flatMap((s) => s.rows);
    const themee = all.find((r) => r.key === "themee")!;
    expect(themee).toBeDefined();
    expect(themee.file).toBe("glow"); // the file value rides (it is config data, not a credential)
    expect(themee.edit).toEqual({ type: "string" }); // editable: unknown keys are REAL rows now
    // ...while the same name-based rule nulls a secret-shaped unknown value,
    // and the sweep above proved SENTINEL-UNKNOWN-TOKEN is nowhere in the reply.
    const ft = all.find((r) => r.key === "myFtToken")!;
    expect(ft).toBeDefined();
    expect(ft.leafSecret).toBe(true);
    expect(ft.file).toBeNull();
    expect(ft.redacted).toBe(true);
    expect(ft.edit).toEqual({ type: "string", writeOnly: true });
    // And the duplicate "theme" (twice in the file) stays un-stamped: the
    // locator refuses to guess which occurrence it would splice.
    const theme = all.find((r) => r.key === "theme")!;
    expect(theme.edit).toBeUndefined();
  });

  it("non-secret keys keep their values (anti-over-redaction pin)", async () => {
    const payload = await buildConfigSnapshot(core);
    const port = payload.sections.find((s) => s.name === "webui")!.rows.find((r) => r.key === "webui.port")!;
    expect(port.resolved).toBe(4321);
    expect(port.file).toBe(4321);
    expect(port.default).toBe(3000);
    expect("redacted" in port).toBe(false);
    expect("leafSecret" in port).toBe(false);
    const theme = payload.sections.find((s) => s.name === "core")!.rows.find((r) => r.key === "theme")!;
    expect(theme.resolved).toBe("light");
    expect("redacted" in theme).toBe(false);
  });
});
