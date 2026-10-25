/**
 * Default configuration constants — sourced from core.config.json.
 *
 * This module exports static path constants, runtime fallback values, and resolveConfigDir().
 * config-dir resolution chain:
 *  CLI arg > HOTDOG_CONFIG_DIR env > /etc/hotdog > ~/.config/hotdog > bundled examples/minimal-config/config
 *
 * The CWD `config/` directory is NOT auto-discovered: a cloned repo could ship
 * config/defaults.json and silently own the session (repo-set extensionPaths load
 * code at startup). Project-local configs opt in explicitly via --config-dir or
 * HOTDOG_CONFIG_DIR; an existing ./config under an unflagged resolution warns once.
 *
 * All configurable defaults are resolved by the config layer directly from the schema.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";
import { logger } from "@utils/logger.ts";

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

const BUNDLED_EXAMPLE_SOURCE = "bundled example fallback";
let bundledFallbackWarned = false;
let cwdConfigIgnoredWarned = false;

/**
 * Use the minimal example config shipped with the package as last-resort fallback.
 * Resolved relative to this module (src/core/config/ -> repo/package root).
 * hotdog runs from source and the npm "files" list ships `src/` and `examples/` in the same relative layout,
 * so one fixed relative path should cover both both checkout and published installs.
 */
function bundledExampleConfigDir(): string | null {
  const dir = path.resolve(
    fileURLToPath(new URL("../../../examples/minimal-config/config", import.meta.url)),
  );
  return dirExists(dir) ? dir : null;
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
    // No ./config candidate: repo-local auto-discovery was removed (a cloned
    // repo's config/ would own the session, and extensionPaths from it is code
    // execution). Warn once if one sits right here, so the silence is explainable.
    const cwdConfig = path.resolve(cwd(), "config");
    if (dirExists(cwdConfig) && !cwdConfigIgnoredWarned) {
      cwdConfigIgnoredWarned = true;
      logger.warn(
        `Ignoring ${cwdConfig}: project-local config auto-discovery was removed (an untrusted repo's config/ would silently own your session). Use --config-dir config or HOTDOG_CONFIG_DIR=./config in directories you trust.`,
      );
    }
    candidates.push({ source: "/etc/hotdog", path: "/etc/hotdog", wins: dirExists("/etc/hotdog") });
    // XDG-style directory fallback. When it also does not exist, fallback to the bundled minimal-config example
    const xdgExists = dirExists(xdg);
    const bundled = xdgExists ? null : bundledExampleConfigDir();
    candidates.push({ source: "fallback ~/.config/hotdog", path: xdg, wins: xdgExists || bundled === null });
    if (bundled) candidates.push({ source: BUNDLED_EXAMPLE_SOURCE, path: bundled, wins: true });
  }

  let chosenSeen = false;
  const chain = candidates.map((c) => {
    const chosen = c.wins && !chosenSeen;
    if (chosen) chosenSeen = true;
    return { source: c.source, path: c.path, exists: dirExists(c.path), chosen };
  });

  if (chain.some((c) => c.chosen && c.source === BUNDLED_EXAMPLE_SOURCE) && !bundledFallbackWarned) {
    bundledFallbackWarned = true;
    logger.warn(
      `No config directory found (checked /etc/hotdog, ${xdg}); running on the bundled example config at ${chain.find((c) => c.chosen)!.path}. It lives inside the hotdog package/checkout; set HOTDOG_CONFIG_DIR to use a real config dir.`,
    );
  }

  return chain;
}

export function resolveConfigDir(cliConfigDir?: string | null): string {
  const chosen = resolveConfigDirChain(cliConfigDir).find((c) => c.chosen);
  // The chain always ends in a chosen candidate (XDG, or the bundled example
  // when XDG is absent; if both are absent XDG is chosen as before).
  return chosen!.path;
}
