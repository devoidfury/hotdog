// Fuzz suite for the workflow engine's run.jsonl journal replay (crash
// resilience + durability truth on torn files). Shape template:
// tests/core/session-log-fuzz.test.ts -- exhaustive byte sweep + seeded
// corruption + independent expectations + mkdtemp isolation.
//
// Seam (no refactor needed): readRunLog is module-private, but every journal
// replay path is exported:
//   - readRunSummary(dir)   -> full readRunLog fold (outcome + terminal states)
//   - reconcileRun(dir)     -> the resume reconcile (readRunLog + validateClaims)
//   - scanInterruptedRuns() -> the independent second parser (interrupted
//                              classification, nodeActivity, marked)
//   - markInterruptedRuns() -> the real writer of `interrupted` events
// The fixture journal is built by REAL write paths only: a full WorkflowRun, a
// crashed-writer copy (journal minus the finished line), markInterruptedRuns
// for a genuine marker, then a resume WorkflowRun that appends `resumed`,
// re-executed node events, and a terminal `finished`.
//
// Pinned reader tolerance (parseJsonLines splits on "\n", trims, keeps lines
// that parse as JSON). A record's serialized text is [start_i, end_i) with end
// BEFORE any CR/LF, so a cut at byte k keeps record i IFF end_i <= k: JSON
// object texts are prefix-free (no strict byte prefix of `{...}` parses), a cut
// between CR and LF trims to the whole record, and nothing after the torn tail
// can survive. Expectations are computed by this file's own fold over the
// fixture's record INTENTS (the META table), never from what the scanner
// returns. Fold rules mirror the documented journal semantics:
//   - summary: requires an intact `started` (last wins) else null; outcome from
//     the last intact `finished`; node states from TERMINAL node events only
//     (queued/running/retry-warm/attempt-rejected are state-wise inert).
//   - scan view: present IFF started intact and finished absent; node states
//     there DO include transient states (the pinned asymmetry); nodeActivity =
//     any node event; marked = last parsed ev is `interrupted`.
//   - reconcile (journal-only dir, so no claim ever verifies): throws IFF no
//     intact `started`; else valid=[], invalid=live claims in claim-map order,
//     incomplete=graph nodes minus claims.
//   - durability truth: a run is never `finished` (summary outcome non-null /
//     scan silent) before the finished line is byte-whole, and a node claim is
//     never live before its succeeded line is whole. Classification is
//     monotonic under prefix growth.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { contentToText } from "@core/context/message.ts";
import { TaskManager } from "@core/session/task-manager.ts";
import { parseWorkflow, type Workflow } from "@extensions/workflows/workflow.ts";
import {
  INTERRUPTED_EV,
  markInterruptedRuns,
  readRunSummary,
  reconcileRun,
  scanInterruptedRuns,
  WorkflowRun,
} from "@extensions/workflows/engine.ts";
import { makeRng, type Rng } from "../fuzz/prng.ts";

// ── Fixture built by the real write paths ───────────────────────────

const ROOT = mkdtempSync(join(tmpdir(), "wfz-journal-"));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** Journal scan lens: no dir is owned, nothing is alive. */
const DEAD = { pidAlive: () => false };

function graph(): Workflow {
  const r = parseWorkflow(`
    version: 1
    name: wfz
    description: journal fuzz graph
    nodes:
      - id: a
        accept:
          files: [a.out]
      - id: b
        dependsOn: [a]
        accept:
          files: [b.out]
          retryOn: [fail]
          maxAttempts: 2
  `);
  if (!r.workflow) throw new Error(`invalid fixture: ${r.errors.join("; ")}`);
  return r.workflow;
}

/**
 * Scripted no-op workers (no LLM): write the node's output plus its verdict;
 * node b verdict-fails on its first turn of every fake so the journal carries
 * gate events (attempt-rejected + warm retry). Turn summaries carry 2- and
 * 4-byte UTF-8 so the sweep has mid-codepoint cut classes to make.
 */
function makeTasks(runDir: string): TaskManager {
  const turns: Record<string, number> = {};
  return new TaskManager({
    buildAgent: async () => ({
      run: async (input: string | Array<Record<string, unknown>>) => {
        const prompt = contentToText(input);
        const id = /node '([a-z0-9-]+)'/.exec(prompt)?.[1] ?? "x";
        const n = (turns[id] = (turns[id] ?? 0) + 1);
        writeFileSync(join(runDir, `${id}.out`), `artifact-${id}`);
        writeFileSync(join(runDir, `${id}.verdict`), id === "b" && n === 1 ? "fail" : "pass");
        return { type: "completion", content: `${id} done \u00e9 \u{1F30D}` };
      },
      notifyCompletion: () => {},
      steer: () => {},
    }) as never,
    modelRegistry: {},
    config: {},
    maxIterations: 3,
    taskProfile: "default",
  });
}

let fixture = Buffer.alloc(0);

beforeAll(async () => {
  // 1. Real completed run.
  const dirA = join(ROOT, "run-a");
  const sA = await new WorkflowRun({ workflow: graph(), runId: "run-a", runDir: dirA, tasks: makeTasks(dirA) }).run();
  expect(sA.outcome).toBe("succeeded");
  // 2. Crashed-writer shape: same journal without the finished line, and no
  //    artifacts, so the resume re-executes everything.
  const dirB = join(ROOT, "run-b");
  mkdirSync(dirB, { recursive: true });
  const lines = readFileSync(join(dirA, "run.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "");
  expect(JSON.parse(lines[lines.length - 1]!).ev).toBe("finished");
  writeFileSync(join(dirB, "run.jsonl"), `${lines.slice(0, -1).join("\n")}\n`);
  // 3. Genuine `interrupted` marker from the real activation writer. The
  //    crashed copy carries run-a's journal (runId and all) minus `finished`,
  //    which is exactly the crashed-writer shape; only dir run-b gets marked.
  const marked = await markInterruptedRuns(ROOT, DEAD);
  expect(marked.map((v) => basename(v.runDir))).toEqual(["run-b"]);
  // 4. Resume: appends resumed + re-executed node events + finished.
  const sB = await new WorkflowRun({ workflow: graph(), runId: "run-b", runDir: dirB, tasks: makeTasks(dirB) }).run();
  expect(sB.outcome).toBe("succeeded");
  fixture = readFileSync(join(dirB, "run.jsonl"));
});

// ── Record geometry + independent fold oracle ───────────────────────

interface Rec {
  text: string;
  start: number; // first byte of the record text
  end: number; // one past the LAST byte that keeps the record intact (trim handles CR)
  val: unknown;
}

function splitRecords(buf: Buffer): Rec[] {
  const parts = buf.toString("utf8").split("\n");
  const recs: Rec[] = [];
  let byte = 0;
  for (const p of parts) {
    const bare = p.trim(); // mirrors parseJsonLines' trim; engine lines carry only a trailing CR
    if (bare !== "") {
      let val: unknown = undefined;
      try {
        val = JSON.parse(bare);
      } catch {
        val = undefined;
      }
      // end = last byte that keeps the record whole (the CR of a CRLF is optional)
      recs.push({ text: p, start: byte, end: byte + Buffer.byteLength(bare, "utf8"), val });
    }
    byte += Buffer.byteLength(p, "utf8") + 1;
  }
  return recs;
}

const TERMS = ["succeeded", "failed", "blocked", "cancelled"];

interface Folded {
  sum: { runId: string; workflow: string; outcome: string | null; nodes: Array<{ id: unknown; state: string }> } | null;
  scan: { runId: string; workflow: string; nodes: Array<{ id: unknown; state: string }>; nodeActivity: boolean; marked: boolean } | null;
  recon: { runId: unknown; workflow: string; valid: string[]; invalid: unknown[]; incomplete: unknown[] } | null;
}

/** The oracle: fold record intents per the pinned semantics above. */
function fold(recs: unknown[]): Folded {
  let sumS: { runId: string; workflow: string; nodes: unknown[] } | null = null;
  let scanS: { runId: string; workflow: string; nodes: unknown[] } | null = null;
  let outcome: string | null = null;
  let finishedSeen = false;
  const term = new Map<string, string>();
  const seen = new Map<string, string>();
  const claims = new Map<string, true>();
  let nodeActivity = false;
  let lastEv: string | null = null;
  for (const ev of recs) {
    if (typeof ev !== "object" || ev === null) continue; // parseJsonLines keeps any valid JSON; scalars are inert
    const e = ev as Record<string, unknown>;
    if (typeof e.ev === "string") lastEv = e.ev;
    if (e.ev === "started") {
      const nodes = Array.isArray(e.nodes) ? (e.nodes as unknown[]) : [];
      sumS = { runId: String(e.runId), workflow: String(e.workflow), nodes };
      scanS = { runId: String(e.runId ?? ""), workflow: String(e.workflow ?? ""), nodes };
    } else if (e.ev === "finished") {
      finishedSeen = true;
      outcome = String(e.outcome);
    } else if (e.ev === "node") {
      nodeActivity = true;
      // Scan-view fold mirrors the engine scan's `ev.id != null` guard: an
      // id-less node event updates no state (nodeActivity still fires, as in
      // the engine). The summary-view `term`/`claims` stay unguarded because
      // readRunLog folds `String(ev.id)` unguarded.
      if (e.id != null) seen.set(String(e.id), String(e.state ?? ""));
      const st = String(e.state);
      if (TERMS.includes(st)) {
        term.set(String(e.id), st);
        if (st === "succeeded") claims.set(String(e.id), true);
        else claims.delete(String(e.id));
      }
    }
  }
  const sum = sumS
    ? {
        runId: sumS.runId,
        workflow: sumS.workflow,
        outcome,
        nodes: sumS.nodes.map((id) => ({ id, state: term.get(String(id)) ?? "pending" })),
      }
    : null;
  const scan =
    scanS && !finishedSeen
      ? {
          runId: scanS.runId,
          workflow: scanS.workflow,
          nodes: scanS.nodes.map((id) => ({ id, state: seen.get(String(id)) ?? "pending" })),
          nodeActivity,
          marked: lastEv === INTERRUPTED_EV,
        }
      : null;
  const recon = sumS
    ? {
        runId: sumS.runId,
        workflow: sumS.workflow,
        valid: [],
        invalid: [...claims.keys()],
        incomplete: sumS.nodes.filter((id) => !claims.has(id as never)),
      }
    : null;
  return { sum, scan, recon };
}

// ── Consumer harness ────────────────────────────────────────────────

const SCAN_ROOT = join(ROOT, "sweep");
const SWEEP_DIR = join(SCAN_ROOT, "r");
const JOURNAL = join(SWEEP_DIR, "run.jsonl");
mkdirSync(SWEEP_DIR, { recursive: true });

async function probe(dir: string): Promise<{ sum: unknown; scan: unknown; recon: unknown }> {
  const [sum, scan, recon] = await Promise.all([
    readRunSummary(dir),
    scanInterruptedRuns(SCAN_ROOT, DEAD).then((v) => {
      const mine = v.filter((x) => x.runDir === dir)[0];
      return mine ? { runId: mine.runId, workflow: mine.workflow, nodes: mine.nodes, nodeActivity: mine.nodeActivity, marked: mine.marked } : null;
    }),
    reconcileRun(dir).catch((e: unknown) => {
      const m = String(e instanceof Error ? e.message : e);
      if (!m.includes("no usable run.jsonl")) throw e; // only the documented throw is tolerated
      return "THROWS";
    }),
  ]);
  return { sum, scan, recon };
}

/** Compare the three consumers against the fold oracle. */
function diffExpect(got: { sum: unknown; scan: unknown; recon: unknown }, exp: Folded): string {
  const d: string[] = [];
  const g = got as { sum: Folded["sum"]; scan: Folded["scan"]; recon: Folded["recon"] | "THROWS" };
  if (JSON.stringify(g.sum) !== JSON.stringify(exp.sum)) d.push(`sum ${JSON.stringify(g.sum)} != ${JSON.stringify(exp.sum)}`);
  if (JSON.stringify(g.scan) !== JSON.stringify(exp.scan)) d.push(`scan ${JSON.stringify(g.scan)} != ${JSON.stringify(exp.scan)}`);
  if (exp.recon === null) {
    if (g.recon !== "THROWS") d.push(`reconcile should throw, got ${JSON.stringify(g.recon)}`);
  } else if (g.recon === "THROWS") {
    d.push("reconcile threw although started is intact");
  } else if (JSON.stringify(g.recon) !== JSON.stringify(exp.recon)) {
    d.push(`recon ${JSON.stringify(g.recon)} != ${JSON.stringify(exp.recon)}`);
  }
  return d.join("; ");
}

// ── Fixture sanity ──────────────────────────────────────────────────

describe("workflow journal fixture", () => {
  it("holds every event shape written by the real engine paths", () => {
    expect(fixture.length).toBeLessThan(4096); // keeps the exhaustive sweep cheap
    const recs = splitRecords(fixture);
    const evs = recs.map((r) => String((r.val as Record<string, unknown>).ev));
    expect(evs[0]).toBe("started");
    expect(evs[evs.length - 1]).toBe("finished");
    for (const want of ["node", "attempt-rejected", "interrupted", "resumed"]) {
      const hit = want === "attempt-rejected"
        ? recs.some((r) => (r.val as Record<string, unknown>).ev === "node" && (r.val as Record<string, unknown>).state === "attempt-rejected")
        : evs.includes(want);
      expect(hit, `fixture must contain ${want}`).toBe(true);
    }
    expect(evs.filter((e) => e === INTERRUPTED_EV).length).toBe(1);
    expect(evs.filter((e) => e === "finished").length).toBe(1);
    const mid = recs.findIndex((r) => (r.val as Record<string, unknown>).ev === INTERRUPTED_EV);
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(recs.length - 1);
  });
});

// ── Exhaustive byte-truncation sweep ────────────────────────────────

function variantCrlf(base: Buffer): Buffer {
  return Buffer.from(base.toString("utf8").replace(/\n/g, "\r\n"), "utf8");
}

async function sweep(label: string, buf: Buffer, failures: string[]): Promise<void> {
  const N = buf.length;
  const recs = splitRecords(buf);
  const vals = recs.map((r) => r.val);
  const finishedIdx = vals.findLastIndex((v) => (v as Record<string, unknown>)?.ev === "finished");
  let prevOutcome: string | null = null;
  let prevSucceeded: string[] = [];
  let phase = 0; // 0 = before started, 1 = in flight, 2 = finished: never regresses

  let midUtf8 = 0;
  let midCrlf = 0;
  for (let k = 0; k <= N && failures.length < 8; k++) {
    writeFileSync(JOURNAL, buf.subarray(0, k));
    try {
      const m = recs.reduce((acc, r) => acc + (r.end <= k ? 1 : 0), 0);
      const exp = fold(vals.slice(0, m));
      const got = await probe(SWEEP_DIR);
      const diff = diffExpect(got, exp);
      if (diff) failures.push(`${label} k=${k}: ${diff}`);

      // Durability truth on every torn shape: no completion without the whole
      // finished line (once the run-open line itself is whole and readable).
      const sum = got.sum as Folded["sum"];
      if (m > 0 && k < recs[finishedIdx]!.end) {
        if (sum && sum.outcome !== null) failures.push(`${label} k=${k}: run completed on a torn finished record`);
        if (!got.scan) failures.push(`${label} k=${k}: torn unfinished run not surfaced by scan`);
      }
      if (prevOutcome !== null && sum && sum.outcome !== prevOutcome) failures.push(`${label} k=${k}: outcome oscillated`);
      const nowSucceeded = (sum?.nodes ?? []).filter((n) => n.state === "succeeded").map((n) => String(n.id));
      if (prevSucceeded.some((id) => !nowSucceeded.includes(id))) failures.push(`${label} k=${k}: succeeded membership oscillated`);
      prevOutcome = sum?.outcome ?? null;
      prevSucceeded = nowSucceeded;
      const nowPhase = m === 0 ? 0 : got.scan ? 1 : 2;
      if (nowPhase < phase) failures.push(`${label} k=${k}: classification phase regressed ${phase} -> ${nowPhase}`);
      phase = nowPhase;
    } catch (e) {
      failures.push(`${label} k=${k} threw: ${String(e)}`);
    }
    if (k >= 1 && k < N && (buf[k]! & 0xc0) === 0x80) midUtf8++;
    if (k >= 1 && buf[k - 1] === 0x0d && buf[k] === 0x0a) midCrlf++;
  }
  // the sweep must have actually landed cuts inside multi-byte sequences
  expect({ failures, label }).toEqual({ failures: [], label });
  expect(midUtf8, `${label}: cuts inside UTF-8 sequences`).toBeGreaterThan(0);
  if (label === "crlf") expect(midCrlf, "crlf: cuts between CR and LF").toBeGreaterThan(0);
}

describe("workflow journal exhaustive truncation sweep", () => {
  it("every prefix scans/summarizes/reconciles with pinned classification (LF)", async () => {
    const failures: string[] = [];
    await sweep("lf", fixture, failures);
    expect(failures).toEqual([]);
  });

  it("every prefix of the CRLF-converted journal agrees (CR/LF cut class)", async () => {
    const failures: string[] = [];
    await sweep("crlf", variantCrlf(fixture), failures);
    expect(failures).toEqual([]);
  });
});

// ── Seeded single-byte corruption ───────────────────────────────────

const MUT_BYTES = [0x7b, 0x22, 0x5c, 0x6e, 0x7d, 0x2c, 0x65, 0x30, 0x61, 0x00, 0xff, 0x0a, 0x0d, 0x3a, 0x5d, 0x20, 0x80, 0xc3];

function mutate(rng: Rng, buf: Buffer, pos: number): Buffer {
  const out = Buffer.from(buf);
  const orig = out[pos]!;
  let b = MUT_BYTES[rng.int(MUT_BYTES.length)]!;
  for (let t = 0; t < 5 && b === orig; t++) b = MUT_BYTES[rng.int(MUT_BYTES.length)]!;
  if (b === orig) b = (orig ^ 0x2a) & 0xff;
  out[pos] = b;
  return out;
}

describe("workflow journal single-byte corruption", () => {
  const VARIANTS = [
    { name: "base", seed: 0xa11ce, build: (b: Buffer) => b },
    { name: "crlf-all", seed: 0xc0ffee, build: variantCrlf },
    { name: "no-trailing-newline", seed: 0xb0b, build: (b: Buffer) => Buffer.from(b.subarray(0, b.length - 1)) },
  ];
  const IN_RECORD_PROBES = 150;
  const TERMINATOR_PROBES = 14;

  it("hit-replacement fold holds: neighbors survive exactly, scans are stable", async () => {
    const failures: string[] = [];
    for (const v of VARIANTS) {
      const buf = v.build(fixture);
      const N = buf.length;
      const recs = splitRecords(buf);
      const recAt = new Int32Array(N).fill(-1);
      recs.forEach((r, i) => {
        for (let p = r.start; p < r.end; p++) recAt[p] = i;
      });
      const inRecord: number[] = [];
      const terminator: number[] = [];
      for (let p = 0; p < N; p++) (recAt[p]! >= 0 ? inRecord : terminator).push(p);
      const vals = recs.map((r) => r.val);

      const rng = makeRng(v.seed);
      for (let t = 0; t < IN_RECORD_PROBES && failures.length < 8; t++) {
        const pos = inRecord[rng.int(inRecord.length)]!;
        const L = recAt[pos]!;
        const mutated = mutate(rng, buf, pos);
        writeFileSync(JOURNAL, mutated);
        const label = `${v.name} pos=${pos} rec=${L}`;
        try {
          const g1 = await probe(SWEEP_DIR);
          const g2 = await probe(SWEEP_DIR);
          if (JSON.stringify(g1) !== JSON.stringify(g2)) {
            failures.push(`${label}: scan unstable across repeats`);
            continue;
          }
          // Hit-replacement oracle: line L is re-parsed from the mutated bytes
          // (torn means dropped); every other record survives byte-unchanged.
          // A newline mutagen can split line L, but neither half can parse (the
          // head starts with `{` and stays unterminated; the tail starts
          // mid-token), so the fold stays exact.
          const hitLine = mutated.toString("utf8").split("\n")[L]?.trim() ?? "";
          let hit: unknown;
          try {
            hit = JSON.parse(hitLine);
          } catch {
            hit = undefined;
          }
          const exp = fold(vals.map((val, i) => (i === L ? hit : val)));
          const diff = diffExpect(g1, exp);
          if (diff) failures.push(`${label}: ${diff}`);
        } catch (e) {
          failures.push(`${label}: threw ${String(e)}`);
        }
      }

      // Terminator bytes may merge/split lines: pin crash-freedom, repeat
      // stability, and cross-consumer agreement (surfaced IFF started intact
      // and unfinished), not per-record survival.
      for (let t = 0; t < TERMINATOR_PROBES && failures.length < 8; t++) {
        const pos = terminator[rng.int(terminator.length)]!;
        writeFileSync(JOURNAL, mutate(rng, buf, pos));
        const label = `${v.name} term pos=${pos}`;
        try {
          const g1 = await probe(SWEEP_DIR);
          const g2 = await probe(SWEEP_DIR);
          if (JSON.stringify(g1) !== JSON.stringify(g2)) failures.push(`${label}: scan unstable`);
          const surfaced = g1.scan !== null;
          const incomplete = g1.sum !== null && (g1.sum as Folded["sum"])!.outcome === null;
          if (surfaced !== incomplete) failures.push(`${label}: scan/summary disagree on completion`);
          if ((g1.sum === null) !== (g1.recon === "THROWS")) failures.push(`${label}: summary/reconcile disagree on started`);
        } catch (e) {
          failures.push(`${label}: threw ${String(e)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

// ── Edge inputs ─────────────────────────────────────────────────────

describe("workflow journal edge inputs", () => {
  async function check(label: string, bytes: Buffer | null): Promise<void> {
    if (bytes === null) {
      // dir exists but holds no journal at all
      const empty = join(SCAN_ROOT, "empty");
      mkdirSync(empty, { recursive: true });
      const got = await probe(empty);
      expect({ label, got }).toEqual({ label, got: { sum: null, scan: null, recon: "THROWS" } });
      return;
    }
    writeFileSync(JOURNAL, bytes);
    const recs = splitRecords(bytes);
    const exp = fold(recs.map((r) => r.val));
    const got = await probe(SWEEP_DIR);
    const diff = diffExpect(got, exp);
    expect({ label, diff }).toEqual({ label, diff: "" });
  }

  const GARBAGE = [
    "not json at all\n",
    "null\n",
    "5\n\"str\"\ntrue\n[1,2]\n",
    "{}\n",
    "\u0000\u00ff binary \ud800 lone surrogate\n",
    `{"ev":"started","runId":"g","workflow":"g","nodes":5}\n{"ev":"node","id":"a","state":"succeeded","deps":"x","files":7}\n`,
    `{"ev":"started","nodes":[]}\n{"ev":"node","state":"succeeded"}\n{"ev":"finished"}\n`,
    `{"ev":"finished","outcome":"succeeded"}\n`, // terminal without a run-open
    "null\nnull\n",
  ];

  for (const [i, text] of GARBAGE.entries()) {
    it(`garbage corpus #${i} never crashes and folds as expected`, async () => {
      await check(`g${i}`, Buffer.from(text, "utf8"));
    });
  }

  it("empty file, only newlines, CRLF-only and no-journal read as empty", async () => {
    await check("empty", Buffer.alloc(0));
    for (const text of ["\n", "\r\n", "\n\n\n", "\r\n\r\n"]) await check("blank", Buffer.from(text, "utf8"));
    await check("no-journal", null);
  });

  it("seeded random binary garbage never crashes and folds exactly", async () => {
    const rng = makeRng(0x9e3779b9);
    for (let t = 0; t < 12; t++) {
      const n = 1 + rng.int(400);
      const b = Buffer.from(rng.bytes(n));
      writeFileSync(JOURNAL, b);
      const recs = splitRecords(b);
      const exp = fold(recs.map((r) => r.val));
      const got = await probe(SWEEP_DIR);
      const diff = diffExpect(got, exp);
      expect({ t, diff }).toEqual({ t, diff: "" });
    }
  });
});
