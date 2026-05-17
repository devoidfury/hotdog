// Slash command dispatch for the agent.
// Handles parsing and execution of slash commands from the CLI.

/**
 * Parsed slash command (without the leading `/`).
 */
export const Command = {
  Help: 'help',
  Quit: 'quit',
  Clear: 'clear',
  ClearProfile: 'clearProfile',
  Tools: 'tools',
  Thinking: 'thinking',
  Models: 'models',
  Model: 'model',
  Tokens: 'tokens',
  Compact: 'compact',
  Prompt: 'prompt',
  Regenerate: 'regenerate',
  Skill: 'skill',
  Unknown: 'unknown',
};

/**
 * Parse a raw command string (without leading `/`) into a typed command object.
 */
export function parseCommand(cmd) {
  if (!cmd) return { type: Command.Unknown, value: null };

  switch (cmd) {
    case 'help':
      return { type: Command.Help, value: null };
    case 'quit':
    case 'exit':
      return { type: Command.Quit, value: null };
    case 'clear':
      return { type: Command.Clear, value: null };
  }

  // clear <profile>
  if (cmd.startsWith('clear ')) {
    const profileName = cmd.slice(6).trim();
    return {
      type: profileName ? Command.ClearProfile : Command.Clear,
      value: profileName || null,
    };
  }

  switch (cmd) {
    case 'tools':
      return { type: Command.Tools, value: null };
    case 'thinking':
      return { type: Command.Thinking, value: null };
    case 'models':
    case 'model':
      return { type: Command.Models, value: null };
  }

  // model <name>
  if (cmd.startsWith('model ')) {
    const modelName = cmd.slice(6).trim();
    return {
      type: modelName ? Command.Model : Command.Models,
      value: modelName || null,
    };
  }

  if (cmd === 'tokens') {
    return { type: Command.Tokens, value: null };
  }

  // compact [n] [--compact-debug]
  if (cmd.startsWith('compact')) {
    const parts = cmd.split(/\s+/);
    let keep = null;
    let debug = false;
    for (const part of parts.slice(1)) {
      if (part === '--compact-debug') {
        debug = true;
      } else if (!Number.isNaN(Number(part))) {
        keep = parseInt(part, 10);
      }
    }
    return { type: Command.Compact, value: { keep, debug } };
  }

  // prompt:<name> [args]
  if (cmd.startsWith('prompt:')) {
    const rest = cmd.slice(7);
    const spaceIdx = rest.indexOf(' ');
    const name = spaceIdx >= 0 ? rest.slice(0, spaceIdx).trim() : rest.trim();
    const args = spaceIdx >= 0 ? rest.slice(spaceIdx + 1).trim() : '';
    return { type: Command.Prompt, value: { name, args: args || undefined } };
  }

  if (cmd === 'regenerate') {
    return { type: Command.Regenerate, value: null };
  }

  // skill:<name> or skill:
  if (cmd.startsWith('skill:')) {
    const name = cmd.slice(6).trim();
    if (!name) {
      return { type: Command.Skill, value: null }; // List skills
    }
    return { type: Command.Skill, value: name };
  }

  return { type: Command.Unknown, value: cmd };
}

/**
 * Execute a parsed slash command on the agent.
 * Returns a result object: { success, message, error }.
 */
export function executeCommand(agent, command) {
  switch (command.type) {
    case Command.Clear:
      agent.context.clear();
      agent.context.systemMessages = [];
      return { success: true, message: 'Conversation cleared.' };

    case Command.ClearProfile:
      if (!command.value) {
        return { success: true, message: 'Conversation cleared.' };
      }
      // Profile switching requires config; handled inline in main.js for now
      return { success: false, error: `Profile switching requires config: ${command.value}` };

    case Command.Models:
      return {
        success: true,
        message: Object.keys(agent.modelRegistry || {}).join(', '),
      };

    case Command.Model:
      if (!command.value) {
        return { success: false, error: 'Usage: /model <model_name>' };
      }
      agent.model = command.value;
      agent.context.clear();
      agent.context.systemMessages = [];
      return { success: true, message: `Switched to model: ${command.value}` };

    case Command.Tokens:
      return { success: true, message: agent.tokenStatsDisplay?.() || 'No token stats available.' };

    case Command.Prompt:
      if (!command.value || !command.value.name) {
        return { success: false, error: 'Usage: /prompt:<name> [args]' };
      }
      const result = agent.executePrompt(command.value.name, command.value.args);
      if (result.success) {
        return { success: true, message: `Prompt '${command.value.name}' executed.` };
      }
      return { success: false, error: `Failed to execute prompt '${command.value.name}': ${result.error}` };

    case Command.Regenerate:
      const newPrompt = agent.regenerateSystemPrompt?.();
      return { success: true, message: `System prompt regenerated.\n${newPrompt}` };

    case Command.Skill:
      if (!command.value) {
        // List skills
        const allSkills = agent.allSkills?.();
        if (!allSkills || allSkills.length === 0) {
          return { success: true, message: 'No skills loaded.' };
        }
        const lines = ['Available skills:'];
        for (const s of allSkills) {
          const status = s.loaded ? '[loaded]' : s.visible ? '[visible]' : '[hidden]';
          lines.push(`  ${status} ${s.name}: ${s.description}`);
        }
        lines.push('');
        lines.push('Use /skill:<name> to activate a skill.');
        return { success: true, message: lines.join('\n') };
      }
      const skillResult = agent.activateSkill(command.value);
      if (skillResult.success) {
        return { success: true, message: `Skill '${command.value}' activated. System prompt updated.` };
      }
      return { success: false, error: skillResult.error || 'Failed to activate skill.' };

    case Command.Unknown:
      return { success: false, error: `Unknown command: ${command.value}` };

    default:
      return { success: false, error: `Command not handled by agent: ${command.type}` };
  }
}

/**
 * Check if a command is handled by the UI layer (not delegated to agent).
 */
export function isUiCommand(type) {
  return [
    Command.Help,
    Command.Quit,
    Command.Tools,
    Command.Thinking,
  ].includes(type);
}
