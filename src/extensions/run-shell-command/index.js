// Run Shell Command Extension
// Provides shell command execution via /sh, !, and :! syntax.
// Hooks: slashCommands:register

import { spawn } from 'node:child_process';
import { HOOKS } from '../../core/hooks.js';

/**
 * Create the run-shell-command extension.
 *
 * @param {Object} core - The core object with hooks, extensions, etc.
 * @returns {Object} Extension instance.
 */
export function create(core) {
  return {
    hooks: {
      /**
       * Register slash commands for shell execution.
       */
      [HOOKS.SLASH_COMMANDS_REGISTER]: async ({ registry }) => {
        // /sh <command> — Run a shell command
        registry.register('sh', {
          description: 'Run a shell command (/sh <command>)',
          matches: (cmd) => cmd.startsWith('sh '),
          handler: async (agent, cmdValue) => {
            const command = cmdValue.slice(3).trim();
            if (!command) {
              return { content: 'Usage: /sh <command>' };
            }
            return await _executeShellCommand(command);
          },
        });
      },
    },

    /**
     * Execute a shell command.
     * @param {string} command - The shell command to execute.
     * @returns {Promise<{content?: string, error?: string}>}
     */
    execute(command) {
      return _executeShellCommand(command);
    },
  };
}

/**
 * Execute a shell command and return the output.
 * @param {string} command - The shell command to execute.
 * @returns {Promise<{content?: string, error?: string}>}
 */
async function _executeShellCommand(command) {
  return new Promise((resolve) => {
    const proc = spawn(command, [], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      const output = [stdout, stderr].filter(Boolean).join('\n');
      resolve({
        content: output ? `${output}\n\n[exited with code ${code}]` : `[exited with code ${code}]`,
      });
    });

    proc.on('error', (err) => {
      resolve({ error: `Error: ${err.message}` });
    });
  });
}
