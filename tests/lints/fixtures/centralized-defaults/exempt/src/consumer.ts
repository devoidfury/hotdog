import { DEFAULT_CONFIG_FILENAME, DEFAULT_PROFILES_SUBPATH } from "./core/config/defaults.ts";

const cfg = { localTuning: undefined as number | undefined };

export function names(): string {
  return `${DEFAULT_CONFIG_FILENAME}:${DEFAULT_PROFILES_SUBPATH}`; // exempt names
}

export function tune(): number {
  return cfg.localTuning ?? 7; // non-schema key: not centralized-defaults territory
}
