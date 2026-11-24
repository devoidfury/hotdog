// head/tail. Real tools over a real Workspace, line accuracy pinned against
// the real `read` tool on the same fixtures. The bounded-window helper gets
// the guarantees that only a TEST can pin: a tail of a sparse 1 GiB file
// reads window + one chunk and nothing more (counting wrapper -- the
// no-whole-read guarantee is a test, not a comment), and the pathological
// density case (1 GiB SINGLE-LINE fixture) scans exactly the 8 MiB cap and
// degrades with the capped-window note. Huge-file probes are SPARSE files
// under /tmp.

import { afterAll, describe, expect, it } from "bun:test";
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestCore, ExtensionLoader, ToolResult } from "@read-receipt/hotdog/testing";
import { HOOKS } from "@core/hooks.ts";
import { ToolContext } from "@core/extensions/tool-context.ts";
import { createToolExecutor } from "@core/tool-executor.ts";
import { Workspace } from "@utils/workspace.ts";
import { ReadTool } from "@extensions/core-tools/read.ts";
import {
  boundedWindow,
  createHeadTool,
  createTailTool,
  renderHeadWindow,
  renderTailWindow,
  type WindowReader,
} from "@experimental/codemode/files-tools.ts";
import {
  callableInfos,
  CodemodeBridge,
} from "@experimental/codemode/bridge.ts";
import { readRunJournal } from "@experimental/codemode/journal.ts";
import { WINDOW_CHUNK_BYTES, WINDOW_SCAN_CAP_BYTES } from "@experimental/codemode/options.ts";
import { MockLLMClient, buildStreamResponse, createFixture } from "../helpers.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), "hotdog-codemode-files-"));
const bigRoot = mkdtempSync(join(tmpdir(), "hotdog-codemode-files-big-")); // sparse probes live here

function lines(n: number, prefix = "line"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
}

const MANY = lines(250); // "line 1".."line 250"
const MANY_TEXT = MANY.map((l) => l + "\n").join(""); // trailing newline
const NOEOL = "alpha\nbeta\ngamma";
const UNI = Array.from(
  { length: 40 },
  (_, i) => `日本語 line \u00e9moji \u{1f600} ${i + 1}`,
).map((l) => l + "\n").join("");
// > one 64 KiB chunk (~103 KiB), so head can stop BEFORE EOF ("more exists")
// and tail's window cannot swallow the whole file.
const LOG5K = lines(5000, "log line padded").map((l) => l + "\n").join("");

writeFileSync(join(root, "many.txt"), MANY_TEXT);
writeFileSync(join(root, "noeol.txt"), NOEOL);
writeFileSync(join(root, "empty.txt"), "");
writeFileSync(join(root, "uni.txt"), UNI);
writeFileSync(join(root, "log.txt"), LOG5K);
writeFileSync(join(root, "fake.png"), Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
  Buffer.from("ZZPNGTEXTZZ"),
]));
writeFileSync(join(root, "bin.dat"), "ok1\nok2\n\u0000ZZBINARY-SENTINELZZ\nmore\n");
// Denylist fixtures (workspace.deny defaults include ".ssh").
mkdirsSync(join(root, ".ssh"));
writeFileSync(join(root, ".ssh", "id_test"), "ZZSSHD-SENTINELZZ");
symlinkSync(join(root, ".ssh"), join(root, "sneaky"));

function mkdirsSync(p: string): void {
  Bun.spawnSync(["mkdir", "-p", p]);
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(bigRoot, { recursive: true, force: true });
});

const head = createHeadTool();
const tail = createTailTool();

function ctxWith(dir: string): ToolContext {
  const ctx = new ToolContext();
  ctx.set("workspace", new Workspace(dir));
  return ctx;
}

const ctx = ctxWith(root);
const reader = new ReadTool({ readLimit: 200, maxImageSize: 1_000_000 });

function entriesOf(r: ToolResult): Map<string, string> {
  return r.metadata ?? new Map();
}

// ── head ─────────────────────────────────────────────────────────────────────

describe("head (§3.9)", () => {
  it("line-accurate vs read on the same fixtures, posture parity (path + showing entries)", async () => {
    const h5 = (await head.execute({ path: "many.txt", lines: 5 }, ctx)) as ToolResult;
    const r5 = (await reader.execute({ path: "many.txt", limit: 5 }, ctx)) as ToolResult;
    expect(h5.isOk()).toBe(true);
    expect(h5.output).toBe(r5.output);
    expect(h5.output.split("\n")).toEqual(MANY.slice(0, 5));
    // head knows the total here because the window reached EOF: same string
    // read puts in its `showing` entry.
    expect(entriesOf(h5).get("showing")).toBe("1-5 (of 251 total)");
    expect(entriesOf(h5).get("showing")).toBe(entriesOf(r5).get("showing"));
    expect(entriesOf(h5).get("path")).toBe(join(root, "many.txt"));

    // No trailing newline: 3 lines total, exact match with read.
    const hn = (await head.execute({ path: "noeol.txt" }, ctx)) as ToolResult;
    const rn = (await reader.execute({ path: "noeol.txt" }, ctx)) as ToolResult;
    expect(hn.output).toBe("alpha\nbeta\ngamma");
    expect(hn.output).toBe(rn.output);
    expect(entriesOf(hn).get("showing")).toBe("1-3 (of 3 total)");
    expect(entriesOf(hn).get("showing")).toBe(entriesOf(rn).get("showing"));

    // Empty file: read's split-semantics count it as one empty line; so does head.
    const he = (await head.execute({ path: "empty.txt" }, ctx)) as ToolResult;
    const re = (await reader.execute({ path: "empty.txt" }, ctx)) as ToolResult;
    expect(he.isOk()).toBe(true);
    expect(he.output).toBe(re.output);
    expect(entriesOf(he).get("showing")).toBe(entriesOf(re).get("showing"));
    expect(entriesOf(he).get("showing")).toBe("1-1 (of 1 total)");
  });

  it("EOF inside the window says (of T total); a window that stops short says (more exists)", async () => {
    const h = (await head.execute({ path: "log.txt", lines: 3 }, ctx)) as ToolResult;
    expect(h.output.split("\n")).toEqual(lines(3, "log line padded"));
    expect(entriesOf(h).get("showing")).toBe("1-3 (more exists)");
    // The same head on the small file reached EOF and reports the total.
    const small = (await head.execute({ path: "noeol.txt", lines: 3 }, ctx)) as ToolResult;
    expect(entriesOf(small).get("showing")).toBe("1-3 (of 3 total)");
  });

  it("lines bounds: 0 and 10001 (and junk) refused; 1 and 10000 accepted", async () => {
    for (const bad of [0, 10001, 1.5, "200", null, true]) {
      const r = (await head.execute({ path: "many.txt", lines: bad as number }, ctx)) as ToolResult;
      expect(r.isErr(), `lines=${String(bad)}`).toBe(true);
      expect(r.error).toContain("between 1 and 10000");
    }
    expect(((await head.execute({ path: "many.txt", lines: 1 }, ctx)) as ToolResult).isOk()).toBe(true);
    const big = (await head.execute({ path: "many.txt", lines: 10000 }, ctx)) as ToolResult;
    expect(big.isOk()).toBe(true);
    const noPath = (await head.execute({ lines: 5 }, ctx)) as ToolResult;
    expect(noPath.isErr()).toBe(true);
    expect(noPath.error).toContain("expects a JSON object");
  });

  it("image and binary files are refused with the error pointing at read", async () => {
    const img = (await head.execute({ path: "fake.png" }, ctx)) as ToolResult;
    expect(img.isErr()).toBe(true);
    expect(img.error).toContain("read");
    expect(img.error).toContain(".png");
    expect(`${img.output}${img.error ?? ""}`).not.toContain("ZZPNGTEXTZZ"); // refused before bytes

    const bin = (await head.execute({ path: "bin.dat" }, ctx)) as ToolResult;
    expect(bin.isErr()).toBe(true);
    expect(bin.error).toContain("NUL");
    expect(bin.error).toContain("read");
    expect(`${bin.output}${bin.error ?? ""}`).not.toContain("ZZBINARY-SENTINELZZ");
  });

  it("denylist paths get the boundary's shaped error with zero bytes read; symlink-into-denylist too (realpath leg)", async () => {
    const direct = (await head.execute({ path: ".ssh/id_test" }, ctx)) as ToolResult;
    expect(direct.isErr()).toBe(true);
    expect(direct.error).toContain("Denylisted path rejected");
    expect(direct.error).toContain(".ssh");
    expect(`${direct.output}${direct.error ?? ""}`).not.toContain("ZZSSHD-SENTINELZZ");

    const viaLink = (await head.execute({ path: "sneaky/id_test" }, ctx)) as ToolResult;
    expect(viaLink.isErr()).toBe(true);
    expect(viaLink.error).toContain("rejected");
    expect(`${viaLink.output}${viaLink.error ?? ""}`).not.toContain("ZZSSHD-SENTINELZZ");

    // Same for tail (shared seam).
    const t = (await tail.execute({ path: ".ssh/id_test" }, ctx)) as ToolResult;
    expect(t.isErr()).toBe(true);
    expect(t.error).toContain("Denylisted path rejected");
  });

  it("no workspace mounted -> honest error, and tail mirrors the bounds/binary refusals", async () => {
    const bare = (await head.execute({ path: "many.txt" }, new ToolContext())) as ToolResult;
    expect(bare.isErr()).toBe(true);
    expect(bare.error).toContain("workspace");

    const badLines = (await tail.execute({ path: "many.txt", lines: 0 }, ctx)) as ToolResult;
    expect(badLines.isErr()).toBe(true);
    expect(badLines.error).toContain("between 1 and 10000");
    const img = (await tail.execute({ path: "fake.png" }, ctx)) as ToolResult;
    expect(img.isErr()).toBe(true);
    expect(img.error).toContain("read");
  });
});

// ── tail ─────────────────────────────────────────────────────────────────────

describe("tail (§3.9)", () => {
  it("line-accurate vs read, byte-exact window entry, B=0 when the whole file is shown", async () => {
    const t5 = (await tail.execute({ path: "many.txt", lines: 5 }, ctx)) as ToolResult;
    expect(t5.output.split("\n")).toEqual(MANY.slice(-5));
    // read's window for the same lines matches exactly (posture parity).
    const rSame = (await reader.execute(
      { path: "many.txt", offset: 245, limit: 5 },
      ctx,
    )) as ToolResult;
    expect(t5.output).toBe(rSame.output);
    const expectedB = Buffer.byteLength(MANY.slice(0, 245).map((l) => l + "\n").join(""), "utf8");
    expect(entriesOf(t5).get("showing")).toBe(`last 5 lines (window starts at byte ${expectedB})`);
    // No total_lines: the count would need a whole-file pass.
    expect(entriesOf(t5).get("total_lines")).toBeUndefined();

    const all = (await tail.execute({ path: "many.txt", lines: 1000 }, ctx)) as ToolResult;
    expect(entriesOf(all).get("showing")).toBe("last 250 lines (window starts at byte 0)");
    expect(all.output).toBe(MANY_TEXT.slice(0, -1)); // whole file, trailing \n artifact dropped

    // No trailing newline.
    const t2 = (await tail.execute({ path: "noeol.txt", lines: 2 }, ctx)) as ToolResult;
    expect(t2.output).toBe("beta\ngamma");
    expect(entriesOf(t2).get("showing")).toBe("last 2 lines (window starts at byte 6)");
  });

  it("byte window is exact on multibyte content (parity with read, no U+FFFD anywhere)", async () => {
    const uniLines = UNI.trimEnd().split("\n");
    const t = (await tail.execute({ path: "uni.txt", lines: 5 }, ctx)) as ToolResult;
    expect(t.output.split("\n")).toEqual(uniLines.slice(-5));
    const rSame = (await reader.execute(
      { path: "uni.txt", offset: uniLines.length - 5, limit: 5 },
      ctx,
    )) as ToolResult;
    expect(t.output).toBe(rSame.output);
    const expectedB = Buffer.byteLength(
      uniLines.slice(0, uniLines.length - 5).map((l) => l + "\n").join(""),
      "utf8",
    );
    expect(entriesOf(t).get("showing")).toBe(`last 5 lines (window starts at byte ${expectedB})`);
  });

  it("window stops before EOF on the big fixture and drops the leading partial line", async () => {
    const t = (await tail.execute({ path: "log.txt", lines: 4 }, ctx)) as ToolResult;
    expect(t.output.split("\n")).toEqual(
      Array.from({ length: 4 }, (_, i) => `log line padded ${4997 + i}`),
    );
    expect(entriesOf(t).get("showing")).toContain("last 4 lines (window starts at byte ");
    expect(entriesOf(t).get("showing")).not.toContain("byte 0)");
  });
});

// ── the bounded-window helper: the no-whole-read guarantees ─────────────────

/** Counting wrapper around the real fs handle: bytes AS REQUESTED per read.
 *  The no-whole-read guarantee is asserted through this, not asserted in
 *  prose. */
function counting(fh: Awaited<ReturnType<typeof open>>): WindowReader & { totalRead: number } {
  const w: WindowReader & { totalRead: number } = {
    totalRead: 0,
    stat: () => fh.stat(),
    read: (buf, off, len, pos) => {
      w.totalRead += len;
      return fh.read(buf, off, len, pos);
    },
    close: () => fh.close(),
  };
  return w;
}

describe("boundedWindow: size guards on huge files (§3.9)", () => {
  // SPARSE fixtures under /tmp: ftruncate costs nothing, reads hit zero pages.
  function sparseFile(name: string, size: number, writer?: (fd: number) => void): string {
    const p = join(bigRoot, name);
    const fd = openSync(p, "w");
    ftruncateSync(fd, size);
    if (writer) writer(fd);
    closeSync(fd);
    return p;
  }

  it("tail of a sparse 1 GiB file reads window + one chunk and nothing more", async () => {
    const GiB = 1024 * 1024 * 1024;
    const block = lines(210, "sparse").map((l) => l + "\n").join("");
    const p = sparseFile("sparse-tail.txt", GiB, (fd) => {
      writeSync(fd, Buffer.from(block), 0, block.length, GiB - block.length);
    });

    const fh = counting(await open(p, "r"));
    try {
      const win = await boundedWindow(fh, { from: "end", lines: 200 });
      // The dense block sits in the last 4 KiB: ONE chunk answers it all.
      expect(win.scannedBytes).toBe(WINDOW_CHUNK_BYTES);
      expect(fh.totalRead).toBe(WINDOW_CHUNK_BYTES); // window + one chunk == one chunk here
      const { out, showing } = renderTailWindow(win, 200);
      const got = out.split("\n");
      expect(got).toHaveLength(200);
      expect(got[199]).toBe("sparse 210");
      // The first line in the window (sparse 1) rides the dropped partial;
      // the shown run starts at sparse 11.
      expect(got[0]).toBe("sparse 11");
      expect(showing).toContain("(window starts at byte ");
      expect(showing).not.toContain("capped");
    } finally {
      await fh.close();
    }
  });

  it("the pathological density case: 1 GiB SINGLE-LINE tail scans EXACTLY the 8 MiB cap and degrades with the cap note", async () => {
    const GiB = 1024 * 1024 * 1024;
    const p = sparseFile("sparse-oneline.txt", GiB, (fd) => writeSync(fd, Buffer.from("x"), 0, 1, 0));

    const fh = counting(await open(p, "r"));
    try {
      const win = await boundedWindow(fh, { from: "end", lines: 5 });
      expect(win.scannedBytes).toBe(WINDOW_SCAN_CAP_BYTES); // exactly the cap, byte for byte
      expect(fh.totalRead).toBe(WINDOW_SCAN_CAP_BYTES); // counting wrapper agrees
      expect(win.capped).toBe(true);
      expect(win.atStart).toBe(false);
      expect(win.text).toBe(""); // zero newlines: the only "line" is a partial -> dropped
      const { showing } = renderTailWindow(win, 5);
      expect(showing).toBe(
        `last 0 lines (window starts at byte ${GiB - WINDOW_SCAN_CAP_BYTES}); ` +
          `window capped at ${WINDOW_SCAN_CAP_BYTES} bytes; earlier bytes not scanned`,
      );
    } finally {
      await fh.close();
    }

    // head is the forward twin: same cap, "later bytes" note.
    const fh2 = counting(await open(p, "r"));
    try {
      const win = await boundedWindow(fh2, { from: "start", lines: 5 });
      expect(win.scannedBytes).toBe(WINDOW_SCAN_CAP_BYTES);
      expect(win.capped).toBe(true);
      expect(win.atEnd).toBe(false);
    } finally {
      await fh2.close();
    }
  });

  it("the cap note rides the real tool result on a dense 9 MiB single-line file (no sparseness tricks)", async () => {
    const p = join(bigRoot, "dense-oneline.txt");
    writeFileSync(p, "y".repeat(WINDOW_SCAN_CAP_BYTES + 1024 * 1024)); // 9 MiB, no newline

    const t = (await tail.execute({ path: "dense-oneline.txt" }, ctxWith(bigRoot))) as ToolResult;
    expect(t.isOk()).toBe(true);
    expect(t.output).toBe("");
    const showingT = entriesOf(t).get("showing")!;
    expect(showingT).toContain(
      `window capped at ${WINDOW_SCAN_CAP_BYTES} bytes; earlier bytes not scanned`,
    );
    expect(showingT).toContain("last 0 lines");

    const h = (await head.execute({ path: "dense-oneline.txt", lines: 3 }, ctxWith(bigRoot))) as ToolResult;
    expect(h.isOk()).toBe(true);
    const showingH = entriesOf(h).get("showing")!;
    expect(showingH).toContain(
      `window capped at ${WINDOW_SCAN_CAP_BYTES} bytes; later bytes not scanned`,
    );
    expect(showingH).toContain("(more exists)");
  });

  it("tiny chunks never split a codepoint and never drop a complete line", async () => {
    const p = join(bigRoot, "multibyte.txt");
    const text = Array.from({ length: 200 }, (_, i) => `\u{1f600} caf\u00e9 \u65e5\u672c ${i +1}`).join("\n") + "\n";
    writeFileSync(p, text);

    const fh = await open(p, "r");
    try {
      const win = await boundedWindow(fh, { from: "end", lines: 3, chunkBytes: 7 });
      expect(win.text).not.toContain("\uFFFD"); // stream-semantics decoder, no seam damage
      const all = text.trimEnd().split("\n");
      const shown = win.text.split("\n").filter((l) => l !== "");
      for (const l of shown) expect(all).toContain(l); // dropped partial only; nothing complete lost
      const { out } = renderTailWindow(win, 3);
      expect(out.split("\n")).toEqual(all.slice(-3));
    } finally {
      await fh.close();
    }
  });

  it("head grows x4 and stops at the Nth newline, not at the cap, on normal files", async () => {
    const p = join(bigRoot, "dense-many.txt");
    // ~88 KiB of short lines: the 50th newline sits deep inside the FIRST
    // 64 KiB chunk, so head stops after exactly one read with no growth.
    const dense = lines(4000, "log-entry-filler").map((l) => l + "\n").join("");
    expect(dense.length).toBeGreaterThan(WINDOW_CHUNK_BYTES);
    writeFileSync(p, dense);
    const fh = counting(await open(p, "r"));
    try {
      const win = await boundedWindow(fh, { from: "start", lines: 50 });
      expect(win.scannedBytes).toBe(WINDOW_CHUNK_BYTES);
      expect(fh.totalRead).toBe(WINDOW_CHUNK_BYTES);
      const { out, showing } = renderHeadWindow(win, 50);
      expect(out.split("\n")).toEqual(lines(50, "log-entry-filler"));
      expect(showing).toBe("1-50 (more exists)");
    } finally {
      await fh.close();
    }
  });
});

// ── shadow end-to-end: invisible to the model, callable in code ──────────────

describe("tail under the shadow layer (§3.9 + §3.7)", () => {
  it("head/tail absent from the wire defs, present in the policy set, callable from a script via D1 -- gate and log rows present", async () => {
    const savedDataDir = process.env.HOTDOG_DATA_DIR;
    process.env.HOTDOG_DATA_DIR = mkdtempSync(join(tmpdir(), "hotdog-codemode-shadowtail-"));

    try {
      const core = createTestCore();
      const loader = new ExtensionLoader(core);
      const inst = await loader.load("codemode", "@experimental/codemode/index.ts");
      expect(inst).not.toBeNull();
      expect(core.toolRegistry.get("head")).toBeDefined(); // registered by the extension
      expect(core.toolRegistry.get("tail")).toBeDefined();

      const mockLLM = new MockLLMClient({
        responseSequences: [
          buildStreamResponse({
            content: "done",
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        ],
      });
      const { agent } = createFixture({
        hooks: core.hooks,
        toolRegistry: core.toolRegistry,
        mockLLM,
      });
      await agent.run("go");

      // Invisible to the model: the shadow (list-free) drops head/tail off
      // the wire while codemode stays declared.
      const wire = (mockLLM.lastToolDefs ?? []).map(
        (d) => (d as { function?: { name?: string } }).function?.name ?? "",
      );
      expect(wire).toContain("codemode");
      expect(wire).not.toContain("head");
      expect(wire).not.toContain("tail");
      // Fully in the policy set (the script authority): still there.
      const defs = await agent.getToolDefs();
      const policy = defs.map((d) => d.function.name);
      expect(policy).toContain("head");
      expect(policy).toContain("tail");

      // Gate rows: record every TOOL_CALL the inner dispatch fires.
      const gateRows: Array<{ toolName: string; parentToolCallId?: string }> = [];
      core.hooks.on(
        HOOKS.TOOL_CALL,
        (p: { toolName: string; parentToolCallId?: string }) => {
          gateRows.push({ toolName: p.toolName, parentToolCallId: p.parentToolCallId });
        },
        "b8-gate-spy",
      );

      const executor = createToolExecutor({
        toolRegistry: core.toolRegistry,
        hooks: core.hooks,
        emitOutput: () => {},
        workspaceRoots: [root],
        workspaceDeny: null,
        maxRetries: 0,
        toolRetryDelay: 0,
        isRestoring: () => false,
        agent,
      });

      const bridge = new CodemodeBridge();
      const outcome = await bridge.run({
        code: [
          "const t = await tools.tail({ path: 'many.txt', lines: 2 });",
          "const h = await tools.head({ path: 'many.txt', lines: 2 });",
          "return t + '|' + h;",
        ].join("\n"),
        toolNames: policy,
        toolDefs: callableInfos(defs, (n) => core.toolRegistry.getMetadata(n)),
        timeoutMs: 30_000,
        roots: [root],
        callId: "cm-shadow-1",
        dispatch: (name, input, opts) => executor.executeToolCall(name, input, opts),
      });

      expect(outcome.error).toBeNull();
      expect(String(outcome.value)).toBe(
        `${MANY.slice(-2).join("\n")}|${MANY.slice(0, 2).join("\n")}`,
      );
      // Gate rows present, parented to the codemode call.
      expect(gateRows.map((g) => g.toolName).sort()).toEqual(["head", "tail"]);
      for (const g of gateRows) expect(g.parentToolCallId).toBe("cm-shadow-1");
      // Digest rows.
      expect(outcome.digest.map((d) => `${d.name}(${d.status})`)).toEqual([
        "tail(ok)",
        "head(ok)",
      ]);
      // Log rows: the journal holds started+answered lines for both.
      const journalLines = await readRunJournal(outcome.runDir);
      const dispatched = journalLines
        .filter((l) => l.ev === "call_started")
        .map((l) => l.name);
      expect(dispatched).toEqual(["tail", "head"]);
      expect(journalLines.filter((l) => l.ev === "call_answered")).toHaveLength(2);
    } finally {
      if (savedDataDir === undefined) delete process.env.HOTDOG_DATA_DIR;
      else process.env.HOTDOG_DATA_DIR = savedDataDir;
    }
  });
});
