import type { CompletionContext, CompletionOption } from "../../core/completion.ts";

export function matcher(ctx: CompletionContext): boolean {
  const cmd = ctx.command;
  if (!cmd) return false;
  return cmd === "skill" || cmd.startsWith("skill:");
}

export function completion(ctx: CompletionContext): CompletionOption[] {
  const skills = (ctx.agent as { skillsLoader?: { allSkills: () => Array<{ name: string }> } })
    .skillsLoader?.allSkills() ?? [];
  const prefix = (ctx.commandArg || "").toLowerCase();
  return skills
    .filter((s) => s.name.toLowerCase().startsWith(prefix))
    .map((s) => ({ value: s.name }));
}
