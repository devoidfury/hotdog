// The full-tilt shadow layer: one PROVIDER_REQUEST handler per request,
// either the enablement gate (off: subtract the codemode surface) or the
// shadow filter (on: subtract everything else off the wire).
//
// Trigger is def-presence: the shadow fires iff the incoming def array
// itself carries codemode. core.hooks is shared by every agent the factory
// builds (subagents, pooled task workers), so gating is per agent from the
// payload: enablement.ts resolves the profile `codeMode` bool over the
// global `codeMode.enabled` default, and an off agent loses the whole
// codemode surface (codemode, head, tail) while the shadow stays silent --
// the model never loses a tool in a request that does not offer the
// alternative.
//
// PURE SUBTRACTION: out = defs.filter(...), so out ⊆ in by construction.
// The hook runs after the agent.getToolDefs() policy chain (registry ->
// filterByMetadata -> whitelist -> blacklist -> SHADOW -> wire) and core
// never subset-checks a returned toolDefs, so subtract-only is the
// extension discipline that keeps shadow from re-adding anything
// sandboxMode / maxToolDifficulty / whitelist / blacklist removed; the
// subset-property tests pin it on sandboxed/difficulty-capped/blacklist
// profiles.
//
// Scope: everything not on the keep-direct table (human channel,
// turn-contract tools, the manager class, the skills preamble partner,
// session config, the file-mutation ops edit/overwrite/append),
// not registry-pinned, and not codemode itself is shadowed
// while codemode is enabled for the agent: `read`, bash,
// grep/find/explore/project_info, fetch, web_search, agent_browser,
// string_length, show_me, head/tail, and other extensions' / MCP servers'
// tools wholesale.
//
// One filter shadows BOTH surfaces: dispatch availability inherits the
// request's adopted names, so a shadowed model call bounces as
// "not available" with candidates drawn only from the offered set, while
// script-initiated dispatch (the nested entry) re-derives the
// pre-shadow policy-filtered view -- a shadowed tool stays fully callable
// inside a script; a policy-filtered name is unreachable from both.

import type { ToolDef } from "@core/extensions/tool-registry.ts";
import type { CoreContext, ProviderRequestPayload } from "@core/extensions/types.ts";
import { KEEP_DIRECT_TOOL_NAMES } from "./catalog.ts";
import { CODEMODE_TOOL_NAME } from "./tool.ts";
import { HEAD_TOOL_NAME, TAIL_TOOL_NAME } from "./files-tools.ts";
import { codeModeEnabledFor } from "./enablement.ts";

const KEEP_DIRECT = new Set<string>(KEEP_DIRECT_TOOL_NAMES);

/** What the gate drops for an agent codemode is off for: the tool itself
 *  plus its two bounded readers (head/tail exist to serve scripts; with no
 *  shadow the model would otherwise see them for free). */
const CODEMODE_SURFACE = new Set<string>([
  CODEMODE_TOOL_NAME,
  HEAD_TOOL_NAME,
  TAIL_TOOL_NAME,
]);

/**
 * The only reasons a def survives the filter: the keep-direct table,
 * codemode itself, or the registry `pinned` flag (payload defs carry no
 * metadata, so the exemption consults getMetadata). The pinned exemption
 * covers the hook leg ONLY -- a pinned def already dropped upstream by
 * filterByMetadata (difficulty / sandboxMode / managerOnly) never reaches
 * this handler to be exempted, and stays unreachable from both surfaces.
 */
export function isShadowExempt(core: CoreContext, name: string): boolean {
  return (
    name === CODEMODE_TOOL_NAME ||
    KEEP_DIRECT.has(name) ||
    core.toolRegistry.getMetadata(name)?.pinned === true
  );
}

export function createShadowHandler(core: CoreContext) {
  return (payload: ProviderRequestPayload): { toolDefs: ToolDef[] } | undefined => {
    const defs = payload?.toolDefs;
    if (!Array.isArray(defs)) return undefined;
    if (!codeModeEnabledFor(core, payload?.agent)) {
      // Off for this agent: subtract the codemode surface, shadow stays
      // silent -- everything else rides the wire untouched.
      const kept = defs.filter(
        (def) => !def?.function?.name || !CODEMODE_SURFACE.has(def.function.name),
      );
      return kept.length === defs.length ? undefined : { toolDefs: kept };
    }
    if (!defs.some((def) => def?.function?.name === CODEMODE_TOOL_NAME)) {
      return undefined; // trigger: the request must offer codemode first
    }
    const kept = defs.filter(
      // A nameless def cannot match the table; leave it for the wire layer.
      (def) => !def?.function?.name || isShadowExempt(core, def.function.name),
    );
    return kept.length === defs.length ? undefined : { toolDefs: kept };
  };
}
