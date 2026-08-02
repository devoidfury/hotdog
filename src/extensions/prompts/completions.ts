import type { CompletionContext, CompletionOption } from "../../core/completion.ts";

export function matcher(ctx: CompletionContext): boolean {
  const cmd = ctx.command;
  if (!cmd) return false;
  return cmd === "prompt" || cmd.startsWith("prompt:");
}

export function completion(ctx: CompletionContext): CompletionOption[] {
  const allPrompts = (ctx.agent as { promptsLoader?: { allPrompts: () => Array<{ name: string }> } })
    .promptsLoader?.allPrompts() ?? [];
  const promptNames = allPrompts.map((p) => p.name);

  // Extract the prompt name prefix
  let prefix = "";
  if (ctx.command === "prompt") {
    prefix = (ctx.commandArg || "").toLowerCase();
  } else if (ctx.command && ctx.command.startsWith("prompt:")) {
    // "/prompt:name" -> extract "name"
    prefix = ctx.command.slice(7).toLowerCase();
  }

  return promptNames
    .filter((name) => name.toLowerCase().startsWith(prefix))
    .map((name) => ({ value: name }));
}
