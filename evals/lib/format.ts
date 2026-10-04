import type { MatrixCell, RunRecord } from "./types.ts";

export function fmtErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function resultsDirName(seriesName: string, date: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${seriesName}-${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}

export interface Row {
  cell: string;
  total: number;
  passed: number;
  totalMs: number;
}

/** Aggregate records into harness@model rows, longest-first cell label padding handled by caller. */
export function summarize(records: RunRecord[]): Row[] {
  const map = new Map<string, Row>();
  for (const r of records) {
    const key = `${r.harness}@${r.model}`;
    const row = map.get(key) ?? { cell: key, total: 0, passed: 0, totalMs: 0 };
    row.total += 1;
    if (r.pass) row.passed += 1;
    row.totalMs += r.duration_ms;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => a.cell.localeCompare(b.cell));
}

export function formatSummary(
  seriesName: string,
  resultsDir: string,
  records: RunRecord[],
): string {
  const passed = records.filter((r) => r.pass).length;
  const lines: string[] = [];
  lines.push(`Series: ${seriesName} -> ${resultsDir}`);
  if (records.length > 0) {
    const sandbox = records.every((r) => r.sandboxed) ? "bwrap" : records.some((r) => r.sandboxed) ? "MIXED" : "off";
    lines.push(`sandbox: ${sandbox}`);
  }
  lines.push(`runs: ${records.length}  passed: ${passed}  failed: ${records.length - passed}`);
  if (records.length === 0) return lines.join("\n");
  const rows = summarize(records);
  const width = Math.max(14, ...rows.map((r) => r.cell.length));
  lines.push("");
  lines.push(`${"harness@model".padEnd(width)}  pass/total  avg_s`);
  for (const r of rows) {
    const avg = (r.totalMs / r.total / 1000).toFixed(1);
    lines.push(`${r.cell.padEnd(width)}  ${`${r.passed}/${r.total}`.padEnd(10)}  ${avg.padStart(5)}`);
  }
  const failed = records.filter((r) => !r.pass);
  if (failed.length > 0) {
    lines.push("");
    lines.push("failures:");
    for (const r of failed) {
      const reasons = r.checks.filter((c) => !c.pass).map((c) => `${c.name}${c.detail ? ` (${c.detail.split("\n")[0]})` : ""}`);
      lines.push(`  ${r.run_id}: ${reasons.join("; ") || "no checks recorded"}`);
    }
  }
  return lines.join("\n");
}

export function formatDryRun(cells: MatrixCell[]): string {
  const lines: string[] = [`planned runs: ${cells.length}`, ""];
  for (const c of cells) {
    lines.push(`  ${c.runId}`);
  }
  return lines.join("\n");
}
