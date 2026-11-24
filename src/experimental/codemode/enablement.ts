// Effective enablement, per agent. The chain is:
//
//   profile `codeMode` bool  >  config `codeMode.enabled` (default true)
//
// A profile's boolean wins in BOTH directions: `codeMode: false` opts one
// profile out of an on-by-default session, `codeMode: true` opts one profile
// back into a session that flipped the global default off. Non-boolean
// profile values are ignored (a typo'd `codeMode: "yes"` must not silently
// read as false). The experimental tier stays the outer gate: nothing here
// runs unless `@experimental` loaded the extension.
//
// Read per use (hook fire), so a profile switch and a live config edit land
// on the next request. The profile comes from the AGENT's own profileName
// (worker agents carry their worker profile, never the session's); without a
// reachable profileManager (test hosts) the global config decides.

import { getExtensionConfig } from "@core/extensions/types.ts";
import type { CoreContext } from "@core/extensions/types.ts";

/** The config key this extension's configSchema registers. */
export const CODEMODE_CONFIG_KEY = "codeMode";

/** Resolve whether codemode is on for ONE agent: its profile's boolean
 *  override if present, else the global `codeMode.enabled` default (true). */
export function codeModeEnabledFor(core: CoreContext, agent: unknown): boolean {
  const profileName = (agent as { profileName?: string } | undefined)?.profileName;
  const profile = profileName
    ? core.resolved?.profileManager?.getProfile(profileName)
    : null;
  const flag = (profile as { codeMode?: unknown } | null | undefined)?.codeMode;
  if (typeof flag === "boolean") return flag;
  return (
    getExtensionConfig<{ enabled?: boolean }>(core, CODEMODE_CONFIG_KEY).enabled !==
    false
  );
}
