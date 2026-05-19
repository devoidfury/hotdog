import { describe, it, expect } from 'bun:test';
import {
  CORE_TOOL_NAMES,
  SUBAGENT_TOOL_NAMES,
  createToolFactory,
} from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';

describe('CORE_TOOL_NAMES', () => {
  it('contains all expected core tools', () => {
    // project_info is included but disabled by default
    const expected = [
      'bash', 'write', 'model', 'load_skill',
      'read', 'question', 'pager', 'explore', 'find',
      'grep', 'fetch', 'project_info',
      'review', 'edit',
    ];
    expect(CORE_TOOL_NAMES).toEqual(expected);
  });

  it('does not include subagent tools', () => {
    expect(CORE_TOOL_NAMES).not.toContain('delegate_task');
    expect(CORE_TOOL_NAMES).not.toContain('task_status');
  });
});

describe('SUBAGENT_TOOL_NAMES', () => {
  it('contains all expected subagent tools', () => {
    const expected = [
      'delegate_task', 'task_status', 'task_followup',
      'task_interrupt', 'plan_status', 'complete_task', 'wait',
    ];
    expect(SUBAGENT_TOOL_NAMES).toEqual(expected);
  });
});

describe('createToolFactory', () => {
  it('creates bash tool', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('bash', {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe('function');
    expect(typeof tool.toToolDef).toBe('function');
  });

  it('creates write tool', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('write', {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe('function');
  });

  it('creates read tool', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('read', {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe('function');
  });

  it('creates edit tool', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('edit', {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe('function');
  });

  it('creates grep tool', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('grep', {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe('function');
  });

  it('creates find tool', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('find', {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe('function');
  });

  it('creates fetch tool', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('fetch', {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe('function');
  });

  it('creates question tool', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('question', {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe('function');
  });

  it('creates pager tool', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('pager', {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe('function');
  });

  it('creates explore tool', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('explore', {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe('function');
    expect(typeof tool.toToolDef).toBe('function');
    expect(typeof tool.callDisplay).toBe('function');
    const def = tool.toToolDef();
    expect(def.function.name).toBe('explore');
    expect(def.function.description.length).toBeGreaterThan(0);
  });

  it('creates model tool', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('model', {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe('function');
  });

  it('creates model tool with custom registry', () => {
    const factory = createToolFactory();
    const ctx = { modelRegistry: { 'gpt-4': { name: 'gpt-4' } } };
    const tool = factory.createTool('model', ctx);
    expect(tool).not.toBeNull();
  });

  it('creates load_skill tool', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('load_skill', {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe('function');
  });

  it('creates review tool', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('review', {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe('function');
  });

  it('returns null for unknown tool', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('nonexistent-tool', {});
    expect(tool).toBeNull();
  });

  it('respects whitelist', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('bash', {}, ['bash', 'write']);
    expect(tool).not.toBeNull();
    const otherTool = factory.createTool('read', {}, ['bash', 'write']);
    expect(otherTool).toBeNull();
  });

  it('handles project_info as disabled descriptor', () => {
    const factory = createToolFactory();
    // project_info is disabled by default (descriptor.disabled = true)
    const tool = factory.createTool('project_info', {});
    expect(tool).toBeNull();
  });

  it('enables disabled tools when in whitelist', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('project_info', {}, ['project_info']);
    expect(tool).not.toBeNull();
  });

  it('enables disabled tools when managerToolsEnabled', () => {
    const factory = createToolFactory();
    const tool = factory.createTool('project_info', {}, null, true);
    expect(tool).not.toBeNull();
  });

  it('creates subagent tools when managerToolsEnabled', () => {
    const mockManager = { id: 'test-manager' };
    const factory = createToolFactory(mockManager);
    expect(factory.createTool('delegate_task', {}, null, true)).not.toBeNull();
    expect(factory.createTool('task_status', {}, null, true)).not.toBeNull();
    expect(factory.createTool('task_followup', {}, null, true)).not.toBeNull();
    expect(factory.createTool('task_interrupt', {}, null, true)).not.toBeNull();
    expect(factory.createTool('plan_status', {}, null, true)).not.toBeNull();
    expect(factory.createTool('complete_task', {}, null, true)).not.toBeNull();
    expect(factory.createTool('wait', {}, null, true)).not.toBeNull();
  });

  it('does not create subagent tools without manager', () => {
    const factory = createToolFactory();
    expect(factory.createTool('delegate_task', {}, null, true)).toBeNull();
  });

  it('does not create subagent tools when not manager', () => {
    const mockManager = { id: 'test-manager' };
    const factory = createToolFactory(mockManager);
    expect(factory.createTool('delegate_task', {})).toBeNull();
  });
});

describe('createToolFactory - createAndRegister', async () => {
  it('registers tool in registry', async () => {
    const factory = createToolFactory();
    const registry = new ToolRegistry();
    await factory.createAndRegister('bash', registry, {});
    expect(registry.has('bash')).toBe(true);
  });

  it('skips tool when creation fails', async () => {
    const factory = createToolFactory();
    const registry = new ToolRegistry();
    await factory.createAndRegister('nonexistent-tool', registry, {});
    expect(registry.has('nonexistent-tool')).toBe(false);
  });

  it('respects whitelist in createAndRegister', async () => {
    const factory = createToolFactory();
    const registry = new ToolRegistry();
    await factory.createAndRegister('bash', registry, {}, ['bash']);
    expect(registry.has('bash')).toBe(true);
    expect(registry.has('write')).toBe(false);
  });

  it('skips disabled tools when not in whitelist or manager', async () => {
    const factory = createToolFactory();
    const registry = new ToolRegistry();
    await factory.createAndRegister('project_info', registry, {});
    expect(registry.has('project_info')).toBe(false);
  });
});
