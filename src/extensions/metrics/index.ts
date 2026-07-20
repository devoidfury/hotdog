// Metrics Extension
// Exports per-run LLM metrics to a CSV file.
//
// Each row captures: model, backend, prompt tokens, decode tokens,
// TTFT (time to first token), tok/s (throughput), memory usage,
// and workload label.
//
// CSV is appended to on each completed turn. The file is created
// in ~/.cache/hotdog/metrics.csv by default, or at a custom path
// if configured via metrics.outputFile.

import { homedir } from "node:os";
import { join } from "node:path";
import { appendFile, mkdir, access } from "node:fs/promises";
import { HOOKS } from "../../core/hooks.ts";
import { CoreContext, ExtensionInstance, getExtensionConfig } from "../../core/extensions/types.ts";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Per-turn metrics accumulator.
 * Tracks timing and token data for the current turn.
 */
interface TurnMetrics {
  turnIndex: number;
  sessionId: string;
  // Timing
  requestStartMs: number | null;
  firstTokenMs: number | null;
  responseEndMs: number | null;
  // Model info
  model: string | null;
  backend: string | null;
  // Token counts
  promptTokens: number | null;
  completionTokens: number | null;
  // Memory (if available from provider)
  memoryBytes: number | null;
}

/**
 * Final CSV row data.
 */
interface MetricsRow {
  timestamp: string;
  model: string;
  backend: string;
  prompt_tokens: number;
  completion_tokens: number;
  ttft_ms: number;
  tok_per_sec: number;
  memory_bytes: number;
  workload_label: string;
}

const CSV_HEADER = "timestamp,model,backend,prompt_tokens,completion_tokens,ttft_ms,tok_per_sec,memory_bytes,workload_label";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get the metrics output directory, creating it if needed.
 */
async function getMetricsDir(): Promise<string> {
  const cacheDir = join(homedir(), ".cache", "hotdog");
  try {
    await access(cacheDir);
  } catch {
    await mkdir(cacheDir, { recursive: true });
  }
  return cacheDir;
}

/**
 * Get the default CSV output path.
 */
async function getDefaultOutputPath(): Promise<string> {
  const cacheDir = await getMetricsDir();
  return join(cacheDir, "metrics.csv");
}

/**
 * Escape a CSV field value — wraps in quotes if it contains commas, quotes, or newlines.
 */
export function csvEscape(value: string | number): string {
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build a CSV row string from metrics data.
 */
export function buildCsvRow(row: MetricsRow): string {
  return [
    csvEscape(row.timestamp),
    csvEscape(row.model),
    csvEscape(row.backend),
    csvEscape(row.prompt_tokens),
    csvEscape(row.completion_tokens),
    csvEscape(row.ttft_ms),
    csvEscape(row.tok_per_sec),
    csvEscape(row.memory_bytes),
    csvEscape(row.workload_label),
  ].join(",");
}

/**
 * Write a CSV row to the output file, creating the file with a header if needed.
 */
async function appendMetricsRow(outputPath: string, row: MetricsRow, fileExists: boolean): Promise<void> {
  const line = (fileExists ? "" : CSV_HEADER + "\n") + buildCsvRow(row) + "\n";
  await appendFile(outputPath, line);
}

// ── Extension ───────────────────────────────────────────────────────────────

/**
 * Create the metrics extension.
 *
 * Hooks used:
 *   - provider:request  — record request start time
 *   - output:event      — detect first streaming chunk for TTFT
 *   - provider:response — capture usage data and model info
 *   - turn:end          — write CSV row when turn completes
 */
export async function create(core: CoreContext): Promise<ExtensionInstance> {
  const config = getExtensionConfig<{ outputFile?: string | null }>(core, "metrics");

  // Resolve output file path
  const outputPath = config.outputFile || (await getDefaultOutputPath());

  // Check if file already exists (to decide whether to write header)
  let fileExists = true;
  try {
    await access(outputPath);
    // If file is empty, treat as new
    const { stat } = await import("node:fs/promises");
    const stats = await stat(outputPath);
    fileExists = stats.size > 0;
  } catch {
    fileExists = false;
  }

  // Track per-turn metrics
  let currentTurn: TurnMetrics | null = null;

  return {
    hooks: {
      /**
       * Record the start of the provider request.
       * This is the most accurate start time for TTFT calculation.
       */
      [HOOKS.PROVIDER_REQUEST]: ({
        modelConfig,
      }: {
        modelConfig: { name: string };
      }) => {
        currentTurn = {
          turnIndex: 0,
          sessionId: "unknown",
          requestStartMs: Date.now(),
          firstTokenMs: null,
          responseEndMs: null,
          model: modelConfig.name,
          backend: modelConfig.name.split("/")[0] || modelConfig.name,
          promptTokens: null,
          completionTokens: null,
          memoryBytes: null,
        };
      },

      /**
       * Detect the first streaming content chunk for TTFT measurement.
       * Only record once per turn.
       */
      [HOOKS.OUTPUT_EVENT]: ({
        type,
        agent,
      }: {
        type: string;
        agent?: { sessionId?: string };
      }) => {
        if (!currentTurn) return;

        // Update session ID from agent if available
        if (agent?.sessionId) {
          currentTurn.sessionId = agent.sessionId;
        }

        // First content chunk = TTFT
        if (type === "streaming_chunk" && currentTurn.firstTokenMs === null) {
          currentTurn.firstTokenMs = Date.now();
        }
      },

      /**
       * Capture response data after the provider returns.
       * Extracts token usage and other metrics from the response.
       */
      [HOOKS.PROVIDER_RESPONSE]: ({
        response,
        modelConfig,
      }: {
        response: { usage?: Record<string, unknown> | null };
        modelConfig: { name: string };
      }) => {
        if (!currentTurn) return;

        currentTurn.responseEndMs = Date.now();

        // Update model/backend from actual response
        currentTurn.model = modelConfig.name;
        currentTurn.backend = modelConfig.name.split("/")[0] || modelConfig.name;

        // Extract token usage from response
        const usage = response.usage;
        if (usage) {
          currentTurn.promptTokens =
            (usage.prompt_tokens as number) || null;
          currentTurn.completionTokens =
            (usage.completion_tokens as number) || null;

          // Some providers include memory/usage details
          // Check for various memory-related fields
          const memoryTokens = usage.memory_tokens as number | undefined;
          const cachedTokens = (usage.prompt_tokens_details as Record<string, unknown>)
            ?.cached_tokens as number | undefined;

          // Store memory info if available (as bytes estimate or raw value)
          if (memoryTokens != null) {
            currentTurn.memoryBytes = memoryTokens;
          } else if (cachedTokens != null) {
            // cached_tokens is sometimes used as a proxy for context cache usage
            currentTurn.memoryBytes = cachedTokens;
          }
        }
      },

      /**
       * Write CSV row when a turn ends with a final response.
       * Only writes when stopped: true (final turn of a run).
       */
      [HOOKS.TURN_END]: async ({
        stopped,
        turnIndex,
        agent,
      }: {
        stopped: boolean;
        turnIndex: number;
        agent?: { sessionId?: string };
      }) => {
        // Only write metrics for the final turn of a run
        if (!stopped || !currentTurn) return;

        // Update turn index and session from hook payload
        currentTurn.turnIndex = turnIndex;
        if (agent?.sessionId) {
          currentTurn.sessionId = agent.sessionId;
        }

        // If we have response data, compute and write metrics
        if (currentTurn.responseEndMs != null) {
          const row = computeMetricsRow(currentTurn);
          await appendMetricsRow(outputPath, row, fileExists);
          fileExists = true; // Subsequent writes don't need header
        }

        // Reset for next run
        currentTurn = null;
      },
    },
  };
}

/**
 * Compute a final metrics row from accumulated turn data.
 */
export function computeMetricsRow(turn: TurnMetrics): MetricsRow {
  const promptTokens = turn.promptTokens ?? 0;
  const completionTokens = turn.completionTokens ?? 0;

  // TTFT: time from request start to first token
  const ttftMs =
    turn.requestStartMs != null && turn.firstTokenMs != null
      ? turn.firstTokenMs - turn.requestStartMs
      : 0;

  // Total response duration
  const responseDurationMs =
    turn.requestStartMs != null && turn.responseEndMs != null
      ? turn.responseEndMs - turn.requestStartMs
      : 0;

  // Tokens per second (completion tokens / response duration)
  const tokPerSec =
    responseDurationMs > 0
      ? Math.round((completionTokens / responseDurationMs) * 1000 * 100) / 100
      : 0;

  return {
    timestamp: new Date().toISOString(),
    model: turn.model ?? "unknown",
    backend: turn.backend ?? "unknown",
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    ttft_ms: ttftMs,
    tok_per_sec: tokPerSec,
    memory_bytes: turn.memoryBytes ?? 0,
    workload_label: "hotdog",
  };
}
