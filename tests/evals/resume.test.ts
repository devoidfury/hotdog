import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyResume, loadPriorRuns, resolveResumeDir } from "../../evals/lib/resume.ts";
import type { MatrixCell, RunRecord, TaskSpec } from "../../evals/lib/types.ts";

function rec(runId: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: runId, series: "kielbasa-1", task: runId.split("__")[0]!, harness: "hotdog", model: "m1",
    repeat: 1, started_at: "", duration_ms: 1000, exit_code: 0, timed_out: false,
    stdout_tail: "", stderr_tail: "", checks: [], pass: true, sandboxed: true, ...over,
  };
}

function cell(runId: string): MatrixCell {
  const task: TaskSpec = { id: runId.split("__")[0]!, prompt: "p", checks: [{ type: "exit_code", equals: 0 }] };
  return { runId, task, harnessId: "hotdog", model: "m1", repeatIdx: 1 };
}

describe("loadPriorRuns", () => {
  it("reads records, last occurrence of a run_id wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-resume-"));
    try {
      const f = join(dir, "runs.jsonl");
      writeFileSync(f, JSON.stringify(rec("a", { pass: false })) + "\n" + JSON.stringify(rec("a", { pass: true })) + "\n" + JSON.stringify(rec("b")) + "\n");
      const prior = loadPriorRuns(f);
      expect(prior.malformed).toBe(0);
      expect(prior.records.map((r) => r.run_id).sort()).toEqual(["a", "b"]);
      expect(prior.records.find((r) => r.run_id === "a")!.pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a torn trailing line (crash mid-append) and junk objects", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-resume-"));
    try {
      const f = join(dir, "runs.jsonl");
      writeFileSync(f, JSON.stringify(rec("a")) + "\n" + '{"run_id":"b","series":"kie' + "\n" + "[1,2]\n" + "\n");
      const prior = loadPriorRuns(f);
      expect(prior.records.map((r) => r.run_id)).toEqual(["a"]);
      expect(prior.malformed).toBe(2); // torn line + array (no run_id)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing file is an empty prior, not an error", () => {
    const prior = loadPriorRuns(join(tmpdir(), "eval-resume-does-not-exist", "runs.jsonl"));
    expect(prior.records).toEqual([]);
    expect(prior.malformed).toBe(0);
  });
});

describe("resolveResumeDir", () => {
  it("accepts a path and a bare name under the results root", () => {
    const root = mkdtempSync(join(tmpdir(), "eval-resume-"));
    try {
      const abs = join(root, "results", "kielbasa-1-20261020-010101");
      mkdirSync(abs, { recursive: true });
      const named = join(root, "results");
      mkdirSync(join(named, "by-name"), { recursive: true });
      mkdirSync(join(root, "rel-dir"));
      expect(resolveResumeDir(abs, root, named)).toBe(abs);
      expect(resolveResumeDir("rel-dir", root, named)).toBe(join(root, "rel-dir"));
      expect(resolveResumeDir("by-name", "/nope", named)).toBe(join(named, "by-name"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws on a typo instead of silently starting fresh", () => {
    const root = mkdtempSync(join(tmpdir(), "eval-resume-"));
    try {
      expect(() => resolveResumeDir("kielbasa-1-29991231-00000", root, root)).toThrow("no such directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("applyResume", () => {
  it("skips cells with prior records, plans the rest, preserves order", () => {
    const cells = ["t1__h__m__r1", "t2__h__m__r1", "t3__h__m__r1", "t3__h__m__r2"].map(cell);
    const { planned, skipped } = applyResume(cells, [rec("t2__h__m__r1"), rec("t3__h__m__r1")]);
    expect(skipped.map((c) => c.runId)).toEqual(["t2__h__m__r1", "t3__h__m__r1"]);
    expect(planned.map((c) => c.runId)).toEqual(["t1__h__m__r1", "t3__h__m__r2"]);
  });

  it("prior records for other run_ids (widened matrix) skip nothing", () => {
    const { planned, skipped } = applyResume([cell("t1__other__m2__r1")], [rec("t1__hotdog__m1__r1")]);
    expect(planned.length).toBe(1);
    expect(skipped.length).toBe(0);
  });
});

describe("run.ts --resume (flag level, dry-run only)", () => {
  const runTs = join(import.meta.dir, "..", "..", "evals", "run.ts");
  const repo = join(import.meta.dir, "..", "..");
  const runCli = (args: string[]) =>
    Bun.spawnSync(
      [
        process.execPath, runTs,
        "--series", "series/kielbasa-1", "--harness", "hotdog", "--model", "m1",
        // kielbasa-1 has judge tasks (002, 004); dry-run still requires the pair.
        "--judge-harness", "hotdog-judge", "--judge-model", "jm",
        ...args,
      ],
      { cwd: repo, stdout: "pipe", stderr: "pipe" },
    );

  const baseTask = {
    run_id: "", series: "kielbasa-1", task: "001-greet", harness: "hotdog", model: "m1",
    repeat: 1, started_at: "", duration_ms: 1, exit_code: 0, timed_out: false,
    stdout_tail: "", stderr_tail: "", checks: [], pass: true, sandboxed: true,
  };

  it("rejects a resume dir that does not exist", () => {
    const res = runCli(["--resume", "/nonexistent-eval-results-dir", "--dry-run"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toString()).toContain("no such directory");
  });

  it("skips planned cells whose run_ids are already recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-resume-cli-"));
    try {
      writeFileSync(
        join(dir, "runs.jsonl"),
        JSON.stringify({ ...baseTask, run_id: "001-greet__hotdog__m1__r1" }) + "\n" +
          JSON.stringify({ ...baseTask, run_id: "002-bash-haiku__hotdog__m1__r1" }) + "\n" +
          '{"run_id":"003-fix-bug__hotdog__m1__r1","seri', // torn tail re-runs
      );
      const res = runCli(["--resume", dir, "--dry-run"]);
      expect(res.exitCode).toBe(0);
      const out = res.stdout.toString();
      expect(out).toContain("skipping 2 completed run(s)");
      expect(out).toContain("ignored 1 malformed line");
      expect(out).not.toContain("001-greet__hotdog__m1__r1");
      expect(out).toContain("003-fix-bug__hotdog__m1__r1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a resume dir belonging to another series", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-resume-cli-"));
    try {
      writeFileSync(join(dir, "runs.jsonl"), JSON.stringify({ ...baseTask, run_id: "x", series: "kielbasa-2" }) + "\n");
      const res = runCli(["--resume", dir, "--dry-run"]);
      expect(res.exitCode).toBe(1);
      expect(res.stderr.toString()).toContain('holds series "kielbasa-2"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
