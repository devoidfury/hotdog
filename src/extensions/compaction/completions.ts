import type { CompletionContext, CompletionOption } from "../../core/completion.ts";

export function matcher(ctx: CompletionContext): boolean {
  const cmd = ctx.command;
  if (!cmd) return false;
  return cmd === "compact:strategy" || cmd.startsWith("compact:strategy:");
}

export function completion(ctx: CompletionContext): CompletionOption[] {
  const registry = (ctx.agent as { compactionRegistry?: { getAll: () => Array<{ name: string }> } })
    .compactionRegistry;
  if (!registry) return [];

  const strategies = registry.getAll();
  const prefix = (ctx.commandArg || "").toLowerCase();

  // First word: actions (list, set, help) or strategy names (for set)
  const parts = (ctx.commandArg || "").split(/\s+/);
  if (parts.length === 1) {
    // Completing first argument: actions + strategy names
    const actions = ["list", "set", "help"];
    const strategyNames = strategies.map((s) => s.name);
    const allOptions = [...actions, ...strategyNames];
    return allOptions
      .filter((o) => o.toLowerCase().startsWith(prefix))
      .map((o) => ({ value: o }));
  } else {
    // Completing strategy name after "set"
    return strategies
      .filter((s) => s.name.toLowerCase().startsWith(prefix))
      .map((s) => ({ value: s.name }));
  }
}
