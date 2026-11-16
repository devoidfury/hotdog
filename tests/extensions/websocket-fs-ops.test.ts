// Workspace FILE OPS handler tests (the write family: createFile / createDir
// / renamePath / deletePath / saveFile). Confinement stays the whole ballgame
// -- every op runs resolveSafe on EVERY side before any fs call, refuses the
// denylist / escapes / roots / existing targets honestly, and the sentinel
// sweep asserts no planted secret rides back. saveFile adds the conflict
// gate (stale mtime refuses, fresh mtime overwrites) and the byte cap tied
// to MAX_FILE_READ_CHARS (same numeric ceiling measured in bytes -- pinned).
//
// Fixture doctrine mirrors websocket-files.test.ts: two roots + an OUTSIDE
// sibling, planted deny hits, a symlink chain escaping roots, an in-root
// symlink pair, plus per-test scratch that MUTATES the tree -- every test
// creates its own names under dedicated dirs so runs never collide.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { TMP_PARENT } from "../mocks/io.ts";
import { routeMessage } from "@extensions/websocket/message-routing.ts";
import {
  createPayload,
  renamePayload,
  deletePayload,
  saveFilePayload,
  workspaceFor,
} from "@extensions/websocket/handlers-files.ts";
import {
  C2S,
  S2C,
  MAX_FILE_READ_CHARS,
  MAX_FILE_WRITE_BYTES,
  type FileOpResultWire,
  type ReadFileResultWire,
} from "@extensions/websocket/protocol.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import type { AuthMiddleware } from "@extensions/websocket/auth.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import { createWsMockWs } from "../mocks/websocket.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TMP = mkdtempSync(join(TMP_PARENT, "hotdog-fsops-"));
const ROOT_A = join(TMP, "roots", "rootA");
const ROOT_B = join(TMP, "roots", "rootB");
const OUTSIDE = join(TMP, "outside");

const SENTINELS = ["SENTINEL-OUTSIDE", "SENTINEL-SSH", "SENTINEL-ENV", "SENTINEL-TARGET"];

/** Deterministic past epoch (seconds) for utimesSync'd seeds: guarantees the
 *  winner's NOW-mtime differs from the shared base in the concurrency pins. */
const FIXED_PAST_S = 1_600_000_000;

beforeAll(() => {
  mkdirSync(ROOT_A, { recursive: true });
  mkdirSync(ROOT_B, { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });

  writeFileSync(join(ROOT_A, "alpha.txt"), "alpha\n");
  mkdirSync(join(ROOT_A, "pack"), { recursive: true });
  writeFileSync(join(ROOT_A, "pack", "inner.txt"), "inner\n");
  mkdirSync(join(ROOT_A, "empty-dir"), { recursive: true });

  mkdirSync(join(ROOT_A, ".ssh"), { recursive: true });
  writeFileSync(join(ROOT_A, ".ssh", "id_ed25519"), "SENTINEL-SSH\n");
  writeFileSync(join(ROOT_A, ".env"), "SENTINEL-ENV\n");

  // IN-root symlink pair: link -> file inside roots (resolveSafe passes it,
  // the ops must still treat the LINK as the entry: unlink it, never its
  // target; saveFile refuses to write THROUGH it).
  writeFileSync(join(ROOT_A, "target.txt"), "SENTINEL-TARGET\n");
  symlinkSync("target.txt", join(ROOT_A, "inlink"));
  symlinkSync("pack", join(ROOT_A, "dirlink"));
  // In-root link to a DENIED dir: resolveSafe blesses the LINK (escape and
  // deny are different questions), and a NON-EXISTENT final component falls
  // back to the LEXICAL spelling -- only the landing-dir gate closes it.
  symlinkSync(".ssh", join(ROOT_A, "sshlink"));

  writeFileSync(join(OUTSIDE, "out-secret.txt"), "SENTINEL-OUTSIDE\n");
  symlinkSync(join(OUTSIDE, "out-secret.txt"), join(ROOT_A, "chain")); // escapes roots
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const core = { resolved: { workspaceRoots: [ROOT_A, ROOT_B] } } as unknown as CoreContext;

const bridgeStub = {
  peek: () => null,
  cancel: () => {},
  answer: () => false,
  clear: () => {},
} as unknown as WebSocketQuestionBridge;

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

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

/** One op over the wire, one reply, parsed. */
async function op(msg: Record<string, unknown>): Promise<FileOpResultWire> {
  const replies = await send(createWsMockWs(), msg);
  expect(replies).toHaveLength(1);
  return parse<FileOpResultWire>(replies[0]!);
}

// ── createFile / createDir ───────────────────────────────────────────────────

describe("createFile / createDir", () => {
  it("happy path: empty file lands, dir lands, reply carries the resolved path", async () => {
    const f = await op({ type: C2S.CREATE_FILE, requestId: 1, path: "fresh.txt" });
    expect(f.type).toBe(S2C.FILE_OP_RESULT);
    expect(f.requestId).toBe(1);
    expect(f.path).toBe(join(ROOT_A, "fresh.txt"));
    expect(readFileSync(join(ROOT_A, "fresh.txt"), "utf8")).toBe("");

    const d = await op({ type: C2S.CREATE_DIR, requestId: 2, path: "fresh-dir" });
    expect(d.error).toBeUndefined();
    expect(lstatSync(join(ROOT_A, "fresh-dir")).isDirectory()).toBe(true);
  });

  it("exists-conflict: file, dir and symlink targets all refuse, nothing clobbered", async () => {
    for (const taken of ["alpha.txt", "pack", "inlink"]) {
      const file = await op({ type: C2S.CREATE_FILE, requestId: 3, path: taken });
      expect(file.error).toContain("already exists");
      const dir = await op({ type: C2S.CREATE_DIR, requestId: 4, path: taken });
      expect(dir.error).toContain("already exists");
      expect("path" in file).toBe(false);
    }
    // The pre-existing bytes survived all six refusals.
    expect(readFileSync(join(ROOT_A, "alpha.txt"), "utf8")).toBe("alpha\n");
    expect(readFileSync(join(ROOT_A, "target.txt"), "utf8")).toBe("SENTINEL-TARGET\n");
  });

  it("parents must already exist (no mkdir -p)", async () => {
    const deep = await op({ type: C2S.CREATE_FILE, requestId: 5, path: "no/such/dir/file.txt" });
    expect(deep.error).toContain("parent directory not found");
    expect(existsSync(join(ROOT_A, "no"))).toBe(false);
  });

  it("refuses a symlink AS the create target's final component (no write at the link's target)", async () => {
    // chain -> OUTSIDE: resolveSafe rejects the link itself (escape), so the
    // create never happens.
    const reply = await op({ type: C2S.CREATE_FILE, requestId: 6, path: "chain" });
    expect(reply.error).toContain("Symlink escape rejected");
    expect(existsSync(join(OUTSIDE, "chain"))).toBe(false);
  });
});

// ── Confinement (sentinel sweep across EVERY op) ─────────────────────────────

describe("file ops confinement", () => {
  const escapeCases: Array<{ label: string; send: (id: number) => Record<string, unknown> }> = [
    { label: "createFile ../ outside", send: (id) => ({ type: C2S.CREATE_FILE, requestId: id, path: "../outside/new.txt" }) },
    { label: "createFile absolute outside", send: (id) => ({ type: C2S.CREATE_FILE, requestId: id, path: join(OUTSIDE, "new.txt") }) },
    { label: "createFile deny target (.ssh/)", send: (id) => ({ type: C2S.CREATE_FILE, requestId: id, path: ".ssh/newkey" }) },
    { label: "createFile deny target (.env*)", send: (id) => ({ type: C2S.CREATE_FILE, requestId: id, path: ".env.prod" }) },
    { label: "createFile deny PARENT dir", send: (id) => ({ type: C2S.CREATE_FILE, requestId: id, path: ".ssh/sub/deep.txt" }) },
    { label: "createDir ../ outside", send: (id) => ({ type: C2S.CREATE_DIR, requestId: id, path: "../outside/newdir" }) },
    { label: "createDir deny (.aws)", send: (id) => ({ type: C2S.CREATE_DIR, requestId: id, path: ".aws" }) },
    { label: "rename escape oldPath", send: (id) => ({ type: C2S.RENAME_PATH, requestId: id, oldPath: "../outside/out-secret.txt", newPath: "stolen.txt" }) },
    { label: "rename escape newPath", send: (id) => ({ type: C2S.RENAME_PATH, requestId: id, oldPath: "alpha.txt", newPath: "../outside/stolen.txt" }) },
    { label: "rename deny OLD side", send: (id) => ({ type: C2S.RENAME_PATH, requestId: id, oldPath: ".env", newPath: "innocent.txt" }) },
    { label: "rename deny NEW side", send: (id) => ({ type: C2S.RENAME_PATH, requestId: id, oldPath: "alpha.txt", newPath: ".env" }) },
    { label: "rename deny NEW side (.ssh dir)", send: (id) => ({ type: C2S.RENAME_PATH, requestId: id, oldPath: "pack", newPath: ".ssh" }) },
    { label: "rename symlink ESCAPING target as oldPath", send: (id) => ({ type: C2S.RENAME_PATH, requestId: id, oldPath: "chain", newPath: "freed.txt" }) },
    { label: "delete escape", send: (id) => ({ type: C2S.DELETE_PATH, requestId: id, path: "../outside/out-secret.txt" }) },
    { label: "delete absolute outside", send: (id) => ({ type: C2S.DELETE_PATH, requestId: id, path: join(OUTSIDE, "out-secret.txt") }) },
    { label: "delete deny (.env)", send: (id) => ({ type: C2S.DELETE_PATH, requestId: id, path: ".env" }) },
    { label: "delete deny (.ssh/)", send: (id) => ({ type: C2S.DELETE_PATH, requestId: id, path: ".ssh/id_ed25519" }) },
    { label: "delete via escaping symlink", send: (id) => ({ type: C2S.DELETE_PATH, requestId: id, path: "chain" }) },
    { label: "saveFile escape", send: (id) => ({ type: C2S.SAVE_FILE, requestId: id, path: "../outside/pwned.txt", content: "x" }) },
    { label: "saveFile deny (.env)", send: (id) => ({ type: C2S.SAVE_FILE, requestId: id, path: ".env", content: "x" }) },
    { label: "saveFile via escaping symlink", send: (id) => ({ type: C2S.SAVE_FILE, requestId: id, path: "chain", content: "x" }) },
    { label: "createFile through link INTO a deny dir", send: (id) => ({ type: C2S.CREATE_FILE, requestId: id, path: "sshlink/newkey" }) },
    { label: "createDir through link INTO a deny dir", send: (id) => ({ type: C2S.CREATE_DIR, requestId: id, path: "sshlink/subdir" }) },
    { label: "rename NEW side through link INTO a deny dir", send: (id) => ({ type: C2S.RENAME_PATH, requestId: id, oldPath: "alpha.txt", newPath: "sshlink/stolen.txt" }) },
    { label: "saveFile through link INTO a deny dir", send: (id) => ({ type: C2S.SAVE_FILE, requestId: id, path: "sshlink/pwned.txt", content: "x" }) },
  ];
  for (const { label, send: frame } of escapeCases) {
    it(`${label}: refused honestly, sentinel content NOWHERE in the reply`, async () => {
      const replies = await send(createWsMockWs(), frame(100));
      expect(replies).toHaveLength(1);
      const raw = replies[0]!;
      expectNoSentinel(raw);
      const reply = parse<Record<string, unknown>>(raw);
      expect(typeof reply.error).toBe("string");
      expect((reply.error as string).split("\n")).toHaveLength(1);
      expect(raw).not.toContain("at ");
      expect("path" in reply).toBe(false);
    });
  }

  it("a refused rename moves NOTHING (denylist new-side keeps pack in place)", async () => {
    await op({ type: C2S.RENAME_PATH, requestId: 101, oldPath: "pack", newPath: ".aws" });
    expect(existsSync(join(ROOT_A, "pack", "inner.txt"))).toBe(true);
    expect(existsSync(join(ROOT_A, ".aws"))).toBe(false);
  });

  it("a refused delete removes NOTHING (deny .env survives with its bytes)", async () => {
    const reply = await op({ type: C2S.DELETE_PATH, requestId: 102, path: ".env" });
    expect(reply.error).toContain("Denylisted path rejected");
    expect(readFileSync(join(ROOT_A, ".env"), "utf8")).toBe("SENTINEL-ENV\n");
  });

  it("a DENY dir reached THROUGH an in-root link gates every landing (nothing stirs)", async () => {
    // sshlink -> .ssh: the direct spellings above refuse via the realpath
    // deny recheck, but a create/save/rename lands a NON-EXISTENT final
    // component, whose resolveSafe verdict is lexical. The landing-dir gate
    // (resolveSafe on the parent) is what refuses; pin that NOTHING lands.
    for (const frame of [
      { type: C2S.CREATE_FILE, requestId: 103, path: "sshlink/newkey" },
      { type: C2S.CREATE_DIR, requestId: 104, path: "sshlink/subdir" },
      { type: C2S.SAVE_FILE, requestId: 105, path: "sshlink/pwned.txt", content: "x" },
      { type: C2S.RENAME_PATH, requestId: 106, oldPath: "empty-dir", newPath: "sshlink/carried" },
    ]) {
      const reply = await op(frame);
      expect(reply.error).toContain("Denylisted path rejected");
    }
    expect(readdirSync(join(ROOT_A, ".ssh"))).toEqual(["id_ed25519"]);
    expect(existsSync(join(ROOT_A, "empty-dir"))).toBe(true); // the refused rename moved nothing
  });
});

// ── renamePath ───────────────────────────────────────────────────────────────

describe("renamePath", () => {
  it("happy path: file renames, reply carries the NEW resolved path", async () => {
    writeFileSync(join(ROOT_A, "rn-src.txt"), "rn\n");
    const reply = await op({ type: C2S.RENAME_PATH, requestId: 10, oldPath: "rn-src.txt", newPath: "rn-dst.txt" });
    expect(reply.path).toBe(join(ROOT_A, "rn-dst.txt"));
    expect(existsSync(join(ROOT_A, "rn-src.txt"))).toBe(false);
    expect(readFileSync(join(ROOT_A, "rn-dst.txt"), "utf8")).toBe("rn\n");
  });

  it("refuses a missing source and an existing target", async () => {
    const missing = await op({ type: C2S.RENAME_PATH, requestId: 11, oldPath: "nope.txt", newPath: "x.txt" });
    expect(missing.error).toContain("not found");
    const taken = await op({ type: C2S.RENAME_PATH, requestId: 12, oldPath: "alpha.txt", newPath: "rn-dst.txt" });
    expect(taken.error).toContain("target already exists");
    expect(existsSync(join(ROOT_A, "alpha.txt"))).toBe(true);
  });

  it("refuses renaming a workspace ROOT itself", async () => {
    const reply = await op({ type: C2S.RENAME_PATH, requestId: 13, oldPath: ROOT_A, newPath: join(ROOT_A, "sibling") });
    expect(reply.error).toContain("cannot rename a workspace root");
    expect(existsSync(ROOT_A)).toBe(true);
  });

  it("a directory rename carries its subtree; descendants answer where the NEW spelling says", async () => {
    mkdirSync(join(ROOT_A, "carry"), { recursive: true });
    writeFileSync(join(ROOT_A, "carry", "deep-note.txt"), "deep\n");
    mkdirSync(join(ROOT_A, "host"), { recursive: true });
    const reply = await op({ type: C2S.RENAME_PATH, requestId: 14, oldPath: "carry", newPath: join("host", "moved") });
    expect(reply.path).toBe(join(ROOT_A, "host", "moved"));
    // The subtree physically moved: reading the OLD spelling now misses...
    const gone = await op({ type: C2S.SAVE_FILE, requestId: 15, path: "carry/deep-note.txt", content: "x", baseMtimeMs: 1 });
    expect(gone.error).toBeTruthy();
    // ...and the NEW spelling holds the bytes (resolveSafe runs there).
    const read = await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 16, path: "host/moved/deep-note.txt" });
    expect(parse<ReadFileResultWire>(read[0]!).content).toBe("deep\n");
  });

  it("renaming a directory to a DENY-named destination refuses WHOLE-op (subtree stays put)", async () => {
    mkdirSync(join(ROOT_A, "carry2"), { recursive: true });
    writeFileSync(join(ROOT_A, "carry2", "kid.txt"), "kid\n");
    // ".aws" is a deny rule at any depth: the whole move is refused BEFORE
    // anything moves, so the subtree stays exactly where roots/deny expect.
    const reply = await op({ type: C2S.RENAME_PATH, requestId: 17, oldPath: "carry2", newPath: ".aws" });
    expect(reply.error).toContain("Denylisted path rejected");
    expect(readFileSync(join(ROOT_A, "carry2", "kid.txt"), "utf8")).toBe("kid\n");
    expect(existsSync(join(ROOT_A, ".aws"))).toBe(false);
  });

  it("an IN-ROOT symlink renames as itself (the link moves, the target never does)", async () => {
    symlinkSync("target.txt", join(ROOT_A, "mvlink"));
    const reply = await op({ type: C2S.RENAME_PATH, requestId: 18, oldPath: "mvlink", newPath: "mvlink2" });
    expect(reply.error).toBeUndefined();
    expect(lstatSync(join(ROOT_A, "mvlink2")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(ROOT_A, "mvlink2"), "utf8")).toBe("SENTINEL-TARGET\n");
    expect(existsSync(join(ROOT_A, "mvlink"))).toBe(false);
  });
});

// ── deletePath ───────────────────────────────────────────────────────────────

describe("deletePath", () => {
  it("happy path: a file goes away", async () => {
    writeFileSync(join(ROOT_A, "del-me.txt"), "bye\n");
    const reply = await op({ type: C2S.DELETE_PATH, requestId: 20, path: "del-me.txt" });
    expect(reply.path).toBe(join(ROOT_A, "del-me.txt"));
    expect(existsSync(join(ROOT_A, "del-me.txt"))).toBe(false);
  });

  it("directories delete RECURSIVELY (the UI confirms; the server deletes)", async () => {
    mkdirSync(join(ROOT_A, "rm-tree", "deep"), { recursive: true });
    writeFileSync(join(ROOT_A, "rm-tree", "deep", "a.txt"), "a\n");
    writeFileSync(join(ROOT_A, "rm-tree", "b.txt"), "b\n");
    const reply = await op({ type: C2S.DELETE_PATH, requestId: 21, path: "rm-tree" });
    expect(reply.error).toBeUndefined();
    expect(existsSync(join(ROOT_A, "rm-tree"))).toBe(false);
  });

  it("refuses deleting a workspace ROOT", async () => {
    const reply = await op({ type: C2S.DELETE_PATH, requestId: 22, path: ROOT_B });
    expect(reply.error).toContain("cannot delete a workspace root");
    expect(existsSync(ROOT_B)).toBe(true);
  });

  it("a symlinked entry is UNLINKED, never followed: the link dies, its target survives", async () => {
    symlinkSync("target.txt", join(ROOT_A, "unlink-me"));
    const reply = await op({ type: C2S.DELETE_PATH, requestId: 23, path: "unlink-me" });
    expect(reply.error).toBeUndefined();
    expect(existsSync(join(ROOT_A, "unlink-me"))).toBe(false); // lstat said link -> unlink
    expect(readFileSync(join(ROOT_A, "target.txt"), "utf8")).toBe("SENTINEL-TARGET\n");
    // Same for a link pointing at a DIRECTORY: recursive rm must not walk into
    // (and delete) the linked tree.
    symlinkSync("pack", join(ROOT_A, "unlink-dirlink"));
    const dirReply = await op({ type: C2S.DELETE_PATH, requestId: 24, path: "unlink-dirlink" });
    expect(dirReply.error).toBeUndefined();
    expect(existsSync(join(ROOT_A, "unlink-dirlink"))).toBe(false);
    expect(readFileSync(join(ROOT_A, "pack", "inner.txt"), "utf8")).toBe("inner\n");
  });

  it("not found answers honestly", async () => {
    const reply = await op({ type: C2S.DELETE_PATH, requestId: 25, path: "ghost.txt" });
    expect(reply.error).toContain("not found");
  });
});

// ── saveFile ─────────────────────────────────────────────────────────────────

describe("saveFile", () => {
  const stampFile = join(ROOT_A, "stamp.txt");
  const FIXED_MTIME_S = 1_700_000_000; // a deterministic past, via utimesSync

  it("cap math pinned: MAX_FILE_WRITE_BYTES === MAX_FILE_READ_CHARS (256 KiB of BYTES)", () => {
    expect(MAX_FILE_WRITE_BYTES).toBe(MAX_FILE_READ_CHARS);
    expect(MAX_FILE_WRITE_BYTES).toBe(256 * 1024);
  });

  it("happy path: new file (base absent), reply carries the NEW mtimeMs", async () => {
    const reply = await op({ type: C2S.SAVE_FILE, requestId: 30, path: "saved.txt", content: "hello\n" });
    expect(reply.error).toBeUndefined();
    expect(reply.path).toBe(join(ROOT_A, "saved.txt"));
    expect(reply.mtimeMs).toBeNumber();
    expect(readFileSync(join(ROOT_A, "saved.txt"), "utf8")).toBe("hello\n");
  });

  it("conflict gate: stale base refuses with conflict:true + the CURRENT mtime, bytes untouched", async () => {
    writeFileSync(stampFile, "original\n");
    utimesSync(stampFile, FIXED_MTIME_S, FIXED_MTIME_S); // deterministic on-disk mtime
    const stale = await op({ type: C2S.SAVE_FILE, requestId: 31, path: "stamp.txt", content: "clobber\n", baseMtimeMs: FIXED_MTIME_S * 1000 - 1 });
    expect(stale.conflict).toBe(true);
    expect(stale.mtimeMs).toBe(FIXED_MTIME_S * 1000); // distinguishable + carries the fresh value
    expect(typeof stale.error).toBe("string");
    expect(readFileSync(stampFile, "utf8")).toBe("original\n"); // NOTHING written
    // The documented overwrite flow: resend with the FRESH mtime, and it lands.
    const overwrite = await op({ type: C2S.SAVE_FILE, requestId: 32, path: "stamp.txt", content: "chosen\n", baseMtimeMs: stale.mtimeMs });
    expect(overwrite.error).toBeUndefined();
    expect(readFileSync(stampFile, "utf8")).toBe("chosen\n");
  });

  it("base 0/absent against an EXISTING file is a conflict (the create-then-save doctrine)", async () => {
    for (const base of [undefined, 0]) {
      const reply = await op({ type: C2S.SAVE_FILE, requestId: 33, path: "stamp.txt", content: "sneak\n", ...(base !== undefined ? { baseMtimeMs: base } : {}) });
      expect(reply.conflict).toBe(true);
    }
    expect(readFileSync(stampFile, "utf8")).toBe("chosen\n");
  });

  it("readFile answers mtimeMs (the editor's base), absent on refusals", async () => {
    const read = await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 34, path: "stamp.txt" });
    const reply = parse<ReadFileResultWire>(read[0]!);
    expect(reply.mtimeMs).toBeNumber();
    const denied = await send(createWsMockWs(), { type: C2S.READ_FILE, requestId: 35, path: ".env" });
    expect("mtimeMs" in parse<ReadFileResultWire>(denied[0]!)).toBe(false);
  });

  it("refuses directories; refuses writing THROUGH a symlink (target untouched)", async () => {
    const dir = await op({ type: C2S.SAVE_FILE, requestId: 36, path: "pack", content: "x" });
    expect(dir.error).toContain("is a directory");
    // inlink -> target.txt (both in roots): resolveSafe PASSES the link, and
    // saveFile still refuses -- the O_NOFOLLOW posture gates on the entry.
    const link = await op({ type: C2S.SAVE_FILE, requestId: 37, path: "inlink", content: "through\n" });
    expect(link.error).toContain("symlink");
    expect(readFileSync(join(ROOT_A, "target.txt"), "utf8")).toBe("SENTINEL-TARGET\n");
    expect(readFileSync(join(ROOT_A, "inlink"), "utf8")).toBe("SENTINEL-TARGET\n"); // link still points at the untouched target
  });

  it("cap boundary: exactly-at-cap writes, ONE BYTE OVER refuses before write, NO temp residue", async () => {
    const atCap = "a".repeat(MAX_FILE_WRITE_BYTES); // 262144 ASCII bytes === chars
    const ok = await op({ type: C2S.SAVE_FILE, requestId: 38, path: "cap.txt", content: atCap });
    expect(ok.error).toBeUndefined();
    expect(readFileSync(join(ROOT_A, "cap.txt")).length).toBe(MAX_FILE_WRITE_BYTES);

    writeFileSync(join(ROOT_A, "cap-orig.txt"), "keep\n");
    const over = await op({ type: C2S.SAVE_FILE, requestId: 39, path: "cap-orig.txt", content: "b".repeat(MAX_FILE_WRITE_BYTES + 1), baseMtimeMs: Math.round(readMtimeMs(join(ROOT_A, "cap-orig.txt"))) });
    expect(over.error).toContain(`${MAX_FILE_WRITE_BYTES}-byte write cap`);
    expect(readFileSync(join(ROOT_A, "cap-orig.txt"), "utf8")).toBe("keep\n"); // untouched, no temp wrote first
    expect(readdirSync(ROOT_A).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("cap is BYTES: multibyte content over the byte cap refuses though under the char count", async () => {
    // 90k U+1D11E (MUSICAL SYMBOL G) = 180_000 UTF-16 chars but 360_000 UTF-8
    // bytes: under the char cap, over the byte cap. The byte gate is honest.
    const heavy = "\u{1D11E}".repeat(90_000);
    expect(heavy.length).toBeLessThan(MAX_FILE_WRITE_BYTES);
    const reply = await op({ type: C2S.SAVE_FILE, requestId: 40, path: "heavy.txt", content: heavy });
    expect(reply.error).toContain("360000 bytes");
    expect(existsSync(join(ROOT_A, "heavy.txt"))).toBe(false);
  });

  it("atomicity: a temp write that cannot land answers honestly, ORIGINAL untouched, no residue", async () => {
    // NAME_MAX overflow: a 250-char basename + the .<pid>.<seq>.save.tmp
    // suffix exceeds the 255-byte limit, so the temp writeFile fails BEFORE
    // any byte moves -- the target keeps its bytes, no temp exists to sweep,
    // and the answer is the honest fs line (a failed write never touches the
    // original).
    const name = "x".repeat(250);
    writeFileSync(join(ROOT_A, name), "precious\n");
    try {
      const reply = await op({
        type: C2S.SAVE_FILE,
        requestId: 41,
        path: name,
        content: "new\n",
        baseMtimeMs: Math.round(readMtimeMs(join(ROOT_A, name))),
      });
      expect(typeof reply.error).toBe("string");
      expect(reply.error).toContain("ENAMETOOLONG");
      expect(readFileSync(join(ROOT_A, name), "utf8")).toBe("precious\n");
      expect(readdirSync(ROOT_A).filter((n) => n.includes(".save.tmp"))).toEqual([]);
    } finally {
      rmSync(join(ROOT_A, name), { force: true });
    }
  });

  it("same-path concurrency: racing saves with ONE base -> exactly one ok + one conflict, never mixed bytes", async () => {
    // Two async saves of the SAME path sharing the same fresh base must
    // never interleave inside the critical section (a shared pid temp meant
    // mixed/sparse final bytes, a losing rename answering "not found", and
    // ok replies about writes that did not land).
    // Serialized per path, the conflict gate sees the first commit: exactly
    // one writer answers ok, the other answers conflict:true with the
    // winner's fresh mtime (the documented overwrite-or-reload flow).
    const w = workspaceFor(core);
    const A = "A".repeat(200_000);
    const B = "B".repeat(200_000);
    for (let round = 0; round < 12; round++) {
      const path = `race-${round}.txt`;
      writeFileSync(join(ROOT_A, path), "seed\n");
      utimesSync(join(ROOT_A, path), FIXED_PAST_S, FIXED_PAST_S); // deterministic old stamp
      const [ra, rb] = await Promise.all([
        saveFilePayload(w, path, A, FIXED_PAST_S * 1000),
        saveFilePayload(w, path, B, FIXED_PAST_S * 1000),
      ]);
      const replies = [ra, rb];
      const oks = replies.filter((r) => r.error === undefined);
      const conflicts = replies.filter((r) => r.conflict === true);
      expect(oks.length).toBe(1);
      expect(conflicts.length).toBe(1);
      const final = readFileSync(join(ROOT_A, path), "utf8");
      // NEVER a mix, NEVER a sparse hole: the file is exactly ONE writer's bytes.
      expect(final === A || final === B).toBe(true);
      // The conflict carries the winner's fresh mtime: resend with it lands.
      expect(conflicts[0]!.mtimeMs).toBe(oks[0]!.mtimeMs);
      expect(readdirSync(ROOT_A).filter((n) => n.includes(".save.tmp"))).toEqual([]);
      const overwrite = await saveFilePayload(w, path, "chosen\n", conflicts[0]!.mtimeMs);
      expect(overwrite.error).toBeUndefined();
      expect(readFileSync(join(ROOT_A, path), "utf8")).toBe("chosen\n");
      rmSync(join(ROOT_A, path), { force: true });
    }
  });

  it("same-path concurrency over the WIRE: two sockets, one base -> one ok + one conflict, one reply each", async () => {
    writeFileSync(join(ROOT_A, "wire-race.txt"), "seed\n");
    utimesSync(join(ROOT_A, "wire-race.txt"), FIXED_PAST_S, FIXED_PAST_S);
    const wsA = createWsMockWs();
    const wsB = createWsMockWs();
    await Promise.all([
      routeMessage(wsA, { type: C2S.SAVE_FILE, requestId: 1, path: "wire-race.txt", content: "AAA", baseMtimeMs: FIXED_PAST_S * 1000 } as never, {} as never, undefined, bridgeStub, core),
      routeMessage(wsB, { type: C2S.SAVE_FILE, requestId: 2, path: "wire-race.txt", content: "BBB", baseMtimeMs: FIXED_PAST_S * 1000 } as never, {} as never, undefined, bridgeStub, core),
    ]);
    await flush();
    expect(wsA.messages).toHaveLength(1);
    expect(wsB.messages).toHaveLength(1);
    const replies = [parse<FileOpResultWire>(wsA.messages[0]!), parse<FileOpResultWire>(wsB.messages[0]!)];
    expect(replies.filter((r) => r.error === undefined)).toHaveLength(1);
    expect(replies.filter((r) => r.conflict === true)).toHaveLength(1);
    const final = readFileSync(join(ROOT_A, "wire-race.txt"), "utf8");
    expect(final === "AAA" || final === "BBB").toBe(true);
  });

  it("rename concurrency: two renames racing onto ONE target -> one lands, the other 'target already exists'", async () => {
    const w = workspaceFor(core);
    for (let round = 0; round < 6; round++) {
      const target = `rt-${round}.txt`;
      const s1 = `r1-${round}.txt`;
      const s2 = `r2-${round}.txt`;
      writeFileSync(join(ROOT_A, s1), "one\n");
      writeFileSync(join(ROOT_A, s2), "two\n");
      const [ra, rb] = await Promise.all([
        renamePayload(w, s1, target),
        renamePayload(w, s2, target),
      ]);
      const replies = [ra, rb];
      expect(replies.filter((r) => r.error === undefined)).toHaveLength(1);
      const refused = replies.find((r) => r.error !== undefined)!;
      expect(refused.error).toContain("target already exists");
      // The target holds EXACTLY the winner's bytes; the loser's file stays put.
      const final = readFileSync(join(ROOT_A, target), "utf8");
      expect(final === "one\n" || final === "two\n").toBe(true);
      const loser = final === "one\n" ? s2 : s1;
      expect(readFileSync(join(ROOT_A, loser), "utf8")).toBe(final === "one\n" ? "two\n" : "one\n");
      rmSync(join(ROOT_A, target), { force: true });
      rmSync(join(ROOT_A, s1), { force: true });
      rmSync(join(ROOT_A, s2), { force: true });
    }
  });

  it("over-cap is refused BEFORE the path is even resolved (garbage path + huge frame: cap error)", async () => {
    const reply = await op({ type: C2S.SAVE_FILE, requestId: 42, path: "../outside/never.txt", content: "x".repeat(MAX_FILE_WRITE_BYTES + 1) });
    expect(reply.error).toContain("-byte write cap");
    expect(existsSync(join(OUTSIDE, "never.txt"))).toBe(false);
  });

  it("non-string content refuses (JSON wire honesty)", async () => {
    const reply = await op({ type: C2S.SAVE_FILE, requestId: 43, path: "notext.txt", content: 42 });
    expect(reply.error).toContain("content must be a string");
  });
});

function readMtimeMs(p: string): number {
  return lstatSync(p).mtimeMs;
}

// ── Plumbing ─────────────────────────────────────────────────────────────────

describe("file ops plumbing", () => {
  it("requestId echoed on EVERY op; reply goes to the REQUESTING socket only", async () => {
    const wsA = createWsMockWs();
    const wsB = createWsMockWs();
    await routeMessage(wsA, { type: C2S.CREATE_FILE, requestId: 55, path: "plumb.txt" } as never, {} as never, undefined, bridgeStub, core);
    await flush();
    await routeMessage(wsA, { type: C2S.DELETE_PATH, requestId: 56, path: "plumb.txt" } as never, {} as never, undefined, bridgeStub, core);
    await flush();
    expect(wsA.messages).toHaveLength(2);
    expect(parse<FileOpResultWire>(wsA.messages[0]!).requestId).toBe(55);
    expect(parse<FileOpResultWire>(wsA.messages[0]!).type).toBe(S2C.FILE_OP_RESULT);
    expect(parse<FileOpResultWire>(wsA.messages[1]!).requestId).toBe(56);
    expect(wsB.messages).toHaveLength(0);
  });

  it("the pre-auth gate covers the write family (fires BEFORE the dispatch table)", async () => {
    const auth = { validateToken: (t: string) => t === "good" } as unknown as AuthMiddleware;
    for (const msg of [
      { type: C2S.CREATE_FILE, requestId: 1, path: "x.txt" },
      { type: C2S.CREATE_DIR, requestId: 2, path: "xd" },
      { type: C2S.RENAME_PATH, requestId: 3, oldPath: "a", newPath: "b" },
      { type: C2S.DELETE_PATH, requestId: 4, path: "x.txt" },
      { type: C2S.SAVE_FILE, requestId: 5, path: "x.txt", content: "x" },
    ]) {
      const ws = createWsMockWs();
      await routeMessage(ws, msg as never, {} as never, auth, bridgeStub, core);
      await flush();
      expect(ws.messages).toHaveLength(1);
      expect(parse<Record<string, unknown>>(ws.messages[0]!).type).toBe(S2C.AUTH_ERROR);
      expect(parse<Record<string, unknown>>(ws.messages[0]!).code).toBe("auth_required");
    }
  });

  it("garbage requestId drops out of the JSON instead of shadowing the payload", async () => {
    const reply = await send(createWsMockWs(), { type: C2S.CREATE_DIR, requestId: "nope", path: "gr-dir" });
    const parsed = parse<Record<string, unknown>>(reply[0]!);
    expect("requestId" in parsed).toBe(false);
    expect(parsed.path).toBe(join(ROOT_A, "gr-dir"));
  });

  it("direct payload helpers keep confinement when called as units (no socket)", async () => {
    const w = workspaceFor(core);
    expect((await createPayload(w, "../outside/x.txt", "file")).error).toContain("Path escape rejected");
    expect((await renamePayload(w, "alpha.txt", join(OUTSIDE, "x.txt"))).error).toContain("Path escape rejected");
    expect((await deletePayload(w, ".ssh")).error).toContain("Denylisted path rejected");
    expect((await saveFilePayload(w, ".env", "x", undefined)).error).toContain("Denylisted path rejected");
  });
});
