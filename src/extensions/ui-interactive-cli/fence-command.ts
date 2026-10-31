// The /fence command: per-session runtime exec-fence policy toggle. The
// decide+apply pair lives here (not inline in handleSlashCommand) so the
// inline-plane refusal and the transcript notice are testable without a live
// readline channel; the command's UI shape (print, re-prompt) stays with the
// handler.
//
// Semantics that MUST survive edits: the toggle applies to the CALLING
// session only -- other sessions and future subagent sessions keep following
// the boot config. Switching to "off" never happens silently: the toggled
// session's log gets a harness system-notice stating that its tool code runs
// UNFENCED from the next spawn (the log is the audit trail of posture
// changes), and switching back to "on" logs its own notice. The toggle is
// runtime-only: nothing is written to config, a restart returns every session
// to the boot posture.

import {
  getExecFencePolicy,
  setExecFencePolicy,
  sharedExecFenceDisplay,
  sharedToolExecDegraded,
  toolExecModeLabel,
  toolExecPlaneSettings,
} from "@core/tool-exec-broker.ts";
import { ConfigError, formatError } from "@core/error.ts";
import { Message } from "@core/context/message.ts";
import type { AgentLike } from "@core/session/index.ts";

export const FENCE_USAGE =
  "Usage: /fence on | off | status  (this session only; on = jail when the platform can, " +
  "off = plain spawn; runtime-only, never written to config -- other sessions follow the boot config)";

/**
 * The transcript notice for OFF. The unfenced warning is the point of the
 * record: a session log read later must show exactly when the jail came
 * down. Wording is contract -- tests pin the warning phrase.
 */
export const FENCE_OFF_NOTICE =
  '/fence off: the operator switched the runtime exec-fence policy to "off" for THIS session. ' +
  "Tool code will run UNFENCED from the next spawn -- workspace roots and deny " +
  "patterns are no longer OS-enforced for tagged tools. Entries already running " +
  "keep the fence they were born with until their next invoke replaces them. " +
  "Other sessions follow the boot config. Runtime-only: a restart returns to it.";

/** The transcript notice for ON (back to jail-when-available, this session). */
export const FENCE_ON_NOTICE =
  '/fence on: the operator switched the runtime exec-fence policy to "probe" for THIS session. ' +
  "Pooled executors are fenced again (jail when the platform supports it) from " +
  "the next spawn; entries already running keep the fence they were born with " +
  "until their next invoke replaces them. Runtime-only: a restart returns to " +
  "the boot config.";

export interface FenceCommandResult {
  /** Terminal output; the handler prints it through the UI channel. */
  output: string;
  /** The policy just applied, or null for status/refusal/usage/error. */
  applied: "off" | "probe" | null;
}

/** The posture lines both status and the toggle replies print, for ONE session. */
function postureLines(resolved: Record<string, unknown>, session: string): string {
  const { fence } = toolExecPlaneSettings(resolved);
  const override = getExecFencePolicy(session);
  const label = toolExecModeLabel(
    resolved,
    sharedToolExecDegraded(),
    sharedExecFenceDisplay(session, resolved),
  );
  const lines = [`Fence posture (this session): ${label}`];
  if (override !== null) {
    lines.push(
      `This session runs a runtime override (policy "${override}"); boot config said "${fence}". ` +
        "Overrides are session-scoped: other sessions follow the boot config, and a restart " +
        "returns every session to it.",
    );
  } else {
    lines.push(
      `No runtime override for this session; its live policy comes from the boot config ("${fence}").`,
    );
  }
  return lines.join("\n");
}

/**
 * The command body: parse the argument, refuse on an inline plane (no pool
 * exists to fence), otherwise apply the override to the CALLING session via
 * setExecFencePolicy and log the change to that session's transcript as a
 * harness system-notice. A missing or unresolved plane posture refuses too --
 * a security posture never picks a mode silently.
 */
export function fenceCommand(
  value: string | null | undefined,
  resolved: Record<string, unknown> | null,
  agent: AgentLike | null,
  session: string,
): FenceCommandResult {
  const arg = (value || "").trim().toLowerCase();
  if (arg !== "on" && arg !== "off" && arg !== "status") {
    return { output: FENCE_USAGE, applied: null };
  }

  let mode: "worker" | "inline";
  try {
    if (!resolved) throw new ConfigError("no resolved config (this host never ran config resolution)");
    ({ mode } = toolExecPlaneSettings(resolved));
  } catch (e) {
    return { output: `Fence: ${formatError(e)}; refusing.`, applied: null };
  }

  if (arg === "status") {
    return { output: postureLines(resolved!, session), applied: null };
  }

  if (mode === "inline") {
    return {
      output:
        `/fence ${arg} refused: toolExec is "inline" -- tool code runs inside this process, ` +
        "there is no pooled executor to fence or unfence. Nothing changed.",
      applied: null,
    };
  }

  const policy = arg === "on" ? "probe" : "off";
  setExecFencePolicy(session, policy);
  // The transcript record BEFORE the terminal line: if printing somehow
  // died, the audit trail still has the change. The notice rides THIS
  // session's agent, so it lands in the toggled session's log only.
  if (agent) {
    agent.addMessage(
      new Message({
        role: "harness",
        source: "harness",
        content: [{ type: "system-notice", text: policy === "off" ? FENCE_OFF_NOTICE : FENCE_ON_NOTICE }],
      }),
    );
  }
  const label = toolExecModeLabel(
    resolved!,
    sharedToolExecDegraded(),
    sharedExecFenceDisplay(session, resolved!),
  );
  const lead =
    policy === "off"
      ? "Exec fence OFF for this session: tool code runs UNFENCED from the next spawn (in-flight entries keep the fence they were born with)."
      : "Exec fence ON for this session: pooled executors jail when the platform can, from the next spawn.";
  const trail = agent
    ? " The change was logged to this session's transcript."
    : " (No active agent: the change was NOT logged this time.)";
  return {
    output:
      `${lead} Posture: ${label}.\n` +
      `Boot config: execFence "${toolExecPlaneSettings(resolved!).fence}". ` +
      "This session runs a runtime override; other sessions and future subagent sessions follow the boot config. " +
      `Runtime-only: a restart reverts.${trail}`,
    applied: policy,
  };
}
