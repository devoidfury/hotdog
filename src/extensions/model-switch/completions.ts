import type { CompletionContext, CompletionOption } from "../../core/completion.ts";

export function matcher(ctx: CompletionContext): boolean {
  return ctx.command === "model";
}

export function completion(ctx: CompletionContext): CompletionOption[] {
  const agent = ctx.agent;
  const prefix = (ctx.commandArg || "").toLowerCase();
  const models = Object.keys(agent.modelRegistry || {});
  return models
    .filter((m) => m.toLowerCase().startsWith(prefix))
    .map((m) => ({ value: m }));
}
