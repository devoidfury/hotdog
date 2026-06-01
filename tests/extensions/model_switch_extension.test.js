import { describe, it, expect } from 'bun:test';
import { create as createModelSwitchExtension } from '../../extensions/model-switch/index.js';
import { HookSystem, HOOKS } from '../../src/hooks.js';
import { ToolRegistry } from '../../src/core/tool-registry.js';
import { createSlashCommandRegistry } from '../../src/core/slash-command-registry.js';

function createMockCore(config = {}) {
  return {
    hooks: new HookSystem(),
    config: config.coreConfig || {},
    resolved: {
      modelRegistry: config.modelRegistry || {
        'model-a': { name: 'Model A' },
        'model-b': { name: 'Model B' },
      },
    },
    toolRegistry: new ToolRegistry(),
  };
}

function createMockAgent(modelRegistry = {}) {
  return {
    _modelRegistry: modelRegistry,
    model: 'model-a',
    context: [],
    clearContext: function () {
      this.context = [];
    },
  };
}

describe('Model-switch extension', () => {
  it('registers model tool by default', async () => {
    const core = createMockCore();
    const ext = createModelSwitchExtension(core);
    expect(ext).not.toBeNull();

    await ext.hooks[HOOKS.TOOLS_REGISTER](core.toolRegistry);
    expect(core.toolRegistry.has('model')).toBe(true);
  });

  it('does not register model tool when toolEnabled is false', async () => {
    const core = createMockCore({ coreConfig: { modelSwitch: { toolEnabled: false } } });
    const ext = createModelSwitchExtension(core);

    await ext.hooks[HOOKS.TOOLS_REGISTER](core.toolRegistry);
    expect(core.toolRegistry.has('model')).toBe(false);
  });

  it('registers slash commands by default', async () => {
    const core = createMockCore();
    const ext = createModelSwitchExtension(core);

    const registry = createSlashCommandRegistry();
    await ext.hooks[HOOKS.SLASH_COMMANDS_REGISTER]({ registry });

    expect(registry.has('model')).toBe(true);
    expect(registry.has('models')).toBe(true);
  });

  it('does not register slash commands when commandEnabled is false', async () => {
    const core = createMockCore({ coreConfig: { modelSwitch: { commandEnabled: false } } });
    const ext = createModelSwitchExtension(core);

    const registry = createSlashCommandRegistry();
    await ext.hooks[HOOKS.SLASH_COMMANDS_REGISTER]({ registry });

    expect(registry.has('model')).toBe(false);
    expect(registry.has('models')).toBe(false);
  });

  it('can enable tool but disable command', async () => {
    const core = createMockCore({
      coreConfig: { modelSwitch: { toolEnabled: true, commandEnabled: false } },
    });
    const ext = createModelSwitchExtension(core);

    // Tool should be registered
    await ext.hooks[HOOKS.TOOLS_REGISTER](core.toolRegistry);
    expect(core.toolRegistry.has('model')).toBe(true);

    // Commands should not be registered
    const registry = createSlashCommandRegistry();
    await ext.hooks[HOOKS.SLASH_COMMANDS_REGISTER]({ registry });
    expect(registry.has('model')).toBe(false);
    expect(registry.has('models')).toBe(false);
  });

  it('can disable tool but enable command', async () => {
    const core = createMockCore({
      coreConfig: { modelSwitch: { toolEnabled: false, commandEnabled: true } },
    });
    const ext = createModelSwitchExtension(core);

    // Tool should not be registered
    await ext.hooks[HOOKS.TOOLS_REGISTER](core.toolRegistry);
    expect(core.toolRegistry.has('model')).toBe(false);

    // Commands should be registered
    const registry = createSlashCommandRegistry();
    await ext.hooks[HOOKS.SLASH_COMMANDS_REGISTER]({ registry });
    expect(registry.has('model')).toBe(true);
    expect(registry.has('models')).toBe(true);
  });

  it('/models command lists available models', async () => {
    const core = createMockCore();
    const ext = createModelSwitchExtension(core);

    const registry = createSlashCommandRegistry();
    await ext.hooks[HOOKS.SLASH_COMMANDS_REGISTER]({ registry });

    const def = registry.get('models');
    const agent = createMockAgent(core.resolved.modelRegistry);
    const result = await def.handler(agent);

    expect(result.content).toContain('Available models:');
    expect(result.content).toContain('model-a');
    expect(result.content).toContain('model-b');
    expect(result.content).toContain('Currently using: model-a');
  });

  it('/models command shows message when no models configured', async () => {
    const core = createMockCore({ modelRegistry: {} });
    const ext = createModelSwitchExtension(core);

    const registry = createSlashCommandRegistry();
    await ext.hooks[HOOKS.SLASH_COMMANDS_REGISTER]({ registry });

    const def = registry.get('models');
    const agent = createMockAgent({});
    const result = await def.handler(agent);

    expect(result.content).toContain('No models configured');
  });

  it('/model command switches model', async () => {
    const core = createMockCore();
    const ext = createModelSwitchExtension(core);

    const registry = createSlashCommandRegistry();
    await ext.hooks[HOOKS.SLASH_COMMANDS_REGISTER]({ registry });

    const def = registry.get('model');
    const agent = createMockAgent(core.resolved.modelRegistry);
    const result = await def.handler(agent, 'model model-b');

    expect(result.content).toContain('Switched to model: model-b');
    expect(agent.model).toBe('model-b');
  });

  it('/model command without name shows available models', async () => {
    const core = createMockCore();
    const ext = createModelSwitchExtension(core);

    const registry = createSlashCommandRegistry();
    await ext.hooks[HOOKS.SLASH_COMMANDS_REGISTER]({ registry });

    const def = registry.get('model');
    const agent = createMockAgent(core.resolved.modelRegistry);
    const result = await def.handler(agent, 'model');

    expect(result.content).toContain('Available models:');
    expect(result.content).toContain('model-a');
    expect(result.content).toContain('model-b');
  });

  it('registers config params', () => {
    const core = createMockCore();
    const ext = createModelSwitchExtension(core);

    const params = ext.hooks[HOOKS.CONFIG_PARAMS_REGISTER]();
    expect(params).toHaveLength(1);
    expect(params[0].key).toBe('modelSwitch');
    expect(params[0].defaults.toolEnabled).toBe(true);
    expect(params[0].defaults.commandEnabled).toBe(true);
  });
});
