import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import { BashTool, create } from '../../src/extensions/bash-tool/index.ts';
import { AssistantRetryableError } from '../../src/core/error.ts';
import { resultStr, tmpDir, cleanupDir } from '../helpers.ts';
import { HOOKS } from '../../src/core/hooks.ts';

/** True if a process with this pid still exists (signal 0 = existence check). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM means it exists but isn't ours — count as alive
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('BashTool', () => {
  it('has correct tool name', () => {
    expect(BashTool.TOOL_NAME).toBe('bash');
  });

  it('generates tool definition', () => {
    const tool = new BashTool({ timeoutMs: 30000, maxOutputLines: 100 });
    const def = tool.toToolDef();
    expect(def.function.name).toBe('bash');
    expect(def.function.parameters.required).toEqual(['command']);
  });

  it('returns error for missing command', async () => {
    const tool = new BashTool({ timeoutMs: 30000, maxOutputLines: 100 });
    const result = await tool.execute(JSON.stringify({}), {} as any);
    expect(resultStr(result)).toContain('Error: command is required');
  });

  it('returns error for empty command', async () => {
    const tool = new BashTool({ timeoutMs: 30000, maxOutputLines: 100 });
    const result = await tool.execute(JSON.stringify({ command: '' }), {} as any);
    expect(resultStr(result)).toContain('Error: command is required');
  });

  it('executes echo command', async () => {
    const tool = new BashTool({ timeoutMs: 30000, maxOutputLines: 100 });
    const result = await tool.execute(JSON.stringify({ command: 'echo hello' }), {} as any);
    expect(resultStr(result)).toContain('hello');
  });

  it('throws AssistantRetryableError on timeout', async () => {
    const tool = new BashTool({ timeoutMs: 100, maxOutputLines: 100 });
    await expect(
      tool.execute(JSON.stringify({ command: 'sleep 5', timeout_ms: 100 }), {} as any)
    ).rejects.toThrow(/timed out/);
  });

  it('kills a process that ignores SIGTERM after the grace period', async () => {
    const dir = tmpDir('hotdog-bash-kill-');
    const pidFile = `${dir}/pid`;
    try {
      const tool = new BashTool({ timeoutMs: 300, maxOutputLines: 100 });
      // This shell ignores TERM, so it survives the initial SIGTERM at
      // 300ms -- only the SIGKILL escalation at ~2300ms can end it.
      const cmd = `sh -c 'echo $ > ${pidFile}; trap "" TERM; sleep 300'`;
      await expect(tool.execute(JSON.stringify({ command: cmd }), {} as any))
        .rejects.toThrow(/timed out/);

      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      await new Promise((r) => setTimeout(r, 3500));
      expect(processAlive(pid)).toBe(false);
    } finally {
      cleanupDir(dir);
    }
  }, 15000);

  it('kills grandchild processes on timeout (process group)', async () => {
    const dir = tmpDir('hotdog-bash-group-');
    const pidFile = `${dir}/pid`;
    try {
      const tool = new BashTool({ timeoutMs: 300, maxOutputLines: 100 });
      // Grandchild sleep outlives its parent shell by default; the group
      // kill must take it down too.
      const cmd = `sh -c 'sleep 300 & echo $! > ${pidFile}; wait'`;
      await expect(tool.execute(JSON.stringify({ command: cmd }), {} as any))
        .rejects.toThrow(/timed out/);

      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      await new Promise((r) => setTimeout(r, 3500));
      expect(processAlive(pid)).toBe(false);
    } finally {
      cleanupDir(dir);
    }
  }, 15000);

  it('uses default timeout when not specified', async () => {
    // Default timeout is 30000ms (30s), so a short sleep should complete
    const tool = new BashTool({ timeoutMs: 30000, maxOutputLines: 100 });
    const result = await tool.execute(JSON.stringify({ command: 'echo test' }), {} as any);
    expect(resultStr(result)).toContain('test');
  });

  it('handles non-existent command', async () => {
    const tool = new BashTool({ timeoutMs: 30000, maxOutputLines: 100 });
    const result = await tool.execute(JSON.stringify({ command: 'nonexistent_command_xyz_123' }), {} as any);
    // Should return an error message from the shell
    expect(resultStr(result)).toContain('not found');
  });

  it('handles object input', async () => {
    const tool = new BashTool({ timeoutMs: 30000, maxOutputLines: 100 });
    const result = await tool.execute({ command: 'echo object-input' }, {} as any);
    expect(resultStr(result)).toContain('object-input');
  });

  it('generates call display', () => {
    const tool = new BashTool({ timeoutMs: 30000, maxOutputLines: 100 });
    const display = tool.callDisplay(JSON.stringify({ command: 'ls -la' }));
    expect(display).toContain('ls -la');
  });

  it('limits output lines', async () => {
    const tool = new BashTool({ timeoutMs: 30000, maxOutputLines: 2 });
    const result = await tool.execute(JSON.stringify({ command: 'printf "line1\\nline2\\nline3\\nline4\\nline5"' }), {} as any);
    // Should be truncated
    expect(resultStr(result)).toContain('truncated');
  });

  it('caps in-memory buffering for huge single-line output', async () => {
    const tool = new BashTool({ timeoutMs: 30000, maxOutputLines: 100 });
    // 3MB of output with no newlines: well past the 1M char buffer cap.
    const result = await tool.execute(
      JSON.stringify({ command: "head -c 3000000 /dev/zero | tr '\\0' 'a'" }),
      {} as any,
    );
    const str = resultStr(result);
    expect(str).toContain('[output truncated]');
    // Buffer cap (1M chars) + marker, far below the 3MB actually produced.
    expect(str.length).toBeLessThan(1_100_000);
    expect(result.metadata?.get('exit_code')).toBe('0');
  });

  it('handles multiline output', async () => {
    const tool = new BashTool({ timeoutMs: 30000, maxOutputLines: 100 });
    const result = await tool.execute(JSON.stringify({ command: 'printf "line1\\nline2\\nline3"' }), {} as any);
    expect(resultStr(result)).toContain('line1');
    expect(resultStr(result)).toContain('line2');
    expect(resultStr(result)).toContain('line3');
  });

  it('captures stderr', async () => {
    const tool = new BashTool({ timeoutMs: 30000, maxOutputLines: 100 });
    const result = await tool.execute(JSON.stringify({ command: 'echo error >&2; echo success' }), {} as any);
    expect(resultStr(result)).toContain('success');
  });

  it('truncates long command in metadata (>60 chars)', async () => {
    const tool = new BashTool({ timeoutMs: 30000, maxOutputLines: 100 });
    const longCmd = 'echo ' + 'a'.repeat(70);
    const result = await tool.execute(JSON.stringify({ command: longCmd }), {} as any);
    const metadata = result.metadata!;
    expect(metadata).toBeDefined();
    const cmd = metadata.get('command')!;
    expect(cmd.length).toBe(61); // 60 chars + "…"
    expect(cmd).toContain('…');
  });

  it('stores short command in metadata', async () => {
    const tool = new BashTool({ timeoutMs: 30000, maxOutputLines: 100 });
    const result = await tool.execute(JSON.stringify({ command: 'echo hello' }), {} as any);
    const metadata = result.metadata!;
    expect(metadata).toBeDefined();
    expect(metadata.get('command')).toBe('echo hello');
    expect(metadata.get('exit_code')).toBe('0');
  });

  it('create() registers tool via HOOKS.TOOLS_REGISTER', async () => {
    let registeredName: string | null = null;
    let registeredTool: any = null;
    const registry = { register: (name: string, tool: any) => { registeredName = name; registeredTool = tool; }, getAll: () => [] };
    const mockCore = { config: { bashTool: { bashTimeoutMs: 5000, maxToolOutputLines: 100 } } } as any;
    const ext = create(mockCore);
    await ext.hooks![HOOKS.TOOLS_REGISTER]!(registry as any);
    expect(registeredName!).toBe('bash');
    expect(registeredTool).toBeInstanceOf(BashTool);
  });

  it('create() registers with default config when none provided', async () => {
    let registeredName: string | null = null;
    let registeredTool: any = null;
    const registry = { register: (name: string, tool: any) => { registeredName = name; registeredTool = tool; }, getAll: () => [] };
    const mockCore = { config: {} } as any;
    const ext = create(mockCore);
    await ext.hooks![HOOKS.TOOLS_REGISTER]!(registry as any);
    expect(registeredName!).toBe('bash');
    expect(registeredTool).toBeInstanceOf(BashTool);
  });
});
