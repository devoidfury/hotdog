// Prompts Extension
// Manages prompt templates loading and execution.
// Hooks: tools:register, commands:register

import extensionData from './extension.json';
import { HOOKS } from '../../core/hooks.js';
import { Message } from '../../core/context/message.js';
import { PromptsLoader } from './loader.js';
import { render } from '../../utils/render.js';

/**
 * Create the prompts extension.
 */
export async function create(core) {
  // Config defaults come from extension.json configSchema
  const config = core.config?.prompts || {};
  const promptsPath = config.promptsPath ?? extensionData.configSchema.properties.promptsPath.default;
  const loader = new PromptsLoader(promptsPath);
  await loader.loadPrompts();

  return {
    hooks: {
      /**
       * Register commands for prompts.
       */
      [HOOKS.COMMANDS_REGISTER]: async ({ registry }) => {
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

            // Render the prompt template with args using the render engine
            const content = render(prompt.content, { ARGS: args || '' });

            // Add the rendered prompt as a user message
            agent.addMessage(new Message({ role: 'user', content }));

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
