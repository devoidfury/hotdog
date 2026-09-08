// user-gate: the human approval layer for sysbox `gate` mode
// (docs/sysbox-sandbox.md "Policy defaults": deny-listed and out-of-root
// writes become promptable asks; everything else is decided by policy and
// never reaches here).
//
// Thin by design -- the mechanism lives in utils/sysbox. This extension only
// registers a SANDBOX_GATE hook handler that turns one "ask" payload into
// one question through the *existing* question-tool input seam
// (payload.input, the ToolContext "input" object threaded through by
// bash-tool's gate decider). No new prompt UI, no prompt bus.
//
// Fail-closed (invariants 2/3): no UI, non-interactive UI, a thrown or
// rejected prompt, an empty answer, or an aborted prompt all resolve to an
// explicit deny. The handler itself never throws. `payload.signal` aborts
// when the child is gone, so a prompt can never outlive its request.
//
// No remember-answers, no per-session cache: the fast path (in-root
// non-deny writes) is decided by policy before hooks run, so prompts are
// rare by construction, and approval fatigue is the named killer
// (docs/sysbox-sandbox.md "Policy defaults").

import { HOOKS, type SandboxGateAction } from "@core/hooks.ts";
import { CoreContext, ExtensionInstance, getExtensionConfig } from "@core/extensions/types.ts";
import type { HookPayloads } from "@core/extensions/types.ts";
import { logger } from "@core/logger.ts";

type GatePayload = HookPayloads["sandbox:gate"];

/** Build the human-facing prompt text for one ask. */
export function gatePromptText(p: GatePayload): string {
  const paths = p.paths.map((x) => x ?? "<unresolvable>").join(", ");
  const cmd = p.command.length > 200 ? p.command.slice(0, 200) + "…" : p.command;
  return (
    `Sandbox approval: allow "${p.kind}" by pid ${p.pid}?\n` +
    `  paths: ${paths}\n` +
    `  reason: ${p.why}\n` +
    `  command: ${cmd}`
  );
}

/** One ask -> one prompt -> allow/deny. Never throws; every non-allow is a
 * deny with a reason. */
export async function askGateUser(p: GatePayload): Promise<SandboxGateAction> {
  try {
    if (p.signal?.aborted) return { action: "deny", reason: "cancelled before prompt" };
    const input = p.input;
    if (!input || !input.isInteractive()) {
      return { action: "deny", reason: `no interactive UI to approve: ${p.why}` };
    }

    const key = `sandbox_${p.kind}_${p.pid}`;
    const question = {
      key,
      prompt: gatePromptText(p),
      options: ["allow", "deny"],
      required: true,
      default: "deny",
      allowOther: false,
    };

    const collect = Promise.resolve().then(() => input.collectAnswers([question]));
    // A prompt nobody will ever answer (child killed / tool timed out) must
    // resolve toward deny, not dangle: race the abort signal.
    let onAbort: (() => void) | null = null;
    const aborted = p.signal
      ? new Promise<"aborted">((resolve) => {
          onAbort = () => resolve("aborted");
          p.signal!.addEventListener("abort", onAbort, { once: true });
        })
      : null;

    let outcome: unknown;
    try {
      outcome = await (aborted ? Promise.race([collect, aborted]) : collect);
    } finally {
      if (p.signal && onAbort) p.signal.removeEventListener("abort", onAbort);
    }
    if (outcome === "aborted") {
      // The UI may still show the question; the decision is made without it.
      collect.catch(() => {});
      return { action: "deny", reason: "cancelled while awaiting approval" };
    }

    const answer = String((outcome as Record<string, unknown> | undefined)?.[key] ?? "")
      .trim()
      .toLowerCase();
    if (answer === "allow") return { action: "allow" };
    return { action: "deny", reason: `user denied (${p.why})` };
  } catch (e) {
    // Invariant 2: the UI failing is a deny, never a pass and never a
    // throw through the failOnError pipeline.
    const why = e instanceof Error ? e.message : String(e);
    return { action: "deny", reason: `approval UI failed, denied: ${why}` };
  }
}

/**
 * Process-wide one-at-a-time prompt queue: concurrent asks (parallel denied
 * writes, sessions sharing one terminal UI) are presented sequentially, so
 * only one question is ever live in the UI. Queued asks whose signal aborts
 * resolve to deny without consuming a prompt -- the child is gone. Bounded
 * by the supervisor's outstanding cap and each ask's signal, so it cannot
 * accumulate.
 */
let queueTail: Promise<unknown> = Promise.resolve();

function enqueuePrompt<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  queueTail = run.catch(() => {});
  return run;
}

export function create(core: CoreContext): ExtensionInstance {
  const config = getExtensionConfig<{ enabled?: boolean }>(core, "userGate");
  if (config.enabled === false) return {};

  return {
    hooks: {
      [HOOKS.SANDBOX_GATE]: async (payload) => {
        const decision = await enqueuePrompt(() => askGateUser(payload));
        if (decision.action === "deny") {
          logger.info(`[user-gate] deny: ${decision.reason ?? ""}`);
        }
        return decision;
      },
    },
  };
}
