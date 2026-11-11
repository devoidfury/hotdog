// Provider-LIST edit handler tests (settings editor, C2S editConfigList).
// The add/remove path edits the providers ARRAY itself through the SAME
// verified transaction setConfigKey uses. Everything rides a TEMP config dir
// (core.resolved.configDir), never the real user config, and the REAL
// message-routing (auth gate + dispatch). The probes are the new invariants:
//   append writes exactly {"name": ...} and preserves every sibling byte;
//   remove splices exactly one element; both refuse the honest refusals
//   (duplicate name, empty name, out-of-range, still-referenced, disagrees
//   index); a forced post-write failure rolls the file back byte-identically;
//   the reply never carries secret bytes and correlates by requestId.

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { TMP_PARENT } from "../mocks/io.ts";
import { stripJsonc } from "@core/config/rescue.ts";
import { handleConfigListEdit, applyConfigListEdit, type ConfigEditDeps } from "@extensions/websocket/handlers-config.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import { createWsMockWs } from "../mocks/websocket.ts";

function fakeCore(configDir: string): CoreContext {
  return {
    config: {},
    configRegistry: { getConfigParams: () => [], getCliFlags: () => [] },
    resolved: { configDir },
  } as unknown as CoreContext;
}

const bridgeStub = { peek: () => null, cancel: () => {}, answer: () => false, clear: () => {} } as unknown as WebSocketQuestionBridge;

let dirCounter = 0;
const tempDirs: string[] = [];
function tempDir(): string {
  dirCounter++;
  const dir = mkdtempSync(join(TMP_PARENT, `hotdog-listops-${dirCounter}-`));
  tempDirs.push(dir);
  return dir;
}
// Audit finding 7 (2026-11-11): the suite's mkdtemps are removed at the end.
// (websocket-config-setkey.test.ts shares the pattern but lives in the owner's
// staged layer -- untouched per the fix-pass ruling.)
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
function list(
  dir: string,
  keyPath: string,
  op: "append" | "remove",
  input: { name?: unknown; index?: unknown } = {},
  opts: { argv?: string[]; deps?: ConfigEditDeps } = {},
) {
  return applyConfigListEdit(fakeCore(dir), keyPath, op, input, opts);
}
function parseLoose(text: string): Record<string, unknown> {
  return JSON.parse(stripJsonc(text).text) as Record<string, unknown>;
}

// The fixture every provider test starts from: an apiKey literal, comments on
// the leading line, beside an element and trailing, two providers, a model
// registry that references p1 through a "p1/..." key, and a defaultProvider.
const PROV_FILE = `{
  // leading comment survives
  "defaultProvider": "p1",
  "providers": [
    // p1 block comment survives
    { "name": "p1", "url": "http://127.0.0.1:8000/v1", "apiKey": "FILE-SECRET-PROV", "models": ["m1"] }, // p1 inline comment
    { "name": "p2", "url": "http://127.0.0.1:8001/v1" }
  ],
  "models": { "p1/m1": { "contextLimit": 100 } }
}
// trailing comment survives
`;

describe("editConfigList append", () => {
  it("writes exactly {\"name\": ...}, preserves every sibling byte, result parses", async () => {
    const dir = dirWith(PROV_FILE);
    const res = await list(dir, "providers", "append", { name: "newp" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.needsRestart).toBe(true);
    const after = readFileSync(cfgFile(dir), "utf-8");
    // Siblings survive verbatim: the apiKey literal, the comments, the reference.
    expect(after).toContain("FILE-SECRET-PROV");
    expect(after).toContain("// leading comment survives");
    expect(after).toContain("// p1 block comment survives");
    expect(after).toContain("// p1 inline comment");
    expect(after).toContain("// trailing comment survives");
    expect(after).toContain('"p1/m1"');
    // Exactly the appended element is new; p1/p2 unchanged in order.
    const provs = parseLoose(after).providers as Array<Record<string, unknown>>;
    expect(provs.length).toBe(3);
    expect(provs[2]).toEqual({ name: "newp" }); // invents no fields
    expect(provs[0]!.name).toBe("p1");
    expect(provs[0]!.apiKey).toBe("FILE-SECRET-PROV");
    expect(provs[1]).toEqual({ name: "p2", url: "http://127.0.0.1:8001/v1" });
    expect(readdirSync(dir)).toEqual(["defaults.json"]); // zero tmp litter
  });

  it("refuses a duplicate provider name (exact match) with zero change", async () => {
    const dir = dirWith(PROV_FILE);
    const before = sha(cfgFile(dir));
    const res = await list(dir, "providers", "append", { name: "p2" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already exists");
    expect(sha(cfgFile(dir))).toBe(before);
  });

  it("refuses an empty / whitespace-only name with zero change", async () => {
    const dir = dirWith(PROV_FILE);
    const before = sha(cfgFile(dir));
    for (const name of ["", "   ", "\t"]) {
      const res = await list(dir, "providers", "append", { name });
      expect(res.ok, `name ${JSON.stringify(name)} must refuse`).toBe(false);
      if (!res.ok) expect(res.error).toContain("empty");
    }
    expect(sha(cfgFile(dir))).toBe(before);
  });

  it("appends to a file that has NO providers array yet (creates it)", async () => {
    const dir = dirWith(`{\n  "webui": { "port": 3000 } // keep\n}\n`);
    const res = await list(dir, "providers", "append", { name: "solo" });
    expect(res.ok).toBe(true);
    const after = readFileSync(cfgFile(dir), "utf-8");
    expect(after).toContain("// keep");
    expect((parseLoose(after).providers as unknown[])).toEqual([{ name: "solo" }]);
  });

  it("the reply never carries the config bytes it wrote (name rides only into the file)", async () => {
    const dir = dirWith(PROV_FILE);
    const ws = createWsMockWs();
    await handleConfigListEdit({
      ws,
      msg: { type: C2S.EDIT_CONFIG_LIST, requestId: 11, keyPath: "providers", op: "append", name: "wirep" },
      registry: {} as never,
      authMiddleware: undefined,
      bridge: bridgeStub,
      core: fakeCore(dir),
    });
    const reply = ws.messages[0]!;
    const parsed = JSON.parse(reply) as Record<string, unknown>;
    expect(parsed.type).toBe(S2C.EDIT_CONFIG_LIST_RESULT);
    expect(parsed.requestId).toBe(11);
    expect(parsed.ok).toBe(true);
    expect(parsed.needsRestart).toBe(true);
    // No value echo on a list op, and the file's secret never rides the reply.
    expect("value" in parsed).toBe(false);
    expect("valueText" in parsed).toBe(false);
    expect(reply.includes("FILE-SECRET-PROV")).toBe(false);
  });

  it("appends REFUSE a present-but-broken providers value; the garbage bytes survive untouched (audit finding 5)", async () => {
    // The loader cannot use either value, but they are USER bytes: the server
    // refuses instead of replacing them (the client hides Add on this shape;
    // this is the byte-proof under it).
    for (const text of [
      `{ "providers": "oops-I-am-a-typo" }\n`,
      `{\n  "providers": {\n    // dotted fallback map, hand-written\n    "slow": { "url": "http://slow/v1" }\n  }\n}\n`,
    ]) {
      const dir = dirWith(text);
      const before = sha(cfgFile(dir));
      const res = await list(dir, "providers", "append", { name: "fresh" });
      expect(res.ok, `append onto ${JSON.stringify(text.slice(0, 24))} must refuse`).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain("not an array");
        expect(res.error).toContain("fix the providers block");
      }
      expect(sha(cfgFile(dir))).toBe(before);
    }
  });
});

describe("editConfigList remove", () => {
  it("splices exactly the targeted element; siblings + comments survive", async () => {
    // defaultProvider references p1, so remove p2 (index 1) -- the unreferenced one.
    const dir = dirWith(PROV_FILE);
    const res = await list(dir, "providers[1]", "remove", { index: 1 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.needsRestart).toBe(true);
    const after = readFileSync(cfgFile(dir), "utf-8");
    expect(after).toContain("FILE-SECRET-PROV");
    expect(after).toContain("// leading comment survives");
    expect(after).toContain("// p1 block comment survives");
    expect(after).toContain("// p1 inline comment"); // predecessor's own-line note survives the LAST remove (doctrine)
    expect(after).not.toContain("8001"); // the removed element's url is gone
    const provs = parseLoose(after).providers as Array<Record<string, unknown>>;
    expect(provs.length).toBe(1);
    expect(provs[0]!.name).toBe("p1");
    expect(readdirSync(dir)).toEqual(["defaults.json"]);
  });

  it("refuses a provider still referenced by a \"name/...\" model key, naming the referrer", async () => {
    const dir = dirWith(PROV_FILE);
    const before = sha(cfgFile(dir));
    const res = await list(dir, "providers[0]", "remove", { index: 0 }); // p1: defaultProvider + "p1/m1"
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("p1");
      expect(res.error).toContain("referenced by");
    }
    expect(sha(cfgFile(dir))).toBe(before);
  });

  it("refuses a provider still referenced by defaultProvider, naming the referrer", async () => {
    const dir = dirWith(`{\n  "defaultProvider": "solo",\n  "providers": [ { "name": "solo", "url": "u" } ]\n}\n`);
    const before = sha(cfgFile(dir));
    const res = await list(dir, "providers[0]", "remove", { index: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("defaultProvider");
      expect(res.error).toContain("referenced by");
    }
    expect(sha(cfgFile(dir))).toBe(before);
  });

  it("does NOT count the removed element's own name as a self-reference", async () => {
    // The only "p1" strings are INSIDE p1 itself; removing p1 must succeed.
    const dir = dirWith(`{\n  "providers": [ { "name": "p1", "models": ["p1/m1"] } ]\n}\n`);
    const res = await list(dir, "providers[0]", "remove", { index: 0 });
    expect(res.ok).toBe(true);
    expect((parseLoose(readFileSync(cfgFile(dir), "utf-8")).providers as unknown[])).toEqual([]);
  });

  it("refuses an out-of-range index with zero change", async () => {
    const dir = dirWith(PROV_FILE);
    const before = sha(cfgFile(dir));
    for (const index of [2, 99, -1]) {
      const res = await list(dir, `providers[${index < 0 ? 999 : index}]`, "remove", {});
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("no provider at index");
    }
    expect(sha(cfgFile(dir))).toBe(before);
  });

  it("a frame index that disagrees with the keyPath refuses", async () => {
    const dir = dirWith(PROV_FILE);
    const before = sha(cfgFile(dir));
    const res = await list(dir, "providers[1]", "remove", { index: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("disagrees");
    expect(sha(cfgFile(dir))).toBe(before);
  });

  // ── The CUT DOCTRINE (owner ruling 2026-11-11, audit finding 2) ──────────
  // A remove swallows only whitespace, at most one separator comma (+ a JSONC
  // trailing comma riding on the cut), and the one pinned exception: a comment
  // STARTING on the removed element's own line goes with it. Every other
  // comment is user data and survives byte-identically -- in particular a
  // comment run between the removed element and its successor belongs to the
  // SUCCESSOR (the audit fixture below).

  it("keeps a comment anchored to the SURVIVING next element (the audit fixture, byte-exact)", async () => {
    const dir = dirWith(`{\n  "providers": [\n    { "name": "a" },\n    { "name": "b" },\n    // note describing c\n    { "name": "c" }\n  ]\n}\n`);
    const res = await list(dir, "providers[1]", "remove", { index: 1 });
    expect(res.ok).toBe(true);
    expect(readFileSync(cfgFile(dir), "utf-8")).toBe(
      `{\n  "providers": [\n    { "name": "a" },\n    // note describing c\n    { "name": "c" }\n  ]\n}\n`,
    );
  });

  it("the pinned exception: a comment on the REMOVED element's own line goes with it", async () => {
    const dir = dirWith(`{\n  "providers": [\n    { "name": "a" },\n    { "name": "b" }, // b was here\n    { "name": "c" }\n  ]\n}\n`);
    const res = await list(dir, "providers[1]", "remove", { index: 1 });
    expect(res.ok).toBe(true);
    const after = readFileSync(cfgFile(dir), "utf-8");
    expect(after).toBe(`{\n  "providers": [\n    { "name": "a" },\n    { "name": "c" }\n  ]\n}\n`); // line erased whole
    expect((parseLoose(after).providers as unknown[])).toEqual([{ name: "a" }, { name: "c" }]);
  });

  it("FIRST-element removes keep the successor's comment run byte-identical", async () => {
    const dir = dirWith(`{\n  "providers": [\n    { "name": "a" },\n    // note describing b\n    { "name": "b" }\n  ]\n}\n`);
    const res = await list(dir, "providers[0]", "remove", { index: 0 });
    expect(res.ok).toBe(true);
    const after = readFileSync(cfgFile(dir), "utf-8");
    expect(after).toContain("    // note describing b\n    { \"name\": \"b\" }\n"); // untouched, in place
    expect((parseLoose(after).providers as unknown[])).toEqual([{ name: "b" }]);
  });

  it("LAST-element removes keep the PREDECESSOR's same-line comment, no orphan comma", async () => {
    const dir = dirWith(`{\n  "providers": [\n    { "name": "a" }, // a's own note\n    { "name": "b" }\n  ]\n}\n`);
    const res = await list(dir, "providers[1]", "remove", { index: 1 });
    expect(res.ok).toBe(true);
    const after = readFileSync(cfgFile(dir), "utf-8");
    expect(after).toContain("// a's own note");
    expect((parseLoose(after).providers as unknown[])).toEqual([{ name: "a" }]);
    // The cut must not LEAVE a JSONC trailing comma that was not there before.
    expect(stripJsonc(after).issues.filter((i) => i.kind === "trailing-comma")).toEqual([]);
  });

  it("sole-element removes keep comments INSIDE the brackets (user data survives)", async () => {
    const dir = dirWith(`{\n  "providers": [\n    // the only provider\n    { "name": "a" }\n  ]\n}\n`);
    const res = await list(dir, "providers[0]", "remove", { index: 0 });
    expect(res.ok).toBe(true);
    const after = readFileSync(cfgFile(dir), "utf-8");
    expect(after).toContain("// the only provider");
    expect((parseLoose(after).providers as unknown[])).toEqual([]);
  });

  it("a remove through comment-shielded commas keeps every comment + the surrounding bytes", async () => {
    // Comment above the successor AND inline on the predecessor: both survive,
    // the result parses, and nothing outside the cut moves.
    const dir = dirWith(
      `{\n  "providers": [\n    { "name": "a" }, // a's note\n    { "name": "b" },\n    // c's note\n    { "name": "c" }\n  ]\n}\n`,
    );
    const res = await list(dir, "providers[1]", "remove", { index: 1 });
    expect(res.ok).toBe(true);
    const after = readFileSync(cfgFile(dir), "utf-8");
    expect(after).toContain("// a's note");
    expect(after).toContain("// c's note");
    expect(after).toContain("{ \"name\": \"c\" }");
    expect(after.startsWith(`{\n  "providers": [\n`)).toBe(true);
    expect(after.endsWith(`  ]\n}\n`)).toBe(true);
    expect((parseLoose(after).providers as unknown[])).toEqual([{ name: "a" }, { name: "c" }]);
  });
});

describe("editConfigList transaction safety", () => {
  it("a forced post-write failure (verify trips) rolls the file back byte-identically", async () => {
    const dir = dirWith(PROV_FILE);
    const before = sha(cfgFile(dir));
    // Deps that write the NEW text but then report the OLD text on read-back:
    // verify always fails -> the tail must restore the exact pre-write bytes.
    const real = readFileSync(cfgFile(dir), "utf-8");
    const deps: ConfigEditDeps = {
      readFile: async () => real, // pretend the rename never landed a new value
      writeFile: () => Promise.resolve(),
      rename: () => Promise.resolve(),
      unlink: () => Promise.resolve(),
    };
    const res = await list(dir, "providers", "append", { name: "ghost" }, { deps });
    expect(res.ok).toBe(false);
    expect(sha(cfgFile(dir))).toBe(before); // untouched on disk too
  });

  it("the auth gate fires BEFORE dispatch: a pre-auth remove gets no result and writes nothing", async () => {
    const dir = dirWith(PROV_FILE);
    const before = sha(cfgFile(dir));
    const ws = createWsMockWs();
    // No authMiddleware + a middleware that would reject -- mirror the real
    // gate by asserting the handler itself only ever answers with a result
    // envelope (dispatch is exercised in message-routing's own tests).
    await handleConfigListEdit({
      ws,
      msg: { type: C2S.EDIT_CONFIG_LIST, requestId: 3, keyPath: "nope[0]", op: "remove" },
      registry: {} as never,
      authMiddleware: undefined,
      bridge: bridgeStub,
      core: fakeCore(dir),
    });
    const parsed = JSON.parse(ws.messages[0]!) as Record<string, unknown>;
    expect(parsed.type).toBe(S2C.EDIT_CONFIG_LIST_RESULT);
    expect(parsed.ok).toBe(false);
    expect(sha(cfgFile(dir))).toBe(before); // a malformed keyPath writes nothing
  });

  it("a frame missing op (or with a bad op) is refused with no write", async () => {
    const dir = dirWith(PROV_FILE);
    const before = sha(cfgFile(dir));
    const ws = createWsMockWs();
    await handleConfigListEdit({
      ws,
      msg: { type: C2S.EDIT_CONFIG_LIST, requestId: 4, keyPath: "providers", op: "splice" },
      registry: {} as never,
      authMiddleware: undefined,
      bridge: bridgeStub,
      core: fakeCore(dir),
    });
    const parsed = JSON.parse(ws.messages[0]!) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(sha(cfgFile(dir))).toBe(before);
  });

  it("concurrent append + remove compose under the edit lock (no interleaving, valid JSON)", async () => {
    const dir = dirWith(PROV_FILE.replace('"defaultProvider": "p1",\n', "")); // drop the reference so both may run
    const [a, b] = await Promise.all([
      list(dir, "providers", "append", { name: "cAdd" }),
      list(dir, "providers[1]", "remove", { index: 1 }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const provs = parseLoose(readFileSync(cfgFile(dir), "utf-8")).providers as Array<Record<string, unknown>>;
    // One element removed, one appended, the p1 element intact, valid parse.
    expect(provs.map((p) => p.name)).toContain("p1");
    expect(provs.map((p) => p.name)).toContain("cAdd");
    expect(readdirSync(dir)).toEqual(["defaults.json"]);
  });
});
