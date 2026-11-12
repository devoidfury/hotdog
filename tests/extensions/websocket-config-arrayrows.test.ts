// ARRAY LIST chrome + element rows (settings editor server half). Pins the
// generalized provider-card doctrine (owner ruling 2026-11-11): every
// primitive-valued array (file-only, schema-declared with or WITHOUT typed
// items, provider-child, secret-shaped) ships as one CHROME row (the field's
// own row, arrayChrome:true, NO edit stamp -- a wholesale write to it is
// refused server-side) plus one stamped row per element (`field[i]`). The
// element rows are the editors; +/- ride editConfigList (append the array path
// with a typed `value`, remove `<array>[<index>]` by INDEX). Probes the exact
// refusals, the byte discipline, the items gates (type/enum/bounds -- via an
// extension-registered schema, since no core array declares items today) and
// the truncation honesty. Everything rides TEMP config dirs; zero /tmp litter.

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { TMP_PARENT } from "../mocks/io.ts";
import { stripJsonc } from "@core/config/rescue.ts";
import {
  buildConfigSnapshot,
  applyConfigKeyEdit,
  applyConfigListEdit,
  handleConfigListEdit,
} from "@extensions/websocket/handlers-config.ts";
import { C2S, S2C, MAX_CONFIG_ROWS } from "@extensions/websocket/protocol.ts";
import { CONFIG_SCHEMA } from "@core/config/schema-loader.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import { createWsMockWs } from "../mocks/websocket.ts";

/** Fake core with optional extension-registered config params (the unified
 *  schema walk merges them exactly like the running server does). */
function fakeCore(configDir: string, params: unknown[] = []): CoreContext {
  return {
    config: {},
    configRegistry: { getConfigParams: () => params, getCliFlags: () => [] },
    resolved: { configDir },
  } as unknown as CoreContext;
}

const bridgeStub = { peek: () => null, cancel: () => {}, answer: () => false, clear: () => {} } as unknown as WebSocketQuestionBridge;

let dirCounter = 0;
const tempDirs: string[] = [];
function tempDir(): string {
  dirCounter++;
  const dir = mkdtempSync(join(TMP_PARENT, `hotdog-arrayrows-${dirCounter}-`));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const cfgFile = (dir: string) => join(dir, "defaults.json");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function dirWith(text: string): string {
  const dir = tempDir();
  writeFileSync(cfgFile(dir), text);
  return dir;
}
function parseLoose(text: string): Record<string, unknown> {
  return JSON.parse(stripJsonc(text).text) as Record<string, unknown>;
}
const rowsOf = (payload: Awaited<ReturnType<typeof buildConfigSnapshot>>) =>
  payload.sections.flatMap((s) => s.rows);
const rowIn = (payload: Awaited<ReturnType<typeof buildConfigSnapshot>>, key: string) =>
  rowsOf(payload).find((r) => r.key === key);

/** The chrome doctrine's fixture: a schema-declared list the FILE defines
 *  (workspace.deny -- whose schema declares NO items key, the §1 finding: a
 *  schema-only rule would silently miss it), an empty array, an absent schema
 *  list, a secret-shaped array, a provider-child list, an unknown file-only
 *  array, and a scalar. */
const CHIP = `{
  // leading comment survives
  "workspace": {
    "deny": [
      "alpha", // inline alpha
      "beta"
    ]
  },
  "extensionPaths": [],
  "myTags": ["hot", "dog"],
  "modelApiKey": ["SENTINEL-KEY-ONE", "SENTINEL-KEY-TWO"],
  "providers": [
    { "name": "p1", "url": "http://127.0.0.1:8000/v1", "apiKey": "SENT-PROV-KEY", "models": ["m1", "m2"] }
  ],
  "widget": "glow"
}
`;

// The typed-items tripwire: NO core schema array declares items today (deny,
// extensionPaths and extensions declare none), so the value-shape fallback is
// what ships the element stamps for core lists; the extension-seeded params
// below are the ONLY end-to-end exercise of schema items in this repo.
describe("snapshot: LIST chrome + element rows", () => {
  it("workspace.deny (schema list, NO items declared) ships chrome + value-shape-stamped element rows", async () => {
    expect(CONFIG_SCHEMA["workspace"]!.properties!.deny!.items).toBeUndefined();
    const payload = await buildConfigSnapshot(fakeCore(dirWith(CHIP)));
    const chrome = rowIn(payload, "workspace.deny")!;
    expect(chrome.arrayChrome).toBe(true);
    expect(chrome.edit, "the chrome row carries NO stamp (its write is refused)").toBeUndefined();
    expect(chrome.file).toEqual(["alpha", "beta"]);
    // The element rows ride their own per-layer slots (the schema DEFAULT
    // array lines up per element; the FILE array is the editor's seed).
    const e0 = rowIn(payload, "workspace.deny[0]")!;
    expect(e0.file).toBe("alpha");
    expect(e0.default).toBe(".ssh"); // the schema DEFAULT array lines up per element
    expect("resolved" in e0, "no resolved layer attests here (fake core): the slot rides omitted, never fabricated").toBe(false);
    expect(e0.edit).toEqual({ type: "string" }); // runtime SHAPE: items is absent
    expect(rowIn(payload, "workspace.deny[1]")!.edit).toEqual({ type: "string" });
    // No `.*`-sentinel chrome rows exist in this wire (chrome is the field row
    // itself): pin the shape the client renders against.
    expect(rowsOf(payload).some((r) => r.key.endsWith(".*"))).toBe(false);
  });

  it("an unknown file-only array chrome's the same way (myTags)", async () => {
    const payload = await buildConfigSnapshot(fakeCore(dirWith(CHIP)));
    expect(rowIn(payload, "myTags")!.arrayChrome).toBe(true);
    expect(rowIn(payload, "myTags")!.edit).toBeUndefined();
    expect(rowIn(payload, "myTags[0]")!.edit).toEqual({ type: "string" });
    expect(rowIn(payload, "myTags[1]")!.file).toBe("dog");
  });

  it("extension-declared typed items ride the element stamp (integer min/max, string enum)", async () => {
    const ports = {
      key: "ports",
      schema: { type: "array", layers: [{ source: "config", key: "ports" }], items: { type: "integer", minimum: 1, maximum: 256 } },
    };
    const modes = {
      key: "modes",
      schema: { type: "array", layers: [{ source: "config", key: "modes" }], items: { type: "string", enum: ["fast", "slow"] } },
    };
    const dir = dirWith(`{\n  "ports": [80, 443],\n  "modes": ["fast"]\n}\n`);
    const payload = await buildConfigSnapshot(fakeCore(dir, [ports, modes]));
    expect(rowIn(payload, "ports")!.arrayChrome).toBe(true);
    expect(rowIn(payload, "ports[0]")!.edit).toEqual({ type: "integer", minimum: 1, maximum: 256 });
    expect(rowIn(payload, "ports[1]")!.edit).toEqual({ type: "integer", minimum: 1, maximum: 256 });
    expect(rowIn(payload, "modes[0]")!.edit).toEqual({ type: "string", enum: ["fast", "slow"] });
  });

  it("EMPTY array ships chrome + zero elements; an ABSENT schema list ships chrome alone; append creates it", async () => {
    const dir = dirWith(CHIP);
    const payload = await buildConfigSnapshot(fakeCore(dir));
    expect(rowIn(payload, "extensionPaths")!.arrayChrome).toBe(true);
    expect(rowsOf(payload).some((r) => r.key.startsWith("extensionPaths["))).toBe(false);
    expect(rowIn(payload, "extensions")!.arrayChrome).toBe(true); // absent from the file
    expect(rowsOf(payload).some((r) => r.key.startsWith("extensions["))).toBe(false);
    const res = await applyConfigListEdit(fakeCore(dir), "extensions", "append", { value: "compaction" });
    expect(res.ok).toBe(true);
    expect(parseLoose(readFileSync(cfgFile(dir), "utf-8")).extensions).toEqual(["compaction"]);
  });

  it("a SECRET-SHAPED array ships chrome + writeOnly element rows with ZERO bytes", async () => {
    const payload = await buildConfigSnapshot(fakeCore(dirWith(CHIP)));
    const json = JSON.stringify(payload);
    expect(json.includes("SENTINEL-KEY-ONE")).toBe(false);
    expect(json.includes("SENTINEL-KEY-TWO")).toBe(false);
    const chrome = rowIn(payload, "modelApiKey")!;
    expect(chrome.arrayChrome).toBe(true);
    expect(chrome.leafSecret).toBe(true);
    expect(chrome.file).toBeNull();
    expect(chrome.redacted).toBe(true);
    expect(chrome.edit, "no bulk-REPLACE on a chrome'd array -- the box moved to the elements").toBeUndefined();
    expect(rowIn(payload, "modelApiKey[0]")!.edit).toEqual({ type: "string", writeOnly: true });
    expect(rowIn(payload, "modelApiKey[1]")!.file).toBeNull();
  });

  it("the provider child providers[0].models gets the SAME generic machinery (card posture kept for the card rows)", async () => {
    const dir = dirWith(CHIP);
    const payload = await buildConfigSnapshot(fakeCore(dir));
    expect(rowIn(payload, "providers[0]")!.edit, "the card header stays chrome").toBeUndefined();
    expect(rowIn(payload, "providers[0].models")!.arrayChrome).toBe(true);
    expect(rowIn(payload, "providers[0].models")!.edit).toBeUndefined();
    expect(rowIn(payload, "providers[0].models[0]")!.edit).toEqual({ type: "string" });
    expect(rowIn(payload, "providers[0].models[1]")!.file).toBe("m2");
    // Generic append rides the nested path too (the shape gate, no schema).
    const res = await applyConfigListEdit(fakeCore(dir), "providers[0].models", "append", { value: "m3" });
    expect(res.ok).toBe(true);
    const provs = parseLoose(readFileSync(cfgFile(dir), "utf-8")).providers as Array<Record<string, unknown>>;
    expect(provs[0]!.models).toEqual(["m1", "m2", "m3"]);
    expect(provs[0]!.apiKey, "the element's other bytes are untouched").toBe("SENT-PROV-KEY");
  });
});

describe("chrome gate: the stamp predicate IS the write gate", () => {
  it("a wholesale write to any chrome'd field refuses, naming the element rows and the list ops -- zero change", async () => {
    const dir = dirWith(CHIP);
    const core = fakeCore(dir);
    const before = sha(cfgFile(dir));
    for (const key of ["workspace.deny", "myTags", "providers[0].models", "modelApiKey"]) {
      const res = await applyConfigKeyEdit(core, key, { valueText: '["bulk"]' });
      expect(res.ok, `${key} must refuse its bulk write`).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain("array-list chrome row");
        expect(res.error).toContain(`${key}[0]`); // names the element rows
        expect(res.error).toContain("append/remove"); // names the list ops
      }
    }
    expect(sha(cfgFile(dir))).toBe(before);
    expect(readdirSync(dir)).toEqual(["defaults.json"]);
  });

  it("an element write splices exactly that element; comments and siblings survive byte-identical", async () => {
    const dir = dirWith(CHIP);
    const res = await applyConfigKeyEdit(fakeCore(dir), "workspace.deny[1]", { value: "beta2" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.needsRestart).toBe(true);
      expect(res.value).toBe("beta2"); // the persisted echo, never the client's claim
    }
    expect(readFileSync(cfgFile(dir), "utf-8")).toBe(`{
  // leading comment survives
  "workspace": {
    "deny": [
      "alpha", // inline alpha
      "beta2"
    ]
  },
  "extensionPaths": [],
  "myTags": ["hot", "dog"],
  "modelApiKey": ["SENTINEL-KEY-ONE", "SENTINEL-KEY-TWO"],
  "providers": [
    { "name": "p1", "url": "http://127.0.0.1:8000/v1", "apiKey": "SENT-PROV-KEY", "models": ["m1", "m2"] }
  ],
  "widget": "glow"
}
`);
  });

  it("the items declaration gates element writes (bounds, enum, out-of-range index) with bytes frozen", async () => {
    const ports = {
      key: "ports",
      schema: { type: "array", layers: [{ source: "config", key: "ports" }], items: { type: "integer", minimum: 1, maximum: 256 } },
    };
    const modes = {
      key: "modes",
      schema: { type: "array", layers: [{ source: "config", key: "modes" }], items: { type: "string", enum: ["fast", "slow"] } },
    };
    const dir = dirWith(`{\n  "ports": [80, 443],\n  "modes": ["fast"]\n}\n`);
    const core = fakeCore(dir, [ports, modes]);
    const before = sha(cfgFile(dir));
    const refusals: Array<[string, unknown, string]> = [
      ["ports[0]", 999, "must be <= 256"],
      ["ports[1]", 0, "must be >= 1"],
      ["ports[9]", 2, "no value in the file"], // out-of-range index never creates an element
      ["modes[0]", "off", "must be one of: fast, slow"],
      ["ports[0]", "eighty", "expected a whole number"],
    ];
    for (const [key, value, needle] of refusals) {
      const res = await applyConfigKeyEdit(core, key, { value });
      expect(res.ok, `${key}=${JSON.stringify(value)} must refuse`).toBe(false);
      if (!res.ok) expect(res.error).toContain(needle);
    }
    expect(sha(cfgFile(dir))).toBe(before);
    const ok = await applyConfigKeyEdit(core, "ports[1]", { value: 100 }); // in-bounds: lands
    expect(ok.ok).toBe(true);
    expect(parseLoose(readFileSync(cfgFile(dir), "utf-8")).ports).toEqual([80, 100]);
  });

  it("a secret-shaped element REPLACE lands surgically and echoes ZERO bytes (new or old)", async () => {
    const dir = dirWith(CHIP);
    const res = await applyConfigKeyEdit(fakeCore(dir), "modelApiKey[1]", { valueText: "REPLACED-SECRET" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toBeNull();
      expect(res.redacted).toBe(true);
    }
    const keys = parseLoose(readFileSync(cfgFile(dir), "utf-8")).modelApiKey as string[];
    expect(keys).toEqual(["SENTINEL-KEY-ONE", "REPLACED-SECRET"]); // [0] untouched
  });

  it("an env-shadowed list attests the env layer on the chrome row, ships no element rows, and refuses element writes", async () => {
    process.env.TEST_SHADOW_ARR = '["e1","e2"]';
    try {
      const shadows = {
        key: "shadows",
        // The config layer keeps the row alive: a leaf whose only layers are
        // env + default is unreachable from settings.json and ships no row at
        // all (notFileResolvable), which would leave this probe nothing to
        // read. Env still shadows the file (it stays the FIRST layer), and the
        // file carrying no array keeps the "no element rows" half intact.
        schema: {
          type: "array",
          layers: [{ source: "env", key: "TEST_SHADOW_ARR" }, { source: "config", key: "shadows" }, { default: [] }],
          items: { type: "string" },
        },
      };
      const dir = dirWith(`{\n  "webui": { "port": 3000 }\n}\n`);
      const payload = await buildConfigSnapshot(fakeCore(dir, [shadows]));
      const row = rowIn(payload, "shadows")!;
      expect(row.arrayChrome).toBe(true);
      expect(row.env).toMatchObject({ set: true, source: "TEST_SHADOW_ARR" });
      expect(row.file, "the file owns no array: no element rows ship (the file stays the write target)").toBeUndefined();
      expect(rowsOf(payload).some((r) => r.key.startsWith("shadows["))).toBe(false);
      const res = await applyConfigKeyEdit(fakeCore(dir, [shadows]), "shadows[0]", { value: "hijack" });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("no value in the file");
      expect(readFileSync(cfgFile(dir), "utf-8")).toContain('"port": 3000');
      expect(readFileSync(cfgFile(dir), "utf-8").includes("hijack")).toBe(false);
    } finally {
      delete process.env.TEST_SHADOW_ARR;
    }
  });
});

describe("editConfigList append: typed value, shared validation, honest refusals", () => {
  it("appends the typed value as the LAST element; siblings and comments survive", async () => {
    const dir = dirWith(CHIP);
    const res = await applyConfigListEdit(fakeCore(dir), "workspace.deny", "append", { value: "gamma" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.needsRestart).toBe(true);
    const after = readFileSync(cfgFile(dir), "utf-8");
    expect(after).toContain("// leading comment survives");
    expect(after).toContain("// inline alpha");
    expect(parseLoose(after).workspace).toEqual({ deny: ["alpha", "beta", "gamma"] });
    expect(readdirSync(dir)).toEqual(["defaults.json"]);
  });

  it("the items gates apply (bounds, enum); the element kind rejects mixed types; objects and names refuse", async () => {
    const ports = {
      key: "ports",
      schema: { type: "array", layers: [{ source: "config", key: "ports" }], items: { type: "integer", minimum: 1, maximum: 256 } },
    };
    const modes = {
      key: "modes",
      schema: { type: "array", layers: [{ source: "config", key: "modes" }], items: { type: "string", enum: ["fast", "slow"] } },
    };
    const typedDir = dirWith(`{\n  "ports": [80],\n  "modes": ["fast"]\n}\n`);
    const typed = fakeCore(typedDir, [ports, modes]);
    const typedBefore = sha(cfgFile(typedDir));
    let res = await applyConfigListEdit(typed, "ports", "append", { value: 300 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("must be <= 256");
    res = await applyConfigListEdit(typed, "modes", "append", { value: "off" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("must be one of");
    expect(sha(cfgFile(typedDir))).toBe(typedBefore); // frozen through refusals
    expect((await applyConfigListEdit(typed, "ports", "append", { value: 42 })).ok).toBe(true);
    expect((await applyConfigListEdit(typed, "modes", "append", { value: "slow" })).ok).toBe(true);

    const dir = dirWith(CHIP);
    const core = fakeCore(dir);
    const before = sha(cfgFile(dir));
    res = await applyConfigListEdit(core, "workspace.deny", "append", { value: 5 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("would mix types");
    res = await applyConfigListEdit(core, "workspace.deny", "append", { value: { a: 1 } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("append needs a value (string, number, or boolean)");
    res = await applyConfigListEdit(core, "workspace.deny", "append", { name: "nope" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("takes a value, not a name");
    expect(sha(cfgFile(dir))).toBe(before);
  });

  it("refuses non-array targets WITHOUT replacing user bytes; an undeclared absent array is never invented", async () => {
    const dir = dirWith(CHIP);
    const core = fakeCore(dir);
    const before = sha(cfgFile(dir));
    let res = await applyConfigListEdit(core, "widget", "append", { value: "x" }); // a scalar there
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("present but is not an array");
    const dotDir = dirWith(`{\n  "dottedbad": "a.b.c"\n}\n`);
    res = await applyConfigListEdit(fakeCore(dotDir), "dottedbad", "append", { value: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("fix the block first");
    expect(readFileSync(cfgFile(dotDir), "utf-8")).toBe(`{\n  "dottedbad": "a.b.c"\n}\n`);
    res = await applyConfigListEdit(fakeCore(dirWith(`{}\n`)), "nothere", "append", { value: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("refusing to invent it");
    expect(sha(cfgFile(dir))).toBe(before);
  });

  it("the wire frame carries the typed append end-to-end: requestId-correlated ok + needsRestart, no value echo", async () => {
    const dir = dirWith(CHIP);
    const ws = createWsMockWs();
    await handleConfigListEdit({
      ws,
      msg: { type: C2S.EDIT_CONFIG_LIST, requestId: 23, keyPath: "myTags", op: "append", value: "fresh" },
      registry: {} as never,
      authMiddleware: undefined,
      bridge: bridgeStub,
      core: fakeCore(dir),
    });
    const parsed = JSON.parse(ws.messages[0]!) as Record<string, unknown>;
    expect(parsed.type).toBe(S2C.EDIT_CONFIG_LIST_RESULT);
    expect(parsed.requestId).toBe(23);
    expect(parsed.ok).toBe(true);
    expect(parsed.needsRestart).toBe(true);
    expect("value" in parsed).toBe(false); // no echo channel on list ops
    expect(parseLoose(readFileSync(cfgFile(dir), "utf-8")).myTags).toEqual(["hot", "dog", "fresh"]);
  });
});

describe("editConfigList remove: INDEX-addressed, comment-preserving", () => {
  it("removes ONE occurrence from a duplicate-value array -- by ADDRESS, never by value", async () => {
    const dir = dirWith(`{\n  "workspace": { "deny": [\n    "dup", // first dup\n    "keep",\n    "dup"\n  ] }\n}\n`);
    const res = await applyConfigListEdit(fakeCore(dir), "workspace.deny[0]", "remove", {});
    expect(res.ok).toBe(true);
    // Byte-exact: the same-line comment dies with the removed element (the
    // pinned exception), the survivors and their bytes stay, and which "dup"
    // lives is decided by INDEX.
    expect(readFileSync(cfgFile(dir), "utf-8")).toBe(`{\n  "workspace": { "deny": [\n    "keep",\n    "dup"\n  ] }\n}\n`);
    expect(readdirSync(dir)).toEqual(["defaults.json"]);
  });

  it("refuses an out-of-range index and a disagreeing frame index with zero change", async () => {
    const dir = dirWith(CHIP);
    const core = fakeCore(dir);
    const before = sha(cfgFile(dir));
    let res = await applyConfigListEdit(core, "workspace.deny[7]", "remove", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("no element at index 7");
    res = await applyConfigListEdit(core, "workspace.deny[1]", "remove", { index: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("disagrees");
    res = await applyConfigListEdit(core, "workspace.deny", "remove", { index: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('remove must target "<array>[<index>]"');
    expect(sha(cfgFile(dir))).toBe(before);
  });
});

describe("truncation honesty (no pager)", () => {
  it("a 450-element array hits the row cap: chrome + deny[0] ship FIRST, truncated:true, nothing claims a page", async () => {
    const big = Array.from({ length: 450 }, (_, i) => `"d${i}"`).join(", ");
    const dir = dirWith(`{\n  "workspace": { "deny": [${big}] }\n}\n`);
    const payload = await buildConfigSnapshot(fakeCore(dir));
    const rows = rowsOf(payload);
    expect(rows.length).toBe(MAX_CONFIG_ROWS);
    expect(payload.truncated).toBe(true);
    const chrome = rowIn(payload, "workspace.deny")!;
    expect(chrome.arrayChrome).toBe(true);
    // The chrome row ships BEFORE its elements (the + affordance survives the
    // cut) and deny[0] follows it immediately.
    expect(rows.indexOf(chrome)).toBeLessThan(rows.indexOf(rowIn(payload, "workspace.deny[0]")!));
    expect(rowIn(payload, "workspace.deny[0]")!.file).toBe("d0");
    expect(rowIn(payload, "workspace.deny[449]"), "the cap cut mid-array").toBeUndefined();
    expect((payload as unknown as Record<string, unknown>).nextCursor, "there is no pager").toBeUndefined();
  });
});
