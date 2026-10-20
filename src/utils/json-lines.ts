// JSONL reading: one trim/parse loop, with the bad-line policy declared by the caller.

import { logger } from "./logger.ts";

/**
 * - `"skip"`: best-effort scan. A torn tail or a foreign line is expected noise; nothing downstream depends on every record surviving.
 * - `"warn"`: every record matters (replay, audit). Unparsable lines are still dropped -- a log read must not fail -- but the loss is logged.
 */
export type BadLinePolicy = "skip" | "warn";

const SNIPPET_LIMIT = 80;

/**
 * Parse JSONL `text` into values, dropping blank lines and lines that are not valid JSON.
 * Values are not validated beyond being JSON; callers keep their own shape checks.
 *
 * `label` prefixes the warning message so a warn says which log was bad.
 */
export function parseJsonLines<T = Record<string, unknown>>(
  text: string,
  onBad: BadLinePolicy = "skip",
  label = "jsonl",
): T[] {
  const out: T[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      if (onBad !== "warn") continue;
      const snippet = line.length > SNIPPET_LIMIT ? line.slice(0, SNIPPET_LIMIT) + "..." : line;
      logger.warn(`[${label}] malformed JSON line ${i + 1}: "${snippet}"`);
    }
  }
  return out;
}
