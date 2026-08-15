import type { CompletionContext, CompletionOption } from "../../core/completion.ts";

export function matcher(ctx: CompletionContext): boolean {
  const cmd = ctx.command;
  if (!cmd) return false;
  return cmd === "compact" || cmd.startsWith("compact:");
}

export function completion(ctx: CompletionContext): CompletionOption[] {
  const registry = (ctx.agent as { compactionRegistry?: { getAll: () => Array<{ name: string }> } })
    .compactionRegistry;
  if (!registry) return [];

  const cmd = ctx.command || "";
  // Colon form (/compact:dr<TAB>) carries the typed prefix in the command
  // itself; space form (/compact dr<TAB>) carries it in commandArg.
  const prefix = cmd.startsWith("compact:")
    ? cmd.slice("compact:".length).toLowerCase()
    : (ctx.commandArg || "").toLowerCase();

  return registry
    .getAll()
    .filter((s) => s.name.toLowerCase().startsWith(prefix))
    .map((s) => ({ value: s.name }));
}
