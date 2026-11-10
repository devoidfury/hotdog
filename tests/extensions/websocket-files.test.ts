// Workspace file-tree handler tests (confinement is the whole ballgame):
// a web socket reaching the filesystem must refuse every escape class with
// an honest one-liner and leak NOTHING -- the sentinel sweep asserts no
// planted secret appears anywhere in the JSON-serialized reply.
//
// Fixture: two roots (multi-root) + a SIBLING OUTSIDE roots + planted files:
// text, NUL-byte binary, an over-cap single line, deny hits (.ssh/, .env,
// .bashrc), a symlink to /etc, a link CHAIN escaping to the outside dir, a
// dangling final link, and a many/ dir past MAX_LIST_DIR_ENTRIES.
//
// Also pinned: the roots-only no-path reply (zero fs), dirs-first sort, the
// entry-cap truncated flag, line-addressed continuation concatenating
// byte-identical, the char cap, "use listDir" on a directory, requestId
// echo, reply-to-requesting-socket-only, and the standard pre-auth gate
// (identical treatment to an existing C2S -- the gate in message-routing.ts
// fires BEFORE the dispatch table, so these types inherit it).

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { TMP_PARENT } from "../mocks/io.ts";
import { routeMessage } from "@extensions/websocket/message-routing.ts";
import { listDirPayload, readPayload, handleListDir } from "@extensions/websocket/handlers-files.ts";
import { Workspace } from "@utils/workspace.ts";
import {
  C2S,
  S2C,
  MAX_LIST_DIR_ENTRIES,
  MAX_FILE_READ_CHARS,
  type ListDirResultWire,
  type ReadFileResultWire,
} from "@extensions/websocket/protocol.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import type { AuthMiddleware } from "@extensions/websocket/auth.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import { createWsMockWs } from "../mocks/websocket.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TMP = mkdtempSync(join(TMP_PARENT, "hotdog-files-"));
const ROOT_A = join(TMP, "roots", "rootA");
const ROOT_B = join(TMP, "roots", "rootB");
const OUTSIDE = join(TMP, "outside");

const SENTINELS = [
  "SENTINEL-OUTSIDE", // the file beyond every root (chain target too)
  "SENTINEL-SSH",     // rootA/.ssh/id_ed25519
  "SENTINEL-ENV",     // rootA/.env
  "SENTINEL-RIC",     // rootA/.bashrc (the .*rc class)
  "SENTINEL-BIN",     // bytes beside a NUL in the binary file
  "SENTINEL-PASSWD",  // fingerprint that a /etc target never echoed
];

// A 7-line file for the continuation test (page size 3 -> 3+3+1).
const SEVEN_LINES = ["one", "two", "three", "four", "five", "six", "seven"]
  .map((s) => `${s} ${"x".repeat(7)}`)
  .join("\n") + "\n";
// Four fat lines for the char-cap continuation (100_001 bytes each).
const FAT_LINE = "F".repeat(100_000);
const FAT_LINES = [1, 2, 3, 4].map((i) => `${i}:${FAT_LINE}`).join("\n") + "\n";
const BIN_BYTES = Buffer.from([...Buffer.from("head SENTINEL-BIN"), 0x00, ...Buffer.from("tail")]);

beforeAll(() => {
  mkdirSync(ROOT_A, { recursive: true });
  mkdirSync(ROOT_B, { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });

  writeFileSync(join(ROOT_A, "alpha.txt"), "line1\nline2\nline3\n");
  writeFileSync(join(ROOT_A, "seven.txt"), SEVEN_LINES);
  writeFileSync(join(ROOT_A, "empty.txt"), "");
  writeFileSync(join(ROOT_A, "long-line.txt"), "L".repeat(MAX_FILE_READ_CHARS + 40_000) + "\n");
  mkdirSync(join(ROOT_A, "sub"), { recursive: true });
  writeFileSync(join(ROOT_A, "sub", "nested.txt"), "nested\n");
  writeFileSync(join(ROOT_B, "beta.txt"), "beta\n");

  mkdirSync(join(ROOT_A, ".ssh"), { recursive: true });
  writeFileSync(join(ROOT_A, ".ssh", "id_ed25519"), "SENTINEL-SSH\n");
  writeFileSync(join(ROOT_A, ".env"), "SENTINEL-ENV\n");
  writeFileSync(join(ROOT_A, ".bashrc"), "SENTINEL-RIC\n");

  mkdirSync(join(ROOT_A, "bin"), { recursive: true });
  writeFileSync(join(ROOT_A, "bin", "data.bin"), BIN_BYTES);

  mkdirSync(join(ROOT_A, "caps"), { recursive: true });
  writeFileSync(join(ROOT_A, "caps", "fat.txt"), FAT_LINES);

  mkdirSync(join(ROOT_A, "many"), { recursive: true });
  for (let i = 0; i < MAX_LIST_DIR_ENTRIES + 5; i++) {
    writeFileSync(join(ROOT_A, "many", `f${String(i).padStart(4, "0")}.txt`), "x\n");
  }

  writeFileSync(join(OUTSIDE, "out-secret.txt"), "SENTINEL-OUTSIDE\n");
  symlinkSync("/etc", join(ROOT_A, "link-etc")); // symlink INSIDE roots pointing at /etc
  symlinkSync(join(OUTSIDE, "out-secret.txt"), join(ROOT_A, "chain2"));
  symlinkSync("chain2", join(ROOT_A, "chain1")); // link chain: chain1 -> chain2 -> outside
  symlinkSync("./gone.txt", join(ROOT_A, "dangle")); // dangling final link
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const core = { resolved: { workspaceRoots: [ROOT_A, ROOT_B] } } as unknown as CoreContext;
/** An explicit EMPTY deny disables the denylist (the completions.ts `deny != null` branch). */
const coreNoDeny = { resolved: { workspaceRoots: [ROOT_A, ROOT_B], workspaceDeny: [] } } as unknown as CoreContext;

const bridgeStub = {
  peek: () => null,
  cancel: () => {},
  answer: () => false,
  clear: () => {},
} as unknown as WebSocketQuestionBridge;

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Route one C2S and return the raw reply strings of the requesting socket. */
async function send(ws: ReturnType<typeof createWsMockWs>, msg: Record<string, unknown>): Promise<string[]> {
  await routeMessage(ws, msg as never, {} as never, undefined, bridgeStub, core);
  await flush();
  return ws.messages;
}

function parse<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

const expectNoSentinel = (raw: string): void => {
  for (const s of SENTINELS) expect(raw.includes(s)).toBe(false);
};

// ── Roots listing ────────────────────────────────────────────────────────────

describe("listDir roots", () => {
  it("no path: the configured roots (name + absolute path), no entries, no fs", async () => {
    const ws = createWsMockWs();
    const replies = await send(ws, { type: C2S.LIST_DIR, requestId: 1 });
    expect(replies).toHaveLength(1);
    const reply = parse<ListDirResultWire & Record<string, unknown>>(replies[0]!);
    expect(reply.type).toBe(S2C.LIST_DIR_RESULT);
    expect(reply.requestId).toBe(1);
    expect(reply.roots).toEqual([
      { name: "rootA", path: ROOT_A },
      { name: "rootB", path: ROOT_B },
    ]);
    expect("entries" in reply).toBe(false);
    expect("error" in reply).toBe(false);
  });

  it("multi-root: each root lists independently", async () => {
    const a = parse<ListDirResultWire>(
      (await send(createWsMockWs(), { type: C2S.LIST_DIR, requestId: 2, path: ROOT_A }))[0]!,
    );
    const b = parse<ListDirResultWire>(
      (await send(createWsMockWs(), { type: C2S.LIST_DIR, requestId: 3, path: ROOT_B }))[0]!,
    );
    expect(a.path).toBe(ROOT_A);
    expect(a.entries!.some((e) => e.name === "alpha.txt")).toBe(true);
    expect(b.entries!.map((e) => e.name)).toEqual(["beta.txt"]);
  });
});

// ── Confinement negatives (the sentinel sweep) ──────────────────────────────

describe("listDir/readFile confinement", () => {
  const negatives: Array<{ label: string; msg: Record<string, unknown>; want: string }> = [
    { label: "../ traversal", msg: { type: C2S.READ_FILE, requestId: 10, path: "../outside/out-secret.txt" }, want: "Path escape rejected" },
    { label: "absolute outside roots", msg: { type: C2S.READ_FILE, requestId: 11, path: join(OUTSIDE, "out-secret.txt") }, want: "Path escape rejected" },
    { label: "symlink to /etc (read)", msg: { type: C2S.READ_FILE, requestId: 12, path: "link-etc/passwd" }, want: "Symlink escape rejected" },
    { label: "symlink chain (read)", msg: { type: C2S.READ_FILE, requestId: 13, path: "chain1" }, want: "Symlink escape rejected" },
    { label: "symlink chain (list)", msg: { type: C2S.LIST_DIR, requestId: 14, path: "chain1" }, want: "Symlink escape rejected" },
    { label: "symlink to /etc (list)", msg: { type: C2S.LIST_DIR, requestId: 15, path: "link-etc" }, want: "Symlink escape rejected" },
    { label: "denylist hit read (~/.ssh class)", msg: { type: C2S.READ_FILE, requestId: 16, path: ".ssh/id_ed25519" }, want: "Denylisted path rejected" },
    { label: "denylist hit list", msg: { type: C2S.LIST_DIR, requestId: 17, path: ".ssh" }, want: "Denylisted path rejected" },
    { label: "denylist .env read", msg: { type: C2S.READ_FILE, requestId: 18, path: ".env" }, want: "Denylisted path rejected" },
    { label: "absolute deny hit", msg: { type: C2S.READ_FILE, requestId: 19, path: join(ROOT_A, ".bashrc") }, want: "Denylisted path rejected" },
    { label: "traversal from absolute root", msg: { type: C2S.LIST_DIR, requestId: 20, path: join(ROOT_A, "..", "..", "outside") }, want: "Path escape rejected" },
  ];
  for (const { label, msg, want } of negatives) {
    it(`${label}: refused honestly, sentinel content NOWHERE in the reply`, async () => {
      const ws = createWsMockWs();
      const replies = await send(ws, msg);
      expect(replies).toHaveLength(1);
      const raw = replies[0]!;
      expectNoSentinel(raw);
      expect(raw).not.toContain("/etc"); // no /etc spelling rides back -- only the REQUESTED path does
      const reply = parse<Record<string, unknown>>(raw);
      expect(typeof reply.error).toBe("string");
      expect((reply.error as string).length).toBeGreaterThan(want.length);
      expect(reply.error).toContain(want);
      // One honest line, no stack frames, and the requested-path spelling only.
      expect((reply.error as string).split("\n")).toHaveLength(1);
      expect(raw).not.toContain("at ");
      expect("content" in reply).toBe(false);
      expect("entries" in reply).toBe(false);
      expect("roots" in reply).toBe(false);
    });
  }

  it("dangling final link: listed as a link, read refuses 'not found' (resolveSafe probe semantics)", async () => {
    const listing = parse<ListDirResultWire>(
      (await send(createWsMockWs(), { type: C2S.LIST_DIR, requestId: 21, path: ROOT_A }))[0]!,
    );
    const row = listing.entries!.find((e) => e.name === "dangle")!;
    expect(row.isSymlink).toBe(true);
    expect(row.isDir).toBe(false);
    const reply = parse<ReadFileResultWire>(
      (await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 22, path: "dangle" }))[0]!,
    );
    expect(reply.error).toContain("not found");
  });
});

// ── Listing shape ────────────────────────────────────────────────────────────

describe("listDir listing shape", () => {
  it("dirs first then name; deny entries OMITTED; symlink rows stay unresolved", async () => {
    const reply = parse<ListDirResultWire>(
      (await send(createWsMockWs(), { type: C2S.LIST_DIR, requestId: 30, path: ROOT_A }))[0]!,
    );
    const names = reply.entries!.map((e) => e.name);
    // Denylist omission: the ssh/dotfile/env class never appears.
    expect(names).not.toContain(".ssh");
    expect(names).not.toContain(".env");
    expect(names).not.toContain(".bashrc");
    // dirs-first, then plain names; alpha.txt sorts first among the files.
    const dirs = reply.entries!.filter((e) => e.isDir).map((e) => e.name);
    const files = reply.entries!.filter((e) => !e.isDir).map((e) => e.name);
    expect(dirs).toEqual(["bin", "caps", "many", "sub"]);
    expect(names).toEqual([...dirs, ...files]);
    expect(files[0]).toBe("alpha.txt");
    // The /etc link is LISTED (flagged), its target is not resolved into the row.
    const link = reply.entries!.find((e) => e.name === "link-etc")!;
    expect(link.isSymlink).toBe(true);
    expect(link.path).toBe(join(ROOT_A, "link-etc"));
    expect(JSON.stringify(reply)).not.toContain("/etc");
    // Files carry size; the entry paths are absolute.
    const alpha = reply.entries!.find((e) => e.name === "alpha.txt")!;
    expect(alpha.size).toBe(18);
    expect(alpha.path).toBe(join(ROOT_A, "alpha.txt"));
    expect(alpha.mtime).toBeNumber();
  });

  it("an explicit empty deny UNCONFIGURES the denylist (the deny != null branch)", async () => {
    const ws = createWsMockWs();
    await handleListDir({
      ws,
      msg: { type: C2S.LIST_DIR, requestId: 31, path: ROOT_A },
      registry: {} as never,
      authMiddleware: undefined,
      bridge: bridgeStub,
      core: coreNoDeny,
    });
    const reply = parse<ListDirResultWire>(ws.messages[0]!);
    const names = reply.entries!.map((e) => e.name);
    expect(names).toContain(".ssh");
    expect(names).toContain(".env");
  });

  it("entry cap: MAX_LIST_DIR_ENTRIES rows and an honest truncated flag", async () => {
    const reply = parse<ListDirResultWire>(
      (await send(createWsMockWs(), { type: C2S.LIST_DIR, requestId: 32, path: "many" }))[0]!,
    );
    expect(reply.entries).toHaveLength(MAX_LIST_DIR_ENTRIES);
    expect(reply.truncated).toBe(true);
  });

  it("listing a file says 'not a directory'", async () => {
    const reply = parse<ListDirResultWire>(
      (await send(createWsMockWs(), { type: C2S.LIST_DIR, requestId: 33, path: "alpha.txt" }))[0]!,
    );
    expect(reply.error).toBe("not a directory: alpha.txt");
  });
});

// ── Reader ───────────────────────────────────────────────────────────────────

describe("readFile reader", () => {
  it("text page: content echoes path + offset; no truncated flag at EOF", async () => {
    const reply = parse<ReadFileResultWire>(
      (await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 40, path: "alpha.txt" }))[0]!,
    );
    expect(reply.type).toBe(S2C.READ_FILE_RESULT);
    expect(reply.requestId).toBe(40);
    expect(reply.path).toBe("alpha.txt");
    expect(reply.offset).toBe(0);
    expect(reply.content).toBe("line1\nline2\nline3\n");
    expect("truncated" in reply).toBe(false);
  });

  it("offset/limit pages by LINES and continuation concatenates byte-identical", async () => {
    let joined = "";
    const sizes: number[] = [];
    for (let offset = 0, guard = 0; guard < 10; offset += 3, guard++) {
      const reply = parse<ReadFileResultWire>(
        (await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 50, path: "seven.txt", offset, limit: 3 }))[0]!,
      );
      expect(reply.offset).toBe(offset);
      joined += reply.content ?? "";
      sizes.push((reply.content ?? "").length);
      if (!reply.truncated) break;
    }
    expect(joined).toBe(SEVEN_LINES);
    expect(sizes).toEqual([
      "one xxxxxxx\ntwo xxxxxxx\nthree xxxxxxx\n".length,
      "four xxxxxxx\nfive xxxxxxx\nsix xxxxxxx\n".length,
      "seven xxxxxxx\n".length,
    ]);
  });

  it("char cap cuts at a line boundary; the continuation reassembles byte-identical", async () => {
    const p1 = parse<ReadFileResultWire>(
      (await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 51, path: "caps/fat.txt", limit: 100 }))[0]!,
    );
    expect(p1.truncated).toBe(true);
    expect((p1.content ?? "").length).toBeLessThan(MAX_FILE_READ_CHARS);
    expect(p1.content!.endsWith("1:" + FAT_LINE + "\n2:" + FAT_LINE + "\n")).toBe(true);
    const consumed = p1.content!.split("\n").length - 1; // 2 complete lines
    const p2 = parse<ReadFileResultWire>(
      (await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 52, path: "caps/fat.txt", offset: consumed, limit: 100 }))[0]!,
    );
    expect(p2.content).toBe("3:" + FAT_LINE + "\n4:" + FAT_LINE + "\n");
    expect("truncated" in p2).toBe(false);
    expect(p1.content! + p2.content!).toBe(FAT_LINES);
  });

  it("a single line over the char cap is refused honestly, never sliced", async () => {
    const reply = parse<ReadFileResultWire>(
      (await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 53, path: "long-line.txt" }))[0]!,
    );
    expect(reply.error).toContain(`longer than the ${MAX_FILE_READ_CHARS}-char read cap`);
    expect("content" in reply).toBe(false);
  });

  it("NUL-byte file: honest 'binary file (N bytes)' and ZERO content bytes on the wire", async () => {
    const raw = (await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 54, path: "bin/data.bin" }))[0]!;
    expectNoSentinel(raw);
    const reply = parse<ReadFileResultWire>(raw);
    expect(reply.error).toBe(`binary file (${BIN_BYTES.length} bytes) -- not displayed`);
    expect("content" in reply).toBe(false);
    expect(raw).not.toContain("content");
  });

  it("reading a directory refuses with the 'use listDir' hint", async () => {
    const reply = parse<ReadFileResultWire>(
      (await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 55, path: "sub" }))[0]!,
    );
    expect(reply.error).toBe("sub is a directory -- use listDir");
  });

  it("not found / empty file / offset past EOF", async () => {
    const missing = parse<ReadFileResultWire>(
      (await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 56, path: "nope.txt" }))[0]!,
    );
    expect(missing.error).toBe("not found: nope.txt");
    const empty = parse<ReadFileResultWire>(
      (await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 57, path: "empty.txt" }))[0]!,
    );
    expect(empty.content).toBe("");
    expect("truncated" in empty).toBe(false);
    const past = parse<ReadFileResultWire>(
      (await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 58, path: "alpha.txt", offset: 99 }))[0]!,
    );
    expect(past.content).toBe("");
    expect("truncated" in past).toBe(false);
  });

  it("garbage offset/limit clamps to defaults (paging hints, not a trust boundary)", async () => {
    const reply = parse<ReadFileResultWire>(
      (await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 59, path: "seven.txt", offset: -5, limit: "ten" }))[0]!,
    );
    expect(reply.offset).toBe(0);
    expect(reply.content).toBe(SEVEN_LINES);
  });

  it("a file without a trailing newline reads whole", async () => {
    writeFileSync(join(ROOT_A, "noeol.txt"), "a\nb");
    const reply = parse<ReadFileResultWire>(
      (await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 60, path: "noeol.txt" }))[0]!,
    );
    expect(reply.content).toBe("a\nb");
    expect("truncated" in reply).toBe(false);
    const page = parse<ReadFileResultWire>(
      (await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 61, path: "noeol.txt", offset: 1, limit: 5 }))[0]!,
    );
    expect(page.content).toBe("b");
  });
});

// ── Plumbing: correlation, socket scoping, the auth gate ────────────────────

describe("file handlers plumbing", () => {
  it("requestId echoed; a second socket receives nothing", async () => {
    const wsA = createWsMockWs();
    const wsB = createWsMockWs();
    await routeMessage(wsA, { type: C2S.LIST_DIR, requestId: 77 } as never, {} as never, undefined, bridgeStub, core);
    await routeMessage(wsA, { type: C2S.READ_FILE, requestId: 78, path: "alpha.txt" } as never, {} as never, undefined, bridgeStub, core);
    await flush();
    expect(wsA.messages).toHaveLength(2);
    expect(parse<ReadFileResultWire>(wsA.messages[0]!).requestId).toBe(77);
    expect(parse<ReadFileResultWire>(wsA.messages[1]!).requestId).toBe(78);
    expect(wsB.messages).toHaveLength(0);
  });

  it("an unauthenticated socket gets the STANDARD pre-auth treatment (parity with an existing C2S)", async () => {
    const auth = { validateToken: (t: string) => t === "good" } as unknown as AuthMiddleware;
    const anonTree = createWsMockWs();
    const anonRead = createWsMockWs();
    const anonCfg = createWsMockWs();
    await routeMessage(anonTree, { type: C2S.LIST_DIR, requestId: 1 } as never, {} as never, auth, bridgeStub, core);
    await routeMessage(anonRead, { type: C2S.READ_FILE, requestId: 2, path: "alpha.txt" } as never, {} as never, auth, bridgeStub, core);
    await routeMessage(anonCfg, { type: C2S.CONFIG_SNAPSHOT, requestId: 3 } as never, {} as never, auth, bridgeStub, core);
    await flush();
    // Byte-identical frame to what the existing configSnapshot C2S gets: no special path.
    expect(anonTree.messages).toEqual(anonCfg.messages);
    expect(anonRead.messages).toEqual(anonCfg.messages);
    const frame = parse<Record<string, unknown>>(anonTree.messages[0]!);
    expect(frame.type).toBe(S2C.AUTH_ERROR);
    expect(frame.code).toBe("auth_required");
    expect(anonTree.messages).toHaveLength(1); // the gate answers, the handler never runs

    const authed = createWsMockWs();
    authed.authToken = "good";
    await routeMessage(authed, { type: C2S.LIST_DIR, requestId: 9 } as never, {} as never, auth, bridgeStub, core);
    await flush();
    expect(parse<ListDirResultWire>(authed.messages[0]!).type).toBe(S2C.LIST_DIR_RESULT);
  });

  it("the direct payload helpers keep confinement even when called with raw wires (unit)", async () => {
    const ws = new Workspace([ROOT_A]);
    expect((await listDirPayload(ws, "/etc")).error).toContain("Path escape rejected");
    expect((await readPayload(ws, ".ssh/id_ed25519", 0, 10)).error).toContain("Denylisted path rejected");
    expect((await listDirPayload(ws, 42 as never)).error).toContain("Invalid path");
  });
});
