/**
 * Default configuration constants — sourced from core.config.json.
 *
 * This module exports static path constants, runtime fallback values, and
 * resolveConfigDir() — the single config-dir resolution chain
 * (CLI arg > HOTDOG_CONFIG_DIR env > CWD config/ > /etc/hotdog > ~/.config/hotdog).
 * All configurable defaults are resolved by the config layer directly from the schema.
 * Components receive resolved values from callers — do not import DEFAULT_* constants.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { cwd } from "node:process";

// Path constants (static defaults for display/fallback — not schema-configurable)
export const DEFAULT_PROFILES_SUBPATH = "profiles";
export const DEFAULT_CONFIG_FILENAME = "defaults.json";
export const DEFAULT_SYSTEM_PROMPT_FILENAME = "system_prompt.md";

// Runtime fallback values (exempt from the "no DEFAULT_* in components" rule)
export const DEFAULT_SYSTEM_PROMPT_TEMPLATE: string =
  "{{ body }}\n{% for chunk in chunks %}{{ chunk.content }}{% endfor %}";

export interface ConfigDirCandidate {
  /** Why this candidate exists in the chain (flag name, env var, path). */
  source: string;
  path: string;
  exists: boolean;
  chosen: boolean;
}

function dirExists(dir: string): boolean {
  try {
    fs.accessSync(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * The full config-dir resolution chain, in priority order, each candidate
 * annotated with whether it exists and which one wins. resolveConfigDir()
 * returns the chosen path; the trace exists for `hotdog rescue` diagnostics.
 */
export function resolveConfigDirChain(cliConfigDir?: string | null): ConfigDirCandidate[] {
  const xdg = path.join(os.homedir(), ".config", "hotdog");
  const candidates: Array<{ source: string; path: string; wins: boolean }> = [];

  if (cliConfigDir) {
    // An explicit flag wins even when the directory does not exist; loadConfig
    // then fails loudly instead of silently falling through to another source.
    candidates.push({ source: "--config-dir flag", path: path.resolve(cliConfigDir), wins: true });
  } else if (process.env.HOTDOG_CONFIG_DIR) {
    candidates.push({
      source: "HOTDOG_CONFIG_DIR env",
      path: path.resolve(process.env.HOTDOG_CONFIG_DIR),
      wins: true,
    });
  } else {
    candidates.push({ source: "./config", path: path.resolve(cwd(), "config"), wins: dirExists(path.resolve(cwd(), "config")) });
    candidates.push({ source: "/etc/hotdog", path: "/etc/hotdog", wins: dirExists("/etc/hotdog") });
    // XDG-style directory fallback
    candidates.push({ source: "fallback ~/.config/hotdog", path: xdg, wins: true });
  }

  let chosenSeen = false;
  return candidates.map((c) => {
    const chosen = c.wins && !chosenSeen;
    if (chosen) chosenSeen = true;
    return { source: c.source, path: c.path, exists: dirExists(c.path), chosen };
  });
}

export function resolveConfigDir(cliConfigDir?: string | null): string {
  const chosen = resolveConfigDirChain(cliConfigDir).find((c) => c.chosen);
  // The chain always ends in a chosen candidate (the fallback wins unconditionally).
  return chosen!.path;
}
