// Prompts Extension
// Manages prompt templates loading and execution.
// Hooks: command:dispatch

import { HOOKS } from '../../src/core/hooks.js';
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
       * Handle prompt execution commands.
       */
      [HOOKS.COMMAND_DISPATCH]: async ({ command, agent }) => {
        if (command.type !== 'prompt') return;

        const prompt = loader.getPrompt(command.value.name);
        if (!prompt) {
          return { error: `Unknown prompt: ${command.value.name}` };
        }

        // Render the prompt template with args
        let content = prompt.content;
        if (command.value.args) {
          // Simple template rendering: replace {ARGS} with the args string
          content = content.replace(/\{ARGS\}/g, command.value.args);
        }

        // Add the rendered prompt as a user message
        const { Message } = await import('../../src/context/message.js');
        agent._context.push(new Message({ role: 'user', content }));
        await core.hooks.emitAsync(HOOKS.CONTEXT_MESSAGE, { message: agent._context[agent._context.length - 1] });

        return { content: `Prompt '${prompt.name}' executed.` };
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
