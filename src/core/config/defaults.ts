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
  "{{ role }}\n\n{{ body }}\n{% for chunk in chunks %}{{ chunk.content }}{% endfor %}";

export function resolveConfigDir(cliConfigDir?: string | null): string {
  if (cliConfigDir) {
    return path.resolve(cliConfigDir);
  }

  const envConfigDir = process.env.HOTDOG_CONFIG_DIR;
  if (envConfigDir) {
    return path.resolve(envConfigDir);
  }

  const cwdConfig = path.resolve(cwd(), "config");
  try {
    fs.accessSync(cwdConfig);
    return cwdConfig;
  } catch {
    // Not a directory or doesn't exist
  }

  const etcConfig = "/etc/hotdog";
  try {
    fs.accessSync(etcConfig);
    return etcConfig;
  } catch {
    // Not found
  }

  // XDG-style directory fallback
  return path.join(os.homedir(), ".config", "hotdog");
}
