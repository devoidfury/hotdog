// codemode protocol + fenced host. Every test here runs an ACTUAL script
// through the real bridge: a real child process (bwrap-fenced where the probe
// passes, plain-spawn degraded where it does not), real NDJSON frames on
// stdio pipes, real kills. Live-fence assertions are probe-gated exactly like
// the plane's own tests (tests/core/tool-exec-plane.test.ts), and the degrade
// path has its own test so a missing fence reports as a missing fence.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execFenceBackend } from "@utils/exec-plan.ts";
import { isSensitiveEnvVar } from "@utils/env.ts";
import { pidAlive } from "@utils/process-group.ts";
import { CodemodeBridge } from "@experimental/codemode/bridge.ts";
import { readRunJournal, RunJournal, scratchDirFor } from "@experimental/codemode/journal.ts";
import { encodeFrame, RUNNER_CAP_EXIT } from "@experimental/codemode/host/protocol.ts";
import {
  FRAME_MAX_BYTES,
  MAX_INNER_CALLS,
  OUTPUT_STREAM_CAP_BYTES,
  OUTPUT_STREAM_MAX_ITEMS,
} from "@experimental/codemode/options.ts";

// Journal isolation: the bridge writes under joinDataDir("codemode"). Pin the
// data dir to a temp dir for the file; the global test setup already keeps the
// real ~/.cache/hotdog out of reach, but this suite owns these dirs and
// removes them.
const savedDataDir = process.env.HOTDOG_DATA_DIR;
const savedSentinelKey = "CODEMODE_TEST_PROVIDER_KEY";
const savedSentinel = process.env[savedSentinelKey];
let dataRoot: string;

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "hotdog-codemode-host-"));
  process.env.HOTDOG_DATA_DIR = dataRoot;
  // A provider-key-shaped canary: must never reach any child, fenced or not.
  process.env[savedSentinelKey] = `sentinel-${process.pid}-never-leak`;
});

afterAll(() => {
  if (savedDataDir === undefined) delete process.env.HOTDOG_DATA_DIR;
  else process.env.HOTDOG_DATA_DIR = savedDataDir;
  if (savedSentinel === undefined) delete process.env[savedSentinelKey];
  else process.env[savedSentinelKey] = savedSentinel;
  rmSync(dataRoot, { recursive: true, force: true });
});

const bridge = new CodemodeBridge();

describe("codemode host bridge (B2)", () => {
  it("frames round-trip: out stream, call refusal, B8 meta answers, done value", async () => {
    const outcome = await bridge.run({
      code: [
        'console.log("streamed-line");',
        'text("text-call");',
        "const errs = {};",
        "try { await tools.echo({ a: 1 }); } catch (e) { errs.call = e.message; }",
        "let search = null;",
        "let describe = null;",
        'try { search = await searchTools("files"); } catch (e) { errs.search = e.message; }',
        'try { describe = await describeTool("read"); } catch (e) { errs.describe = e.message; }',
        "return JSON.stringify({ keys: Object.keys(tools), errs, search, describe });",
      ].join("\n"),
      toolNames: ["echo", "read"],
      toolDefs: [
        { name: "echo", description: "Echo it back", tags: ["utility"] },
        {
          name: "read",
          description: "Read a file.\nSecond line stays out of search results.",
          parameters: {
            type: "object",
            properties: { path: { type: "string", description: "File path" } },
            required: ["path"],
          },
          tags: ["files"],
        },
      ],
      timeoutMs: 30_000,
    });
    expect(outcome.error).toBeNull();
    expect(outcome.ok).toBe(true);
    const fenceLabels: (typeof outcome.fence)[] = ["bwrap", "seatbelt", "absent"];
    expect(fenceLabels).toContain(outcome.fence);
    // child -> host out frames arrived, in order, joined by the host.
    expect(outcome.output).toContain("streamed-line");
    expect(outcome.output).toContain("text-call");
    // host -> child res frames answered both the call (no dispatcher -> an
    // error) and the meta ops (JSON values).
    const value = JSON.parse(String(outcome.value)) as {
      keys: string[];
      errs: Record<string, string>;
      search: { name: string; description: string }[];
      describe: { name: string; parameters: unknown[] } | null;
    };
    expect(value.keys).toEqual(["echo", "read"]);
    expect(value.errs.call).toContain("not wired");
    expect(value.errs.search).toBeUndefined();
    expect(value.errs.describe).toBeUndefined();
    expect(value.search).toEqual([{ name: "read", description: "Read a file." }]);
    expect(value.describe!.name).toBe("read");
    expect(value.describe!.parameters).toEqual([
      { name: "path", type: "string", required: true, description: "File path" },
    ]);
    // The meta ops are host-recorded digest rows, not calls.
    const metas = outcome.digest.filter((d) => d.kind === "meta");
    expect(metas.map((m) => m.name)).toEqual(["searchTools", "describeTool"]);
  });

  it("a script enumerating Object.keys(tools) sees no codemode key (structural ban)", async () => {
    const outcome = await bridge.run({
      code:
        'return Object.keys(tools).join(",") + "|" + ("codemode" in tools) + "|" + typeof tools.codemode;',
      toolNames: ["bash", "codemode", "read"],
      timeoutMs: 30_000,
    });
    expect(outcome.error).toBeNull();
    expect(outcome.value).toBe("bash,read|false|undefined");
  });

  it("spin-loop script is killed at the deadline with Script error: timeout", async () => {
    const outcome = await bridge.run({
      code: "while (true) {}",
      toolNames: [],
      timeoutMs: 400,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("Script error: timeout");
    expect(outcome.killed).toBe(true);
    expect(outcome.signal).toBe("SIGKILL"); // the whole process group got it
  });

  it("output past 16 Mi kills the child; the host stays alive", async () => {
    const outcome = await bridge.run({
      code: 'const s = "x".repeat(64 * 1024); while (true) console.log(s);',
      toolNames: [],
      timeoutMs: 30_000,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("streamed output past");
    expect(outcome.error).toContain(String(OUTPUT_STREAM_CAP_BYTES));
    expect(outcome.outItems).toBeGreaterThan(0);
    // The host answering at all is most of the proof; a follow-up run seals it.
    const follow = await bridge.run({
      code: 'return "host alive"',
      toolNames: [],
      timeoutMs: 30_000,
    });
    expect(follow.value).toBe("host alive");
  });

  it(`streaming past ${OUTPUT_STREAM_MAX_ITEMS} items kills the child (item cap bites under the byte cap)`, async () => {
    const outcome = await bridge.run({
      code: "for (let i = 0; i < 100500; i++) console.log('x');",
      toolNames: [],
      timeoutMs: 30_000,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("streamed output past");
    expect(outcome.error).toContain(String(OUTPUT_STREAM_MAX_ITEMS));
    expect(outcome.outBytes).toBeLessThan(OUTPUT_STREAM_CAP_BYTES); // items, not bytes, did it
    expect(outcome.killed || outcome.exitCode === RUNNER_CAP_EXIT).toBe(true); // host kill or child self-cap exit
  });

  it("an oversize frame terminates the child and surfaces a protocol error", async () => {
    const outcome = await bridge.run({
      code: `console.log("A".repeat(${FRAME_MAX_BYTES}));`, // frame > 1 MiB with JSON overhead
      toolNames: [],
      timeoutMs: 30_000,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.killed).toBe(true);
    expect(outcome.error).toContain("Protocol violation");
    expect(outcome.error).toContain("frame overflow");
  });

  // The cap is frame CONTENT bytes (no newline), so a frame whose content
  // is exactly FRAME_MAX_BYTES is legal on BOTH legs -- symmetric boundary.
  // The child leg: an out item sized so the encoded frame is exactly cap
  // decodes clean; one byte more is a protocol violation.
  const OUT_FRAME_OVERHEAD = Buffer.byteLength(
    encodeFrame({ t: "out", item: { kind: "text", text: "" } }),
  );
  it("child->host leg accepts an out frame of EXACTLY 1 MiB content", async () => {
    const n = FRAME_MAX_BYTES - OUT_FRAME_OVERHEAD; // 'A' is not JSON-escaped
    expect(n).toBeGreaterThan(0);
    const outcome = await bridge.run({
      code: `console.log("A".repeat(${n})); return "fit exactly";`,
      toolNames: [],
      timeoutMs: 30_000,
    });
    expect(outcome.error).toBeNull(); // exactly cap decoded, no protocol violation
    expect(outcome.value).toBe("fit exactly");
    expect(outcome.outBytes).toBe(FRAME_MAX_BYTES + 1); // +1 for the terminator
  });

  it("child->host leg rejects an out frame of cap+1 (boundary is inclusive at cap)", async () => {
    const n = FRAME_MAX_BYTES - OUT_FRAME_OVERHEAD + 1;
    const outcome = await bridge.run({
      code: `console.log("A".repeat(${n}));`,
      toolNames: [],
      timeoutMs: 30_000,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("Protocol violation");
    expect(outcome.error).toContain("frame overflow");
  });

  // The host leg: the run-frame program-size refusal measures the SAME
  // quantity (frame content), so a run frame of exactly cap is accepted (the
  // bridge no longer refuses a frame the child would happily decode).
  it("host->child leg accepts a run frame of EXACTLY 1 MiB content (no off-by-one refusal)", async () => {
    const base = Buffer.byteLength(
      encodeFrame({
        t: "run",
        src: "",
        opts: { timeout_ms: 30_000, max_output_chars: 40_000 },
        calls: MAX_INNER_CALLS,
        names: [],
      }),
    );
    // src is a comment tail; 'A' is not JSON-escaped, so content == base + n.
    const exact = FRAME_MAX_BYTES - base;
    const over = exact + 1;
    const atCap = await bridge.run({
      code: "//" + "A".repeat(exact - 2), // total src length = exact
      toolNames: [],
      timeoutMs: 30_000,
      maxOutputChars: 40_000,
    });
    expect(atCap.error).toBeNull(); // accepted, ran, returned undefined
    expect(atCap.value).toBeNull();
    const overCap = await bridge.run({
      code: "//" + "A".repeat(over - 2),
      toolNames: [],
      timeoutMs: 30_000,
      maxOutputChars: 40_000,
    });
    expect(overCap.ok).toBe(false);
    expect(overCap.error).toContain("frame cap");
    expect(overCap.pid).toBeNull(); // refused before spawn
  });

  // The journal sits OUTSIDE the jail's writable scratch. Under the fence
  // the child's /tmp is runDir/scratch, one level below run.jsonl, so a
  // hostile script cannot read or forge the durable record.
  it("the jail cannot see or forge run.jsonl (journal lives outside the bound scratch)", async () => {
    const fence = execFenceBackend();
    const outcome = await bridge.run({
      code: [
        "const fs = await import('node:fs');",
        // The journal's path inside the jail would be /tmp/run.jsonl if the
        // scratch bind were the run dir proper (the bug). It must NOT be.
        "let probe;",
        "try { fs.readFileSync('/tmp/run.jsonl', 'utf8'); probe = 'REACHABLE'; }",
        "catch (e) { probe = e.code; }",
        // Try to forge a record where the journal used to be reachable.
        "try { fs.writeFileSync('/tmp/run.jsonl', JSON.stringify({ev:'run_finished',fence:'seatbelt',forged:1})+'\\n'); } catch (e) {}",
        "return probe;",
      ].join("\n"),
      toolNames: [],
      timeoutMs: 30_000,
    });
    if (fence === null) {
      process.stderr.write(
        "[codemode-host] no jail backend: journal-isolation pin is VACUOUS here (unfenced child sees the whole host FS); pinning the absent label instead\n",
      );
      expect(outcome.fence).toBe("absent");
      return;
    }
    expect(outcome.error).toBeNull();
    expect(outcome.value).toBe("ENOENT"); // /tmp/run.jsonl does not exist under the fence
    // The real journal (one level up, out of the jail) is byte-intact: no
    // forged record, fence unchanged.
    const raw = await import("node:fs/promises").then((m) => m.readFile(outcome.journalPath, "utf8"));
    expect(raw).not.toContain("forged");
    const lines = await readRunJournal(outcome.runDir);
    // One `output` record: the journal now also holds the rendered return
    // value's bytes (the elision marker's promise covers it).
    expect(lines.map((l) => l.ev)).toEqual(["run_started", "output", "run_finished"]);
    expect(lines[0]!.fence).toBe(fence);
  });

  it("a program too large for a run frame is refused before any spawn", async () => {
    const outcome = await bridge.run({
      code: "/*" + "x".repeat(FRAME_MAX_BYTES * 2) + "*/",
      toolNames: [],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("frame cap");
    expect(outcome.pid).toBeNull();
    expect(outcome.fence).toBeNull(); // the spawn decision was never reached
    expect(existsSync(outcome.journalPath)).toBe(false);
  });

  it("jail child env is the setEnv whitelist only; no provider-key values", async () => {
    const outcome = await bridge.run({
      code: "return JSON.stringify(process.env);",
      toolNames: [],
      timeoutMs: 30_000,
    });
    if (execFenceBackend() === null) {
      process.stderr.write(
        "[codemode-host] no jail backend on this host: the env-whitelist pin is VACUOUS here; pinning the honest degrade label instead\n",
      );
      expect(outcome.fence).toBe("absent");
      return;
    }
    expect(outcome.error).toBeNull();
    expect(outcome.fence).toBe(execFenceBackend());
    const env = JSON.parse(String(outcome.value)) as Record<string, string>;
    // Jail path: bwrap/seatbelt receive ONLY PATH/LANG at spawn, --setenv
    // adds HOME/TMPDIR; bun normalizes PWD itself. Nothing else can appear.
    const allowed = new Set(["PATH", "LANG", "HOME", "TMPDIR", "PWD"]);
    for (const key of Object.keys(env)) {
      expect(allowed.has(key)).toBe(true);
      expect(isSensitiveEnvVar(key)).toBe(false);
    }
    expect(JSON.stringify(env)).not.toContain(`sentinel-${process.pid}`);
  });

  it("degrade path: copyScrubbedEnv applied AND fence reported absent", async () => {
    const degraded = new CodemodeBridge({ fenceBinary: null }); // plain spawn, pinned
    const outcome = await degraded.run({
      code: "return JSON.stringify(process.env);",
      toolNames: [],
      timeoutMs: 30_000,
    });
    expect(outcome.error).toBeNull();
    expect(outcome.fence).toBe("absent"); // never silently degraded
    const env = JSON.parse(String(outcome.value)) as Record<string, string>;
    for (const key of Object.keys(env)) {
      expect(isSensitiveEnvVar(key)).toBe(false); // the scrub ran
    }
    expect(env[savedSentinelKey]).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(`sentinel-${process.pid}`);
    expect(env.PATH).toBeDefined(); // benign vars still cross (scrub, not jail env)
  });

  it("admission: a third concurrent script waits FIFO, then errors all runners busy", async () => {
    const tight = new CodemodeBridge({ maxLiveChildren: 1, admissionWaitMs: 250 });
    const holder = tight.run({
      code: "await new Promise((r) => setTimeout(r, 900)); return 'held';",
      toolNames: [],
      timeoutMs: 30_000,
    });
    await new Promise((r) => setTimeout(r, 150)); // let the holder take the slot and spawn
    const t0 = Date.now();
    let busyError = "";
    try {
      await tight.run({ code: 'return "never runs"', toolNames: [], timeoutMs: 30_000 });
    } catch (e) {
      busyError = (e as Error).message;
    }
    expect(busyError).toContain("all runners busy");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200); // it WAITED (FIFO), then errored
    expect((await holder).value).toBe("held");
    expect(tight.liveChildren()).toBe(0);
  });

  it("a killed child releases its admission slot on actual exit; a failed spawn never reserves one", async () => {
    const tight = new CodemodeBridge({ maxLiveChildren: 1, admissionWaitMs: 5000 });
    const spin = await tight.run({ code: "while (true) {}", toolNames: [], timeoutMs: 300 });
    expect(spin.killed).toBe(true);
    expect(spin.pid).not.toBeNull();
    expect(pidAlive(spin.pid!)).toBe(false); // really dead, not just settled
    expect(tight.liveChildren()).toBe(0); // slot is back at the exit event
    const after = await tight.run({ code: 'return "slot free"', toolNames: [], timeoutMs: 30_000 });
    expect(after.value).toBe("slot free");

    // A spawn that dies on ENOENT must hand the admission slot back too: the
    // third run reports the spawn error, never "all runners busy".
    const broken = new CodemodeBridge({
      maxLiveChildren: 1,
      admissionWaitMs: 500,
      fenceBinary: "/nonexistent/codemode-fence-binary",
    });
    for (const _ of [1, 2]) {
      let message = "";
      try {
        const failed = await broken.run({ code: "return 1", toolNames: [], timeoutMs: 5000 });
        message = failed.error ?? "";
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toContain("all runners busy");
      expect(message).toMatch(/ENOENT|spawn failed/);
      expect(broken.liveChildren()).toBe(0);
    }
  });

  it("abortSignal kills the child (process group) and reports cancelled", async () => {
    const ac = new AbortController();
    const running = bridge.run({
      code: "while (true) {}",
      toolNames: [],
      timeoutMs: 30_000,
      abortSignal: ac.signal,
    });
    setTimeout(() => ac.abort(), 200);
    const outcome = await running;
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("Script error: cancelled");
    expect(outcome.killed).toBe(true);
  });

  it("journal: fsync'd run.jsonl records run_started/run_finished with the fence", async () => {
    const okRun = await bridge.run({
      code: 'console.log("j"); return 1;',
      toolNames: ["read"],
      timeoutMs: 30_000,
    });
    expect(okRun.ok).toBe(true);
    expect(okRun.journalPath).toBe(join(okRun.runDir, "run.jsonl"));
    const lines = await readRunJournal(okRun.runDir);
    // The batched full-bytes output record sits between the lifecycle lines
    // (the elision marker in the result names this file): the streamed item
    // plus the rendered return value.
    expect(lines.map((l) => l.ev)).toEqual([
      "run_started",
      "output",
      "output",
      "run_finished",
    ]);
    expect(lines[0]!.fence).toBe(okRun.fence);
    expect(lines[0]!.names).toEqual(["read"]);
    expect(lines[3]!.ok).toBe(true);
    expect(lines.every((l) => typeof l.ts === "string")).toBe(true);
    // The scratch the jail mounts as /tmp is a SUBDIR, and the journal is its
    // sibling in the run dir proper -- never on the child's writable surface.
    expect(existsSync(okRun.journalPath)).toBe(true);
    expect(existsSync(scratchDirFor(okRun.runDir))).toBe(true);
    expect(okRun.journalPath).not.toBe(join(scratchDirFor(okRun.runDir), "run.jsonl"));

    const spin = await bridge.run({ code: "while (true) {}", toolNames: [], timeoutMs: 250 });
    const spinLines = await readRunJournal(spin.runDir);
    const finished = spinLines.find((l) => l.ev === "run_finished");
    expect(finished!.error).toBe("Script error: timeout");
    expect(finished!.killed).toBe(true);
  });
});

describe("codemode run journal store", () => {
  it("appends fsync'd lines, folds garbage on read, refuses appends after close", async () => {
    const dir = mkdtempSync(join(dataRoot, "journal-unit-"));
    const journal = await RunJournal.open(dir);
    await journal.append({ ev: "call_started", id: 1, name: "read" });
    await journal.append({ ev: "custom", ts: "pinned" });
    await journal.close();
    // A torn tail (the crash shape) must not poison the reader.
    appendFileSync(join(dir, "run.jsonl"), "not json at all\n");
    const lines = await readRunJournal(dir);
    expect(lines.length).toBe(2);
    expect(lines[0]).toEqual({ ev: "call_started", id: 1, name: "read", ts: lines[0]!.ts });
    expect(lines[1]!.ts).toBe("pinned"); // caller-supplied ts wins
    await expect(journal.append({ ev: "late" })).rejects.toThrow("closed");
    expect(await readRunJournal(join(dir, "never-created"))).toEqual([]);
  });
});
