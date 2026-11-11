/**
 * Early logger boot posture: `logLevel` and `logTarget` must be read BEFORE
 * initializeLogger, not fixed up after loadConfig -- a user who asked for
 * silence cannot get a page of stderr first. This is a deliberately dumb
 * single-file read: the same path logic loadConfig uses (the early -f/--config
 * flag wins; else the config-dir chain + defaults.json), JSONC-tolerant via
 * rescue's stripJsonc, extracting exactly the two keys. Every failure
 * (absent, unparsable, unreadable) yields an empty posture: config-load
 * diagnostics belong to the logger that starts right after this, and a broken
 * file must never become an unhandled throw before the logger exists.
 * Precedence (env > config > default) lives in resolveLogLevel/
 * resolveLogTarget; this only supplies the config layer.
 *
 * Scope, stated honestly: this reads ONE in-file layer. Profile layers cannot
 * carry these keys because their schema declares only a config layer, and no
 * extends/multi-file merge mechanism exists for defaults.json to smuggle them
 * in through a path the peek would miss.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { camelCase } from "@utils/strings.ts";
import { logger } from "@utils/logger.ts";
import { formatError } from "@core/error.ts";
import { stripJsonc } from "./rescue.ts";
import { resolveConfigDir, DEFAULT_CONFIG_FILENAME } from "./defaults.ts";

/** Raw top-level entries from the in-use config file (camelCase-normalized
 *  the way loadConfig normalizes keys, so "log-level" works too). Non-string
 *  values ride along: the resolvers fall them back to the default and
 *  logBootConfigWarnings names them. */
export interface LogBootPosture {
  logLevel?: unknown;
  logTarget?: unknown;
}

/** Best-effort read of logLevel/logTarget from the config file the loader
 *  will use for THIS argv. Never throws; on any failure the posture is
 *  empty and the env/default layers decide the logger. */
export function peekLogBootPosture(flags: {
  config: string | null;
  configDir: string | null;
}): LogBootPosture {
  const posture: LogBootPosture = {};
  try {
    const filePath = flags.config
      ? flags.config
      : path.join(resolveConfigDir(flags.configDir), DEFAULT_CONFIG_FILENAME);
    const parsed = JSON.parse(stripJsonc(readFileSync(filePath, "utf-8")).text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return posture;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const k = camelCase(key);
      if (k === "logLevel" || k === "logTarget") posture[k] = value;
    }
  } catch (e) {
    // An absent file is the normal defaults-only case. Anything else queues
    // a debug line: pre-init messages buffer and flush at init through the
    // resolved posture, so nothing prints out of turn -- and a file that is
    // truly broken gets its loud report from loadConfig/rescue, not here.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.debug(`log boot-posture peek failed: ${formatError(e)}`);
    }
  }
  return posture;
}
