// Resume support: continue a half-finished sweep in an existing results dir.
// The runner already appends one JSONL record per completed cell, so resume
// is just "read the prior file, skip its run_ids, keep appending".
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MatrixCell, RunRecord } from "./types.ts";

export interface PriorRuns {
  /** Latest record per run_id (a re-run appended later in the file wins). */
  records: RunRecord[];
  /** Lines that failed to parse; a crash mid-append can leave a torn tail. */
  malformed: number;
}

/** Read runs.jsonl tolerantly: a torn trailing line counts as not-completed
 * (the cell re-runs), it never aborts the resume. */
export function loadPriorRuns(runsFilePath: string): PriorRuns {
  const byId = new Map<string, RunRecord>();
  let malformed = 0;
  if (existsSync(runsFilePath)) {
    for (const line of readFileSync(runsFilePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformed++;
        continue;
      }
      const r = parsed as Partial<RunRecord> | null;
      if (!r || typeof r.run_id !== "string" || typeof r.series !== "string") {
        malformed++;
        continue;
      }
      byId.set(r.run_id, r as RunRecord);
    }
  }
  return { records: [...byId.values()], malformed };
}

/** Resolve a --resume argument: a path (cwd-relative or absolute) or a bare
 * results-dir name under evals/results. Throws when nothing exists, so a typo
 * cannot silently start a fresh sweep instead of resuming one. */
export function resolveResumeDir(arg: string, cwd: string, resultsRoot: string): string {
  const candidates = [resolve(cwd, arg), resolve(resultsRoot, arg)];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  throw new Error(`--resume "${arg}": no such directory (tried ${candidates.join(", ")})`);
}

export interface ResumePlan {
  planned: MatrixCell[];
  skipped: MatrixCell[];
}

/** Cells whose run_id already has a prior record are skipped. A widened
 * matrix over the same dir (new harness/model flags) just adds cells. */
export function applyResume(cells: MatrixCell[], prior: RunRecord[]): ResumePlan {
  const done = new Set(prior.map((r) => r.run_id));
  const planned: MatrixCell[] = [];
  const skipped: MatrixCell[] = [];
  for (const c of cells) (done.has(c.runId) ? skipped : planned).push(c);
  return { planned, skipped };
}
