// `hotdog show-prompt` subcommand and the /show-prompt slash command. The
// subcommand builds a throwaway agent so the real system prompt + tool defs
// render without a live session; the slash command drives the live agent.
// Both share renderPrompt so the two surfaces can never drift.
import { Agent } from "@core/agent.ts";
import { CONFIG_SCHEMA, getLayerDefault, type CliArgv } from "@core/config/index.ts";
import type { CoreContext } from "@core/extensions/types.ts";

// Renders the agent's system prompt + tool defs in the show-prompt format.
// Shared by the CLI subcommand (throwaway agent) and the /show-prompt slash
// command (live agent) so the two surfaces can never drift.
export async function renderPrompt(agent: Agent): Promise<string> {
  await agent.ensureSystemPrompt();
  const lines: string[] = [agent.context.getSystemPrompt() ?? ""];

  const toolDefs = await agent.getToolDefs();
  if (toolDefs.length > 0) {
    lines.push("");
    lines.push("# Tools");
    lines.push("");
    lines.push(
      "Note: actual format of tools prompt may be different than this output depending on provider.",
    );
    lines.push("");
    for (const def of toolDefs) {
      const name = def.function?.name || "(unknown)";
      const description = def.function?.description || "";
      const params = def.function?.parameters || {};
      lines.push(`## ${name}`);
      lines.push(description);
      lines.push("");
      lines.push(JSON.stringify(params));
      lines.push("");
    }
  }
  return lines.join("\n");
}

// Builds a throwaway agent so we can render the real system prompt + tool defs.
export async function runShowPrompt(cli: CliArgv, core: CoreContext): Promise<number> {
  const { buildConfig } = core;
  const { resolved } = await buildConfig!(cli);
  const agent = new Agent({
    hooks: core.hooks,
    toolRegistry: core.toolRegistry,
    // Throwaway for prompt rendering; empty url/key so it can never send a request.
    llmClient: core.createLlmClient({ baseUrl: "", apiKey: "" }),
    model: resolved.model || "",
    // Schema-resolved keys are typed optional; the core schema always
    // supplies a default (1000), so assert like the adjacent contextLimit.
    maxIterations: resolved.maxIterations as number,
    contextLimit: resolved.contextLimit as number,
    profileName: resolved.profileName || "default",
    profileBody: resolved.profileBody,
    systemPromptTemplate: resolved.systemPromptTemplate,
    // Schema-default fallback: keep a minimal resolved bag working instead of dying on one missing key.
    config: {
      ...resolved,
      maxEmptyRetries:
        (resolved.maxEmptyRetries as number) ??
        (getLayerDefault(CONFIG_SCHEMA.maxEmptyRetries) as number),
    },
  });
  console.log(await renderPrompt(agent));
  return 0;
}
