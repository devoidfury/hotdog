// codemode (experimental): one model-authored JavaScript program replaces a
// sequence of model<->tool round trips; its `tools.<name>()` calls ride the
// ordinary host pipeline (gate, logs, caps).
//
// The experimental tier is the outer opt-in (AGENTS.md): loaded only when the
// user adds `@experimental` to extensionPaths. Once loaded, enablement is a
// chain (enablement.ts): the profile's `codeMode` bool beats the global
// `codeMode.enabled` config default (true), per agent. Registration is
// unconditional -- the PROVIDER_REQUEST filter and this prompt chunk resolve
// enablement at each fire, so a profile switch lands on the next request.
//
// What lands here: the `codemode` tool (tool.ts) and the head/tail readers
// (files-tools.ts), the fenced host bridge tool.execute() hands off to
// (bridge.ts, one instance per loaded extension == per process), the
// PROVIDER_REQUEST gate + shadow handler (shadow.ts), and this system-prompt
// chunk.

import { HOOKS } from "@core/hooks.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import type { ToolDef } from "@core/extensions/tool-registry.ts";
import type { CoreContext, ExtensionInstance } from "@core/extensions/types.ts";
import { shadowedNames } from "./catalog.ts";
import { codeModeEnabledFor } from "./enablement.ts";
import { createHeadTool, createTailTool, HEAD_TOOL_NAME, TAIL_TOOL_NAME } from "./files-tools.ts";
import { createShadowHandler } from "./shadow.ts";
import { CODEMODE_TOOL_NAME, CodeModeTool } from "./tool.ts";

// Mid priority: after delegation (250), before project-context (300).
const CHUNK_PRIORITY = 260;

function buildChunk(shadowed: string[] | null): string {
  const lines = [
    "## codemode",
    "Run a JavaScript program that calls tools -- one `codemode` call replaces a sequence of model<->tool round trips.",
    "- Batch independent tool calls in one script with `Promise.all` instead of one round trip each.",
    "- Chain dependent calls and filter large output inside the script; `return` only what you need.",
    "- Prefer `codemode` for any multi-call or looping sequence (retries, fan-out, arithmetic over results).",
    "",
  ];
  if (shadowed && shadowed.length > 0) {
    lines.push(
      `Shadow posture: codemode shadows the other tools. Shadowed now: ${shadowed.join(", ")}.`,
      "A shadowed tool is not declared to you as a direct call; it stays fully callable inside `codemode` as `tools.<name>({...})`, with the same gate, logs and caps as any call. If a direct call bounces as \"not available\", do not retry it directly: script it.",
    );
  } else {
    lines.push(
      "Shadow posture: codemode shadows the other tools -- anything not declared to you stays fully callable inside `codemode` as `tools.<name>({...})`; the codemode tool description's domain index (and `searchTools` / `describeTool` inside a script) shows the surface.",
    );
  }
  return lines.join("\n");
}

export function create(core: CoreContext): ExtensionInstance {
  return {
    hooks: {
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        registry.register(CODEMODE_TOOL_NAME, new CodeModeTool(core));
        // The two bounded line readers. They are not on the keep-direct
        // table, so shadow drops them from the wire: model-invisible while
        // the shadow is on, fully callable from scripts and any dispatcher.
        registry.register(HEAD_TOOL_NAME, createHeadTool());
        registry.register(TAIL_TOOL_NAME, createTailTool());
      },

      /**
       * The full-tilt shadow filter: a pure subtraction over the request's
       * defs, firing iff the defs themselves carry codemode.
       */
      [HOOKS.PROVIDER_REQUEST]: createShadowHandler(core),

      /**
       * codemode usage guidance plus the shadow recovery path: the bounce
       * for a shadowed direct call is the generic not-available error, so the
       * chunk names the exact shadowed inventory and the substitution rule.
       * The inventory comes from the agent's POLICY-FILTERED defs, never the
       * raw registry; keep-direct, pinned, and codemode itself are exempt.
       * The inventory stands only when the agent's own defs carry codemode,
       * the same trigger shadow.ts applies to the wire: an agent whose
       * profile filtered codemode out is never shadowed, so it gets no
       * inventory claim. With no agent handle (test hosts) the rule stands
       * on its own without an inventory. No chunk at all for an agent
       * codemode is disabled for (profile `codeMode` / `codeMode.enabled`).
       */
      [HOOKS.SYSTEM_PROMPT_BUILD]: async ({ agent }) => {
        if (!codeModeEnabledFor(core, agent)) return undefined;
        let shadowed: string[] | null = null;
        const getDefs = (
          agent as { getToolDefs?: () => Promise<ToolDef[]> } | undefined
        )?.getToolDefs;
        if (typeof getDefs === "function") {
          try {
            const defs = await getDefs.call(agent as object);
            const names = (Array.isArray(defs) ? defs : []).map((def) => def?.function?.name ?? "");
            if (names.includes(CODEMODE_TOOL_NAME)) {
              shadowed = shadowedNames(names, {
                isPinned: (name) =>
                  core.toolRegistry.getMetadata(name)?.pinned === true,
                selfName: CODEMODE_TOOL_NAME,
              });
            }
          } catch (e: unknown) {
            logger.warn(`[codemode] shadow inventory skipped: ${formatError(e)}`);
          }
        }
        return { name: "codemode", priority: CHUNK_PRIORITY, content: buildChunk(shadowed) };
      },
    },
  };
}
