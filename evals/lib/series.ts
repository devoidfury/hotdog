import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, MatrixCell, SeriesSpec, TaskSpec } from "./types.ts";

const SERIES_KEYS = ["name", "repeat", "concurrency", "timeout_secs"];
const TASK_KEYS = ["id", "prompt", "fixtures", "timeout_secs", "checks", "judge", "env", "serve"];
const CHECK_TYPES = ["exit_code", "stdout_match", "stdout_not_match", "file_exists", "file_absent", "file_match", "command"];

function plainObject(value: unknown, ctx: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${ctx}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(obj: Record<string, unknown>, allowed: string[], ctx: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new Error(`${ctx}: unknown key "${key}"`);
  }
}

function reqString(obj: Record<string, unknown>, key: string, ctx: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v) throw new Error(`${ctx}: "${key}" must be a non-empty string`);
  return v;
}

function parseCheck(raw: unknown, ctx: string): Check {
  const obj = plainObject(raw, ctx);
  const type = obj.type;
  if (typeof type !== "string" || !CHECK_TYPES.includes(type)) {
    throw new Error(`${ctx}: "type" must be one of ${CHECK_TYPES.join(", ")}`);
  }
  switch (type) {
    case "exit_code":
      if (typeof obj.equals !== "number") throw new Error(`${ctx}: "equals" must be a number`);
      rejectUnknown(obj, ["type", "equals"], ctx);
      break;
    case "stdout_match":
    case "stdout_not_match":
      reqString(obj, "pattern", ctx);
      if (obj.flags !== undefined && typeof obj.flags !== "string") throw new Error(`${ctx}: "flags" must be a string`);
      rejectUnknown(obj, ["type", "pattern", "flags"], ctx);
      break;
    case "file_exists":
    case "file_absent":
      reqString(obj, "path", ctx);
      rejectUnknown(obj, ["type", "path"], ctx);
      break;
    case "file_match":
      reqString(obj, "pattern", ctx);
      reqString(obj, "path", ctx);
      if (obj.flags !== undefined && typeof obj.flags !== "string") throw new Error(`${ctx}: "flags" must be a string`);
      rejectUnknown(obj, ["type", "pattern", "path", "flags"], ctx);
      break;
    case "command":
      reqString(obj, "cmd", ctx);
      if (obj.equals !== undefined && typeof obj.equals !== "number") throw new Error(`${ctx}: "equals" must be a number`);
      rejectUnknown(obj, ["type", "cmd", "equals"], ctx);
      break;
  }
  return obj as unknown as Check;
}

export function parseTask(path: string, text: string): TaskSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const obj = plainObject(raw, path);
  rejectUnknown(obj, TASK_KEYS, path);
  const id = reqString(obj, "id", path);
  const prompt = reqString(obj, "prompt", path);
  if (obj.fixtures !== undefined && typeof obj.fixtures !== "string") throw new Error(`${path}: "fixtures" must be a string`);
  if (obj.timeout_secs !== undefined && typeof obj.timeout_secs !== "number") throw new Error(`${path}: "timeout_secs" must be a number`);
  if (!Array.isArray(obj.checks) || obj.checks.length === 0) throw new Error(`${path}: "checks" must be a non-empty array`);
  const checks = obj.checks.map((c, i) => parseCheck(c, `${path} checks[${i}]`));
  const judge = obj.judge;
  if (judge !== undefined) {
    const j = plainObject(judge, `${path} judge`);
    reqString(j, "rubric", `${path} judge`);
    rejectUnknown(j, ["rubric"], `${path} judge`);
  }
  const env = obj.env;
  if (env !== undefined) {
    const e = plainObject(env, `${path} env`);
    for (const [k, v] of Object.entries(e)) {
      if (typeof v !== "string") throw new Error(`${path} env: "${k}" must be a string`);
    }
  }
  const serve = obj.serve;
  if (serve !== undefined) {
    const s = plainObject(serve, `${path} serve`);
    reqString(s, "cmd", `${path} serve`);
    reqString(s, "ready_url", `${path} serve`);
    if (s.ready_timeout_secs !== undefined && (typeof s.ready_timeout_secs !== "number" || s.ready_timeout_secs < 1)) {
      throw new Error(`${path} serve: "ready_timeout_secs" must be a number >= 1`);
    }
    rejectUnknown(s, ["cmd", "ready_url", "ready_timeout_secs"], `${path} serve`);
  }
  return {
    id,
    prompt,
    ...(typeof obj.fixtures === "string" ? { fixtures: obj.fixtures } : {}),
    ...(typeof obj.timeout_secs === "number" ? { timeout_secs: obj.timeout_secs } : {}),
    checks,
    ...(judge !== undefined ? { judge: { rubric: (judge as Record<string, unknown>).rubric as string } } : {}),
    ...(env !== undefined ? { env: env as Record<string, string> } : {}),
    ...(serve !== undefined
      ? {
          serve: {
            cmd: (serve as Record<string, unknown>).cmd as string,
            ready_url: (serve as Record<string, unknown>).ready_url as string,
            ...((serve as Record<string, unknown>).ready_timeout_secs !== undefined
              ? { ready_timeout_secs: (serve as Record<string, unknown>).ready_timeout_secs as number }
              : {}),
          },
        }
      : {}),
  };
}

export function parseSeries(path: string, text: string): SeriesSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const obj = plainObject(raw, path);
  rejectUnknown(obj, SERIES_KEYS, path);
  const name = reqString(obj, "name", path);
  const num = (key: string, def: number): number => {
    const v = obj[key];
    if (v === undefined) return def;
    if (typeof v !== "number" || v < 1) throw new Error(`${path}: "${key}" must be a number >= 1`);
    return v;
  };
  return {
    name,
    repeat: num("repeat", 1),
    concurrency: num("concurrency", 1),
    timeout_secs: num("timeout_secs", 600),
  };
}

export interface LoadedSeries {
  series: SeriesSpec;
  tasks: TaskSpec[];
  /** Directory containing the task files. */
  tasksDir: string;
  /** Directory containing series.json. */
  seriesDir: string;
}

export function loadSeries(seriesDir: string): LoadedSeries {
  const seriesPath = join(seriesDir, "series.json");
  const series = parseSeries(seriesPath, readFileSync(seriesPath, "utf8"));
  const tasksDir = join(seriesDir, "tasks");
  const taskFiles = readdirSync(tasksDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (taskFiles.length === 0) throw new Error(`${tasksDir}: no task .json files found`);
  const tasks = taskFiles.map((f) => parseTask(join(tasksDir, f), readFileSync(join(tasksDir, f), "utf8")));
  const seen = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.id)) throw new Error(`duplicate task id "${t.id}"`);
    seen.add(t.id);
  }
  return { series, tasks, tasksDir, seriesDir };
}

export function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

/**
 * Harnesses and models come from the caller (CLI flags), never from series.json:
 * the same task pack must be runnable against any (model x harness) matrix.
 */
export function buildMatrix(
  loaded: LoadedSeries,
  filters: { harnesses: string[]; models: string[]; tasks?: string[]; repeat?: number },
): MatrixCell[] {
  const { series, tasks } = loaded;
  if (!filters.harnesses.length) throw new Error("at least one --harness is required");
  if (!filters.models.length) throw new Error("at least one --model is required");
  const harnesses = filters.harnesses;
  const models = filters.models;
  // Duplicate flags would generate identical runIds (colliding session dirs).
  for (const [flag, list] of [["--harness", harnesses], ["--model", models]] as const) {
    const dup = list.find((v, i) => list.indexOf(v) !== i);
    if (dup !== undefined) throw new Error(`duplicate ${flag} "${dup}"`);
  }
  const wantedTasks = filters.tasks?.length ? tasks.filter((t) => filters.tasks!.includes(t.id)) : tasks;
  if (filters.tasks?.length) {
    for (const t of filters.tasks) {
      if (!tasks.some((x) => x.id === t)) throw new Error(`task "${t}" is not in this series`);
    }
  }
  if (wantedTasks.length === 0) throw new Error("no tasks left after filtering");
  const repeat = filters.repeat ?? series.repeat;
  const cells: MatrixCell[] = [];
  for (const task of wantedTasks) {
    for (const harnessId of harnesses) {
      for (const model of models) {
        for (let i = 1; i <= repeat; i++) {
          cells.push({
            runId: `${task.id}__${sanitizeId(harnessId)}__${sanitizeId(model)}__r${i}`,
            task,
            harnessId,
            model,
            repeatIdx: i,
          });
        }
      }
    }
  }
  return cells;
}
