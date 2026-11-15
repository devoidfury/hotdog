/**
 * The tombstone table for config keys that once existed and were removed.
 *
 * Lives beside (not inside) rescue.ts because two consumers read it and the
 * import rules rule out the obvious host: rescue.ts imports ./index.ts, so a
 * loadConfig-side boot warning cannot import from rescue.ts without a cycle.
 *
 * These keys are not UNKNOWN (a did-you-mean would mislead); rescue renders a
 * tombstone verdict that names the replacement, with a caret at the offending
 * line, at every nesting depth; loadConfig warns once per load on top-level
 * occurrences (the boot nudge; the rescue verdict stays the full report).
 * Exception: `topLevelOnly` entries judge their ROOT occurrence only --
 * `temperature`'s named replacement is `providers[].temperature` /
 * `providers[].models[].temperature`, so flagging those nested fields would
 * contradict the tombstone itself.
 */
export interface RemovedKeyTombstone {
  key: string;
  replacement: string;
  note?: string;
  topLevelOnly?: boolean;
}

const THINKER_TOMBSTONE = {
  replacement: "the built-in '[Thinking: ...]' display (hideThinking drops thinking output)",
  note: "the CLI think-format knob retired -- the {} format string shipped broken",
};

export const REMOVED_KEYS: RemovedKeyTombstone[] = [
  {
    key: "maxToolOutputLines",
    replacement: "maxToolResultChars",
    note:
      "line-shaping knobs retired for one central char cap on every tool result " +
      "(the tools keep internal line shaping below it)",
  },
  {
    key: "temperature",
    replacement:
      "per-provider / per-model temperature definitions (providers[].temperature, providers[].models[].temperature)",
    topLevelOnly: true,
  },
  {
    key: "prompt",
    replacement: "the interactive CLI's own prompt surface",
    topLevelOnly: true,
  },
  // The file key and the schema key both lived at top level (allowed keys
  // carried CONFIG_SCHEMA names AND their config-layer aliases), so both
  // tombstone; a bare "thinkerFormat" outside the map would otherwise get a
  // misleading did-you-mean.
  { key: "thinker", ...THINKER_TOMBSTONE },
  { key: "thinkerFormat", ...THINKER_TOMBSTONE },
];

/** Tombstone matching is case/separator-insensitive (camelCased, kebab, snake all hit). */
export function normalizeRemovedKey(s: string): string {
  return s.toLowerCase().replace(/[-_]/g, "");
}

/** The tombstone a top-level config-file key hits, if any. */
export function findRemovedKeyHit(key: string): RemovedKeyTombstone | undefined {
  const norm = normalizeRemovedKey(key);
  return REMOVED_KEYS.find((r) => normalizeRemovedKey(r.key) === norm);
}
