// Eval framework data model. Standalone: nothing here imports from src/.

/** A swappable agent harness: any command that takes a prompt and does work in cwd. */
export interface HarnessSpec {
  id: string;
  command: string;
  /** Argv template. Placeholders: {prompt} {model} {repo} {schema_file}. */
  args: string[];
  /** Extra env for the spawned process (merged over the runner's env). */
  env?: Record<string, string>;
  /** "arg" (default): prompt substituted at {prompt}. "stdin": prompt written to stdin. */
  prompt_via?: "arg" | "stdin";
}

export interface SeriesSpec {
  name: string;
  repeat: number;
  concurrency: number;
  timeout_secs: number;
}

export type Check =
  | { type: "exit_code"; equals: number }
  | { type: "stdout_match"; pattern: string; flags?: string }
  | { type: "stdout_not_match"; pattern: string; flags?: string }
  | { type: "file_exists"; path: string }
  | { type: "file_absent"; path: string }
  | { type: "file_match"; path: string; pattern: string; flags?: string }
  | { type: "command"; cmd: string; equals?: number };

export interface ServeSpec {
  /** Shell command run (bash -lc) in the workspace before the agent starts. */
  cmd: string;
  /** Polled until it answers (any HTTP status) before the agent spawns. */
  ready_url: string;
  /** Seconds to wait for ready_url; failing it fails the run. Default 15. */
  ready_timeout_secs?: number;
}

export interface TaskSpec {
  id: string;
  prompt: string;
  /** Dir (relative to the task file) copied into the run workspace before the agent starts. */
  fixtures?: string;
  timeout_secs?: number;
  checks: Check[];
  /** Optional LLM judge on top of the deterministic checks. */
  judge?: { rubric: string };
  /** Extra env for the harness spawn (merged over the harness spec's env). */
  env?: Record<string, string>;
  /** Fake webapp to run for the duration of the agent spawn. */
  serve?: ServeSpec;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface HarnessRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface MatrixCell {
  runId: string;
  task: TaskSpec;
  harnessId: string;
  model: string;
  repeatIdx: number;
}

export interface RunRecord {
  run_id: string;
  series: string;
  task: string;
  harness: string;
  model: string;
  repeat: number;
  started_at: string;
  duration_ms: number;
  exit_code: number | null;
  timed_out: boolean;
  stdout_tail: string;
  stderr_tail: string;
  checks: CheckResult[];
  pass: boolean;
  /** True when the harness spawn ran inside bwrap. */
  sandboxed: boolean;
}
