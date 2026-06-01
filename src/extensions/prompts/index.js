// Prompts Extension
// Manages prompt templates loading and execution.
// Hooks: tools:register, slashCommands:register

import { HOOKS } from '../../core/hooks.js';
import { Message } from '../../core/context/message.js';
import { PromptsLoader } from './loader.js';

/**
 * Create the prompts extension.
 */
export function create(core) {
  const promptsPath = core.config?.promptsPath || './config/prompts';
  const loader = new PromptsLoader(promptsPath);
  loader.loadPrompts();

  return {
    hooks: {
      /**
       * Register slash commands for prompts.
       */
      [HOOKS.SLASH_COMMANDS_REGISTER]: async ({ registry }) => {
        registry.register('prompt', {
          description: 'Execute a prompt template (prompt:<name> [args])',
          matches: (cmd) => cmd.startsWith('prompt:'),
          handler: async (agent, cmdValue) => {
            const rest = cmdValue.slice(7);
            const spaceIdx = rest.indexOf(' ');
            const name = spaceIdx >= 0 ? rest.slice(0, spaceIdx).trim() : rest.trim();
            const args = spaceIdx >= 0 ? rest.slice(spaceIdx + 1).trim() : '';

            const prompt = loader.getPrompt(name);
            if (!prompt) {
              return { error: `Unknown prompt: ${name}` };
            }

            // Render the prompt template with args
            let content = prompt.content;
            if (args) {
              // Simple template rendering: replace {ARGS} with the args string
              content = content.replace(/\{ARGS\}/g, args);
            }

            // Add the rendered prompt as a user message
            agent._context.push(new Message({ role: 'user', content }));
            await core.hooks.emitAsync(HOOKS.CONTEXT_MESSAGE, { message: agent._context[agent._context.length - 1] });

            return { content: `Prompt '${prompt.name}' executed.` };
          },
        });
      },
    },

    // Expose for external use
    loader,

    /**
     * Get all prompts.
     */
    getAllPrompts() {
      return loader.allPrompts();
    },

    /**
     * Get a prompt by name.
     */
    getPrompt(name) {
      return loader.getPrompt(name);
    },
  };
}
