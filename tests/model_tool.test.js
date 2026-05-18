import { describe, it, expect } from 'bun:test';
import { ModelTool } from '../src/tools/model.js';

describe('ModelTool', () => {
  it('has correct tool name', () => {
    expect(ModelTool.TOOL_NAME).toBe('model');
  });

  it('generates tool definition with available models', () => {
    const registry = {
      'model-1': { name: 'Model 1' },
      'model-2': { name: 'Model 2' },
    };
    const tool = new ModelTool(registry);
    const def = tool.toToolDef();
    expect(def.function.name).toBe('model');
    expect(def.function.parameters.properties).toHaveProperty('name');
    expect(def.function.parameters.properties.name.enum).toEqual(['model-1', 'model-2']);
  });

  it('generates tool definition with empty registry', () => {
    const tool = new ModelTool({});
    const def = tool.toToolDef();
    expect(def.function.name).toBe('model');
    expect(def.function.parameters.required).toEqual(['name']);
  });

  it('lists models when name is "list"', async () => {
    const registry = {
      'qwen3.5-0.8b': { name: 'Qwen 0.8B' },
      'qwen3.5-4b': { name: 'Qwen 4B' },
    };
    const tool = new ModelTool(registry);
    const result = await tool.execute(JSON.stringify({ name: 'list' }));
    expect(result).toContain('qwen3.5-0.8b');
    expect(result).toContain('qwen3.5-4b');
  });

  it('returns error for unknown model', async () => {
    const registry = {
      'model-1': { name: 'Model 1' },
    };
    const tool = new ModelTool(registry);
    const result = await tool.execute(JSON.stringify({ name: 'unknown-model' }));
    expect(result).toContain('Unknown model');
    expect(result).toContain('model-1');
  });

  it('returns error for empty input', async () => {
    const tool = new ModelTool({});
    const result = await tool.execute('');
    expect(result).toBe('Invalid JSON input');
  });

  it('returns error for null input', async () => {
    const tool = new ModelTool({});
    const result = await tool.execute(null);
    expect(result).toBe('Invalid JSON input');
  });

  it('returns error for invalid JSON', async () => {
    const tool = new ModelTool({});
    const result = await tool.execute('not json');
    expect(result).toBe('Invalid JSON input');
  });

  it('calls onSwitchModel callback on valid switch', async () => {
    const registry = { 'model-1': { name: 'Model 1' } };
    let switched = false;
    const ctx = {
      onSwitchModel: async (name) => { switched = true; },
    };
    const tool = new ModelTool(registry);
    const result = await tool.execute(JSON.stringify({ name: 'model-1' }), ctx);
    expect(switched).toBe(true);
    expect(result).toContain('Switched to model');
  });

  it('returns error when onSwitchModel fails', async () => {
    const registry = { 'model-1': { name: 'Model 1' } };
    const ctx = {
      onSwitchModel: async () => { throw new Error('switch failed'); },
    };
    const tool = new ModelTool(registry);
    const result = await tool.execute(JSON.stringify({ name: 'model-1' }), ctx);
    expect(result).toContain('Error switching model');
  });

  it('returns message when no switch callback', async () => {
    const registry = { 'model-1': { name: 'Model 1' } };
    const tool = new ModelTool(registry);
    const result = await tool.execute(JSON.stringify({ name: 'model-1' }));
    expect(result).toContain('Model tool requires a model switch callback');
  });

  it('returns "No models registered" for empty list', async () => {
    const tool = new ModelTool({});
    const result = await tool.execute(JSON.stringify({ name: 'list' }));
    expect(result).toBe('No models registered.');
  });

  it('generates call display', () => {
    const tool = new ModelTool({});
    const display = tool.callDisplay(JSON.stringify({ name: 'model-1' }));
    expect(display).toBe('-> model-1');
  });

  it('returns firstUseHelp', () => {
    const tool = new ModelTool({});
    expect(tool.firstUseHelp()).toContain('Switch the AI model');
  });

  it('sorts models alphabetically in definition', () => {
    const registry = {
      'zebra-model': { name: 'Zebra' },
      'alpha-model': { name: 'Alpha' },
      'beta-model': { name: 'Beta' },
    };
    const tool = new ModelTool(registry);
    const def = tool.toToolDef();
    const models = def.function.parameters.properties.name.enum;
    expect(models).toEqual(['alpha-model', 'beta-model', 'zebra-model']);
  });
});
