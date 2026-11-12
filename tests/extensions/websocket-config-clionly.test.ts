// Config-file-unreachable settings are HIDDEN (owner ruling 2026-11-11).
// resolveKey walks ONLY a key's declared layers chain, so a leaf whose layers
// never include {source:"config"} can never be affected by defaults.json: the
// CLI-only class resolves from its flag, the default-only class never moves at
// all. Such a leaf ships NO ROW (in core and in every extension section,
// unconditionally -- a flag present in argv retires the row and its cli-slot
// attestation together) and BOTH write gates refuse it before any byte moves.
//
// MID-RUN AMENDMENT (owner ruling 2026-11-11, same day): `envScrubbing` got a
// config layer ({source:"config", key:"envScrubbing"} between the cli falsy
// layer and the default), so it LEFTS the hidden set -- it is now a normal row
// whose file entry works and whose flag overrides it.
//
// INERT-KEY FIX (B0, 2026-11-11): the default-only class is EMPTY. `maxRetries`,
// `toolRetryDelay` and `taskProfile` gained real config layers (with minimum:0
// bounds on the retry pair), so they LEFT the hidden set as normal writable
// rows; `prompt` and `temperature` were RETIRED off the schema entirely (their
// old file bytes now get a REMOVED verdict from rescue's tombstones, and both
// write gates refuse them with the tombstone text naming the replacement).
// The hidden set is TWO keys, both CLI-only.
//
// The pinned set is measured against the LIVE unified schema (core
// CONFIG_SCHEMA + the real bundled extension params, the doc-lint idiom), so a
// schema edit that changes reachability trips this file rather than silently
// shipping a lying row. Everything rides TEMP config dirs under TMP_PARENT with
// an afterAll rmSync; zero /tmp litter, zero real-user config reads.

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { TMP_PARENT } from "../mocks/io.ts";
import {
  buildConfigSnapshot,
  applyConfigKeyEdit,
  applyConfigListEdit,
  notFileResolvable,
} from "@extensions/websocket/handlers-config.ts";
import { buildUnifiedSchema, type ConfigSchema, type SchemaProperty } from "@core/config/schema-loader.ts";
import { getExtensionConfigDefaults } from "@core/extensions/extensions.ts";
import type { CoreContext } from "@core/extensions/types.ts";

/** A file-reachable control key + the TWO hidden ones (the CLI-only class --
 *  the default-only class is gone: B0 gave the trio config layers), as the
 *  schema spells them. envScrubbing is deliberately absent: the mid-run ruling
 *  gave it a config layer (see SCRUBBED below). */
const CLI_ONLY = ["sessionId", "maxToolDifficulty"];
const HIDDEN = [...CLI_ONLY];
/** Revived by B0: config layer + default, normal rows with working writes. */
const REVIVED = ["maxRetries", "toolRetryDelay", "taskProfile"];
/** Retired by B0: OFF the schema; old file bytes are tombstone-owned. */
const RETIRED = ["temperature", "prompt"];
const CONTROL = "maxIterations"; // cli + config + default: a row must keep shipping
const SCRUBBED = "envScrubbing"; // cli > CONFIG > default: a normal row again

function fakeCore(configDir: string, params: unknown[] = []): CoreContext {
  return {
    config: {},
    configRegistry: { getConfigParams: () => params, getCliFlags: () => [] },
    resolved: { configDir },
  } as unknown as CoreContext;
}

let dirCounter = 0;
const tempDirs: string[] = [];
function tempDir(): string {
  dirCounter++;
  const dir = mkdtempSync(join(TMP_PARENT, `hotdog-clionly-${dirCounter}-`));
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
type Payload = Awaited<ReturnType<typeof buildConfigSnapshot>>;
const rowsOf = (payload: Payload) => payload.sections.flatMap((s) => s.rows);
const rowIn = (payload: Payload, key: string) => rowsOf(payload).find((r) => r.key === key);

/** The same leaf walk buildConfigSnapshot uses (objects with declared
 *  properties recurse; everything else is a leaf row). */
function scanLeaves(prefix: string, prop: SchemaProperty, out: Array<{ path: string; prop: SchemaProperty }>): void {
  const props = prop.properties;
  if (props && typeof props === "object" && Object.keys(props).length > 0) {
    for (const [name, child] of Object.entries(props)) scanLeaves(`${prefix}.${name}`, child, out);
    return;
  }
  out.push({ path: prefix, prop });
}

/** The live unified schema: core CONFIG_SCHEMA + the bundled extension params
 *  (both tiers, exactly what unifiedSchemaFor assembles from a registry). */
async function liveSchema(): Promise<ConfigSchema> {
  const params = [
    ...(await getExtensionConfigDefaults(["@extensions"])),
    ...(await getExtensionConfigDefaults(["@experimental"])),
  ];
  const configSchema: Record<string, unknown> = {};
  for (const p of params) if (p.schema && typeof p.schema === "object") configSchema[p.key] = p.schema;
  return buildUnifiedSchema(Object.keys(configSchema).length > 0 ? [{ configSchema }] : undefined);
}

// ── The predicate + the tripwire pin ────────────────────────────────────────

describe("notFileResolvable: the ship filter's one predicate", () => {
  it("layers without a config source hide; a config layer or NO layers stay", () => {
    expect(notFileResolvable({ layers: [{ source: "cli", key: "sessionId" }, { default: null }] })).toBe(true);
    expect(notFileResolvable({ layers: [{ default: 5 }] })).toBe(true);
    expect(notFileResolvable({ layers: [{ source: "env", key: "X" }, { default: null }] })).toBe(true);
    expect(notFileResolvable({ layers: [{ source: "config", key: "webui.port" }] })).toBe(false);
    expect(notFileResolvable({ layers: [{ source: "cli", key: "x" }, { source: "config", key: "x" }] })).toBe(false);
    // Keys that declare no layers at all stay visible (extension sections
    // resolve through the parent's config layer).
    expect(notFileResolvable({ type: "number", default: 3 })).toBe(false);
    expect(notFileResolvable({ layers: [] })).toBe(false);
    expect(notFileResolvable(null)).toBe(false);
    expect(notFileResolvable(undefined)).toBe(false);
  });

  it("TRIPWIRE: the live unified schema hides EXACTLY the two keys, each with its layer chain", async () => {
    const unified = await liveSchema();
    const leaves: Array<{ path: string; prop: SchemaProperty }> = [];
    for (const [k, v] of Object.entries(unified)) scanLeaves(k, v, leaves);
    const hidden = leaves.filter((l) => notFileResolvable(l.prop)).map((l) => l.path);
    expect(hidden.sort()).toEqual([...HIDDEN].sort());
    // The chains themselves, spelled (a layer added with source "config"
    // belongs in the row set again; the pin catches that too -- which is
    // exactly what the mid-run envScrubbing ruling did to it, and what the
    // B0 inert-key fix did to the trio).
    const chain = (key: string) => (unified[key]?.layers ?? []).map((l) => l.source ?? "default");
    expect(chain("sessionId")).toEqual(["cli", "default"]);
    expect(chain("maxToolDifficulty")).toEqual(["cli", "default"]);
    for (const revived of REVIVED) expect(chain(revived)).toEqual(["config", "default"]);
    // B0 retired the dead keys OFF the schema entirely (REMOVED_KEYS tombstones
    // own their old file bytes -- tests/core/rescue-removed-keys.test.ts).
    for (const retired of RETIRED) {
      expect(unified[retired], `"${retired}" left the schema`).toBeUndefined();
    }
    // envScrubbing: cli (inverted parse key) > CONFIG > default -> visible.
    expect(chain(SCRUBBED)).toEqual(["cli", "config", "default"]);
    expect(hidden).not.toContain(SCRUBBED);
    // No hidden path is nested (every hidden key is a top-level core leaf), so
    // the recursion case below runs on an extension fixture instead.
    expect(hidden.every((p) => !p.includes("."))).toBe(true);
  });
});

// ── The snapshot ships no row for them ──────────────────────────────────────

describe("configSnapshot: config-file-unreachable leaves ship no row", () => {
  it("the two hidden keys are absent, the revived trio ships stamped rows, the retired keys ship nothing", async () => {
    const payload = await buildConfigSnapshot(fakeCore(dirWith('{ "theme": "dark" }\n')));
    for (const key of HIDDEN) {
      expect(rowIn(payload, key), `"${key}" must not ship a row`).toBeUndefined();
      expect(rowsOf(payload).some((r) => r.key.startsWith(`${key}.`)), `"${key}" ships no children`).toBe(false);
    }
    // B0 revived the trio: real rows, real edit stamps, resolved slot present.
    for (const key of REVIVED) {
      const row = rowIn(payload, key)!;
      expect(row, `"${key}" ships a row now`).toBeDefined();
      expect(row.edit, `"${key}" is writable from the file`).toBeDefined();
    }
    expect(rowIn(payload, "maxRetries")!.edit).toEqual({ type: "number", minimum: 0 });
    expect(rowIn(payload, "toolRetryDelay")!.edit).toEqual({ type: "number", minimum: 0 });
    expect(rowIn(payload, "taskProfile")!.edit).toEqual({ type: "string" });
    // The retired keys are off the schema; a file WITHOUT them renders nothing.
    for (const key of RETIRED) expect(rowIn(payload, key), `"${key}" is gone`).toBeUndefined();
    const control = rowIn(payload, CONTROL)!;
    expect(control.edit, "the control row still ships stamped").toBeDefined();
    // envScrubbing is a NORMAL row now (the mid-run ruling): the boolean edit
    // stamp ships even though the file omits the key entirely.
    const scrubbed = rowIn(payload, SCRUBBED)!;
    expect(scrubbed, "envScrubbing ships a row").toBeDefined();
    expect(scrubbed.edit).toEqual({ type: "boolean" });
    expect("file" in scrubbed, "the file omits it: the slot rides omitted, never fabricated").toBe(false);
    // The rail counts and the panel search are computed from these rows, so
    // the two simply stop existing there; nothing else changes shape.
    expect(payload.sections.find((s) => s.name === "core")!.rows.length).toBeGreaterThan(0);
  });

  it("argv carrying --session-id does NOT resurrect the row (or its cli slot)", async () => {
    const dir = dirWith("{}\n");
    const withFlag = await buildConfigSnapshot(fakeCore(dir), {
      argv: ["bun", "hotdog", "--session-id", "sess-7", "--disable-env-scrubbing", "--max-tool-difficulty", "2"],
    });
    for (const key of HIDDEN) expect(rowIn(withFlag, key), `"${key}" stays hidden with its flag set`).toBeUndefined();
    // The cli-slot attestation retires WITH the row: no shipped row names a
    // hidden key's flag (descriptions legitimately mention flags, so the pin
    // reads the slots, not the serialized blob). envScrubbing's flag DOES ship
    // a slot -- it is a reachable key, and its row was never in question.
    const cliFlags = rowsOf(withFlag).flatMap((r) => (r.cli ? [r.cli.flag] : []));
    expect(cliFlags).not.toContain("--session-id");
    expect(cliFlags).not.toContain("--max-tool-difficulty");
    expect(rowIn(withFlag, SCRUBBED)!.cli).toEqual({ flag: "--disable-env-scrubbing", value: true });
    // The control key's cli slot still attests when its flag is on the argv:
    // the filter is about the file, not about hiding flags.
    const themed = await buildConfigSnapshot(fakeCore(dir), { argv: ["bun", "hotdog", "--theme", "light"] });
    expect(rowIn(themed, "theme")!.cli).toEqual({ flag: "--theme", value: "light" });
  });

  it("an extension leaf with config-less layers drops, and its no-layers sibling stays (the recursion case)", async () => {
    const widgetSchema = {
      type: "object",
      properties: {
        // A NESTED property leaf whose own layers never read the file: drops.
        cliOnlyChild: { type: "string", layers: [{ source: "cli", key: "cliOnlyChild" }, { default: null }] },
        deadChild: { type: "number", layers: [{ default: 1 }] },
        // Declares nothing of its own: resolves through the section's config
        // layer, so it stays (the ruling hides reachability, not depth).
        plainChild: { type: "number", default: 7 },
        configFileChild: { type: "number", layers: [{ source: "config", key: "widget.configFileChild" }, { default: 9 }] },
      },
      layers: [{ source: "config", key: "widget" }, { default: {} }],
    };
    const params = [{ key: "widget", description: "", defaults: {}, schema: widgetSchema, layers: widgetSchema.layers }];
    const payload = await buildConfigSnapshot(fakeCore(dirWith('{"widget": {"plainChild": 3}}\n'), params));
    expect(rowIn(payload, "widget.cliOnlyChild")).toBeUndefined();
    expect(rowIn(payload, "widget.deadChild")).toBeUndefined();
    expect(rowIn(payload, "widget.plainChild")!.file).toBe(3);
    expect(rowIn(payload, "widget.configFileChild")!.edit).toEqual({ type: "number" });
    // The section itself keeps its own section entry (rows are leaf-keyed).
    expect(payload.sections.find((s) => s.name === "widget")).toBeDefined();
  });
});

// ── The write gates ─────────────────────────────────────────────────────────

describe("setConfigKey / editConfigList: the same predicate gates the write", () => {
  it("a CLI-only key refuses with the flag named in the text", async () => {
    const dir = dirWith("{}\n");
    const before = sha(cfgFile(dir));
    const cases: Array<[string, string]> = [
      ["sessionId", "--session-id"],
      ["maxToolDifficulty", "--max-tool-difficulty"],
    ];
    for (const [key, flag] of cases) {
      const res = await applyConfigKeyEdit(fakeCore(dir), key, { value: key === "maxToolDifficulty" ? 2 : "whatever" });
      expect(res.ok, `"${key}" must refuse`).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain(`"${key}" is not settable from the config file`);
        expect(res.error).toContain(`it resolves from ${flag}`);
        expect(res.error).toContain("a settings.json entry would be ignored");
        expect(res.error, "no fake restart promise").not.toContain("restart");
      }
    }
    expect(sha(cfgFile(dir))).toBe(before);
    expect(readdirSync(dir)).toEqual(["defaults.json"]);
  });

  it("the revived trio WRITES for real (config layers); bounds and type still refuse", async () => {
    // B0 gave maxRetries/toolRetryDelay/taskProfile config layers: the same
    // keyPaths that used to refuse "not resolvable" now land bytes.
    const dir = dirWith('{\n  "theme": "dark"\n}\n');
    const okWrite = await applyConfigKeyEdit(fakeCore(dir), "maxRetries", { value: 3 });
    expect(okWrite.ok).toBe(true);
    if (okWrite.ok) expect(okWrite.needsRestart, "startup resolution: no live-effect claim").toBe(true);
    expect(readFileSync(cfgFile(dir), "utf-8")).toContain('"maxRetries": 3');
    expect((await applyConfigKeyEdit(fakeCore(dir), "taskProfile", { value: "task-fast" })).ok).toBe(true);
    // Explicit zero is legitimate (no retries / no wait), and the write gate's
    // bounds match the schema: negatives and type-junk refuse.
    expect((await applyConfigKeyEdit(fakeCore(dir), "toolRetryDelay", { value: 0 })).ok).toBe(true);
    const neg = await applyConfigKeyEdit(fakeCore(dir), "maxRetries", { value: -1 });
    expect(neg.ok).toBe(false);
    if (!neg.ok) expect(neg.error).toContain("must be >= 0");
    const junk = await applyConfigKeyEdit(fakeCore(dir), "maxRetries", { value: "lots" });
    expect(junk.ok).toBe(false);
  });

  it("retired keys refuse with the tombstone, at every gate and depth it owns", async () => {
    const dir = dirWith('{\n  "temperature": 0.5,\n  "prompt": "> "\n}\n');
    const before = sha(cfgFile(dir));
    const t = await applyConfigKeyEdit(fakeCore(dir), "temperature", { value: 0.7 });
    expect(t.ok, "temperature is a removed key").toBe(false);
    if (!t.ok) {
      expect(t.error).toContain("is a removed key");
      expect(t.error).toContain("per-provider / per-model temperature definitions (providers[].temperature, providers[].models[].temperature)");
      expect(t.error, "no fake restart promise").not.toContain("restart");
    }
    const p = await applyConfigKeyEdit(fakeCore(dir), "prompt", { value: "$ " });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toContain("the interactive CLI's own prompt surface");
    // The ROOT-only rule: providers[].temperature is the REPLACEMENT -- a
    // nested temperature keeps writing.
    const nested = dirWith('{\n  "providers": [{ "name": "p1", "temperature": 0.5 }]\n}\n');
    const keep = await applyConfigKeyEdit(fakeCore(nested), "providers[0].temperature", { value: 0.7 });
    expect(keep.ok, "the surviving nested temperature must NOT be tombstoned").toBe(true);
    expect(sha(cfgFile(dir)), "the refused writes move zero bytes").toBe(before);
    expect(readdirSync(dir)).toEqual(["defaults.json"]);
  });

  it("the refusal lands with the file MISSING (zero bytes created), ahead of every later stage", async () => {
    const empty = tempDir(); // no defaults.json at all
    // A synthetic default-only extension param keeps the second refusal branch
    // pinned after B0 retired every core default-only key.
    const deadParam = { key: "deadScalar", schema: { type: "number", layers: [{ default: 1 }] } };
    const res = await applyConfigKeyEdit(fakeCore(empty, [deadParam]), "deadScalar", { value: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("is not resolvable from the config file");
    expect(readdirSync(empty), "the gate runs before the write path could create the file").toEqual([]);
    // The retired keys land on the tombstone gate -- also before the file
    // would be created.
    const dead = await applyConfigKeyEdit(fakeCore(empty), "prompt", { value: "> " });
    expect(dead.ok).toBe(false);
    if (!dead.ok) expect(dead.error).toContain("is a removed key");
    expect(readdirSync(empty), "the tombstone gate also runs before the write path").toEqual([]);
    // The path-grammar refusal keeps its own precedence (a non-path is not a
    // config key at all), and a hidden key spelled kebab-case still lands on
    // the reachability gate (findLeafProp normalizes like the loader does).
    const badPath = await applyConfigKeyEdit(fakeCore(empty), "a[b]", { value: 1 });
    expect(badPath.ok).toBe(false);
    if (!badPath.ok) expect(badPath.error).toContain("not an addressable config path");
    const kebab = await applyConfigKeyEdit(fakeCore(empty), "session-id", { value: "s" });
    expect(kebab.ok).toBe(false);
    if (!kebab.ok) expect(kebab.error).toContain("--session-id");
    expect(readdirSync(empty)).toEqual([]);
  });

  it("editConfigList refuses through the shared predicate (append and indexed remove)", async () => {
    const deadArray = {
      key: "deadList",
      schema: { type: "array", layers: [{ source: "cli", key: "deadList" }, { default: [] }], items: { type: "string" } },
    };
    const dir = dirWith('{"theme": "dark"}\n');
    const before = sha(cfgFile(dir));
    const core = fakeCore(dir, [deadArray]);
    const append = await applyConfigListEdit(core, "deadList", "append", { value: "x" });
    expect(append.ok).toBe(false);
    if (!append.ok) {
      expect(append.error).toContain('"deadList" is not settable from the config file');
      expect(append.error).toContain("a settings.json entry would be ignored");
    }
    const remove = await applyConfigListEdit(core, "deadList[0]", "remove", {});
    expect(remove.ok, "an element path inherits the hidden key's posture").toBe(false);
    expect(sha(cfgFile(dir))).toBe(before);
  });

  it("envScrubbing now WRITES: boolean-gated, plain key in the file, needsRestart honest", async () => {
    // The mid-run ruling gave the key a config layer, so it clears the gate and
    // is validated like any other file boolean (type-gated, one line moved, and
    // the honest needsRestart -- a restart is what actually applies it).
    const dir = dirWith('{\n  "theme": "dark"\n}\n');
    const beforeText = readFileSync(cfgFile(dir), "utf-8");
    const res = await applyConfigKeyEdit(fakeCore(dir), SCRUBBED, { value: false });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.needsRestart, "startup resolution: no live-effect claim").toBe(true);
    const after = readFileSync(cfgFile(dir), "utf-8");
    expect(after).toContain('"envScrubbing": false'); // the PLAIN name, nothing re-inverted
    expect(after).toContain('"theme": "dark"'); // sibling byte survives
    expect(after.split("\n").length - beforeText.split("\n").length).toBe(1); // surgical: ONE member added
    const bad = await applyConfigKeyEdit(fakeCore(dir), SCRUBBED, { value: "no" });
    expect(bad.ok, "the boolean gate still applies").toBe(false);
    if (!bad.ok) expect(bad.error).toContain("expected true or false");
  });

  it("a reachable key still writes (the gate hides, it does not freeze the panel)", async () => {
    const dir = dirWith('{ "theme": "dark" }\n');
    const res = await applyConfigKeyEdit(fakeCore(dir), "theme", { value: "light" });
    expect(res.ok).toBe(true);
    expect(readFileSync(cfgFile(dir), "utf-8")).toContain("light");
  });
});

// ── Stale bytes from the lying panel that came before ───────────────────────

describe("stale settings.json entries written by the old panel", () => {
  // Plain JSON (no JSONC comment): the point is a healthy file that happens to
  // carry dead keys, not a rescue diagnosis -- a comment would flip the file's
  // own status to broken and muddy the pin.
  const STALE = `{
  "sessionId": "sess-left-over",
  "maxRetries": 9,
  "prompt": "> ",
  "theme": "dark"
}
`;

  it("sessionId and prompt stay invisible (hidden / tombstoned), maxRetries is ALIVE with its file value", async () => {
    const dir = dirWith(STALE);
    const before = sha(cfgFile(dir));
    const payload = await buildConfigSnapshot(fakeCore(dir));
    // sessionId: CLI-only, still no row. prompt: retired, the tombstone owns
    // it (no row, no crash). maxRetries: B0 made the stale byte REAL -- the row
    // ships stamped and reads 9 straight off the file.
    expect(rowIn(payload, "sessionId")).toBeUndefined();
    expect(rowIn(payload, "prompt")).toBeUndefined();
    const retries = rowIn(payload, "maxRetries")!;
    expect(retries.file, "the once-inert entry now ships as the file value it always was").toBe(9);
    expect(retries.edit).toBeDefined();
    expect(rowIn(payload, "theme")!.file).toBe("dark"); // the reachable sibling still reads
    expect(payload.files[0]!.status).toBe("ok");
    // No unknown-key verdict for any of them: sessionId/maxRetries are
    // schema-known, prompt is a named tombstone.
    expect(payload.findings.filter((f) => f.type === "unknown-key")).toEqual([]);
    const tomb = payload.findings.find((f) => f.type === "removed-key" && f.key === "prompt");
    expect(tomb, "the retired key reports as REMOVED, naming its replacement").toBeDefined();
    expect(tomb!.message).toContain("the interactive CLI's own prompt surface");

    const edit = await applyConfigKeyEdit(fakeCore(dir), "sessionId", { value: "sess-new" });
    expect(edit.ok).toBe(false);
    const deadWrite = await applyConfigKeyEdit(fakeCore(dir), "prompt", { value: "$ " });
    expect(deadWrite.ok, "tombstone writes are refused with the named replacement").toBe(false);
    if (!deadWrite.ok) expect(deadWrite.error).toContain("the interactive CLI's own prompt surface");
    const list = await applyConfigListEdit(fakeCore(dir), "prompt[0]", "remove", {});
    expect(list.ok).toBe(false);
    expect(sha(cfgFile(dir)), "the refused writes move zero bytes").toBe(before);
    expect(readdirSync(dir)).toEqual(["defaults.json"]);
  });
});
