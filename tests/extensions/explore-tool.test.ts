import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

// ── Mock node:child_process before importing ExploreTool ──────────────────
// This allows us to test the spawn flow without actually spawning a process.

const mockSpawn = mock(() => ({
  stdout: { on: function() {} },
  stderr: { on: function() {} },
  on: function() { return this; },
}));

mock.module("node:child_process", () => ({
  spawn: mockSpawn,
}));

import { ExploreTool } from '../../src/extensions/core-tools/explore.ts';
import { ToolContext } from '../../src/core/extensions/tool-context.ts';
import { resultStr } from '../helpers.ts';

describe('ExploreTool', () => {
  it('has correct TOOL_NAME', () => {
    expect(ExploreTool.TOOL_NAME).toBe('explore');
  });

  it('has valid tool definition', () => {
    const tool = new ExploreTool();
    const def = tool.toToolDef();
    expect(def.function.name).toBe('explore');
    expect(def.function.description.length).toBeGreaterThan(0);
    expect(def.function.parameters.properties).toHaveProperty('path');
    expect(def.function.parameters.properties).toHaveProperty('outline');
    expect(def.function.parameters.required).toEqual(['path', 'outline']);
  });
});

describe('ExploreTool > callDisplay', () => {
  const tool = new ExploreTool();

  it('returns path=. for empty input', () => {
    expect(tool.callDisplay('')).toBe('path=.');
    expect(tool.callDisplay('  ')).toBe('path=.');
    expect(tool.callDisplay(null)).toBe('path=.');
  });

  it('formats path and outline', () => {
    expect(
      tool.callDisplay(JSON.stringify({ path: '/tmp', outline: 'src files' }))
    ).toBe('path=/tmp -> src files');
  });

  it('handles malformed JSON gracefully', () => {
    const result = tool.callDisplay('not-json');
    expect(result).toBe('not-json');
  });

  it('handles object input for callDisplay', () => {
    expect(
      tool.callDisplay({ path: '/project', outline: 'find tests' })
    ).toBe('path=/project -> find tests');
  });
});

describe('ExploreTool > execute input parsing', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('rejects empty input (defaults to path=., no outline)', async () => {
    const mockProc: any = {
      stdout: { on: function() {} },
      stderr: { on: function() {} },
      on: function(event: string, cb: Function) {
        if (event === "close") { setImmediate(() => cb(0)); }
        return mockProc;
      },
    };
    mockSpawn.mockImplementation(() => mockProc);

    const tool = new ExploreTool();
    const result = await tool.execute('', new ToolContext());
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });

  it('accepts malformed JSON as outline (path defaults to .)', async () => {
    const mockProc: any = {
      stdout: { on: function() {} },
      stderr: { on: function() {} },
      on: function(event: string, cb: Function) {
        if (event === "close") { setImmediate(() => cb(0)); }
        return mockProc;
      },
    };
    mockSpawn.mockImplementation(() => mockProc);

    const tool = new ExploreTool();
    const result = await tool.execute('not valid json', new ToolContext());
    // Malformed JSON is treated as outline, path defaults to "."
    expect((result as any).metadata.get('path')).toBe('.');
    expect((result as any).metadata.get('outline')).toBe('not valid json');
  });

  it('rejects null input', async () => {
    const mockProc: any = {
      stdout: { on: function() {} },
      stderr: { on: function() {} },
      on: function(event: string, cb: Function) {
        if (event === "close") { setImmediate(() => cb(0)); }
        return mockProc;
      },
    };
    mockSpawn.mockImplementation(() => mockProc);

    const tool = new ExploreTool();
    const result = await tool.execute(null, new ToolContext());
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });

  it('rejects input with non-string path (falls back to path=.)', async () => {
    const mockProc: any = {
      stdout: { on: function() {} },
      stderr: { on: function() {} },
      on: function(event: string, cb: Function) {
        if (event === "close") { setImmediate(() => cb(0)); }
        return mockProc;
      },
    };
    mockSpawn.mockImplementation(() => mockProc);

    const tool = new ExploreTool();
    const result = await tool.execute({ path: 123 }, new ToolContext());
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });
});

describe('ExploreTool > execute', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('rejects missing outline', async () => {
    const tool = new ExploreTool();
    const result = await tool.execute(JSON.stringify({ path: '/tmp' }), new ToolContext());
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });

  it('rejects empty input', async () => {
    const tool = new ExploreTool();
    const result = await tool.execute('', new ToolContext());
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });

  it('handles null input', async () => {
    const tool = new ExploreTool();
    const result = await tool.execute(null, new ToolContext());
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });

  it('handles whitespace-only outline', async () => {
    const tool = new ExploreTool();
    const result = await tool.execute(JSON.stringify({ path: '/tmp', outline: '   ' }), new ToolContext());
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });

  it('handles object input with missing outline', async () => {
    const tool = new ExploreTool();
    const result = await tool.execute({ path: '/tmp' }, new ToolContext());
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });

  // ── Spawn flow tests (using mocked node:child_process) ──────────────

  it('returns success result when explorer exits with code 0', async () => {
    const mockProc: any = {
      stdout: {
        on: function(event: string, cb: Function) {
          if (event === "data") cb(Buffer.from("Explorer output line 1\nExplorer output line 2"));
        },
      },
      stderr: { on: function() {} },
      on: function(event: string, cb: Function) {
        if (event === "close") {
          setImmediate(() => cb(0));
        }
        return mockProc;
      },
    };

    mockSpawn.mockImplementation(() => mockProc);

    const tool = new ExploreTool();
    const result = await tool.execute(
      JSON.stringify({ path: '/tmp/test', outline: 'check structure' }),
      new ToolContext()
    );

    // Verify spawn was called with correct arguments
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const calls = mockSpawn.mock.calls as unknown[][];
    expect(calls[0]![0]).toBe("bun");
    const args = calls[0]![1] as string[];
    expect(args).toContain('-c');
    expect(args).toContain('--profile');
    expect(args).toContain('explorer');
    expect(args).toContain('--hide-tools');
    expect(args).toContain('--hide-thinking');

    // Verify cwd option
    const options = calls[0]![2] as Record<string, unknown>;
    expect(options.cwd).toBe('/tmp/test');

    // Verify result
    const output = resultStr(result);
    expect(output).toBe("Explorer output line 1\nExplorer output line 2");
    expect((result as any).metadata).toBeInstanceOf(Map);
    expect((result as any).metadata.get('path')).toBe('/tmp/test');
    expect((result as any).metadata.get('exit_code')).toBe('0');
  });

  it('returns error result when explorer exits with non-zero code', async () => {
    const mockProc: any = {
      stdout: { on: function() {} },
      stderr: {
        on: function(event: string, cb: Function) {
          if (event === "data") cb(Buffer.from("Error: command not found"));
        },
      },
      on: function(event: string, cb: Function) {
        if (event === "close") {
          setImmediate(() => cb(1));
        }
        return mockProc;
      },
    };

    mockSpawn.mockImplementation(() => mockProc);

    const tool = new ExploreTool();
    const result = await tool.execute(
      JSON.stringify({ path: '/tmp/test', outline: 'check structure' }),
      new ToolContext()
    );

    const output = resultStr(result);
    expect(output).toBe("Error: command not found");
    expect((result as any).metadata.get('exit_code')).toBe('1');
    expect((result as any).metadata.get('path')).toBe('/tmp/test');
  });

  it('returns error with exit code message when stderr is empty', async () => {
    const mockProc: any = {
      stdout: { on: function() {} },
      stderr: { on: function() {} },
      on: function(event: string, cb: Function) {
        if (event === "close") {
          setImmediate(() => cb(2));
        }
        return mockProc;
      },
    };

    mockSpawn.mockImplementation(() => mockProc);

    const tool = new ExploreTool();
    const result = await tool.execute(
      JSON.stringify({ path: '/tmp/test', outline: 'check' }),
      new ToolContext()
    );

    const output = resultStr(result);
    expect(output).toContain("Explorer exited with code 2");
  });

  it('accumulates multiple stdout chunks', async () => {
    let stdoutCb: Function | null = null;
    const mockProc: any = {
      stdout: {
        on: function(event: string, cb: Function) {
          if (event === "data") {
            stdoutCb = cb;
          }
        },
      },
      stderr: { on: function() {} },
      on: function(event: string, cb: Function) {
        if (event === "close") {
          setImmediate(() => {
            // Simulate multiple chunks
            if (stdoutCb) {
              stdoutCb(Buffer.from("chunk1"));
              stdoutCb(Buffer.from("chunk2"));
              stdoutCb(Buffer.from("chunk3"));
            }
            cb(0);
          });
        }
        return mockProc;
      },
    };

    mockSpawn.mockImplementation(() => mockProc);

    const tool = new ExploreTool();
    const result = await tool.execute(
      JSON.stringify({ path: '/tmp', outline: 'test' }),
      new ToolContext()
    );

    const output = resultStr(result);
    expect(output).toBe("chunk1chunk2chunk3");
  });

  it('includes content_length in success result entries', async () => {
    const mockProc: any = {
      stdout: {
        on: function(event: string, cb: Function) {
          if (event === "data") cb(Buffer.from("12345"));
        },
      },
      stderr: { on: function() {} },
      on: function(event: string, cb: Function) {
        if (event === "close") {
          setImmediate(() => cb(0));
        }
        return mockProc;
      },
    };

    mockSpawn.mockImplementation(() => mockProc);

    const tool = new ExploreTool();
    const result = await tool.execute(
      JSON.stringify({ path: '/tmp', outline: 'test' }),
      new ToolContext()
    );

    expect((result as any).metadata.get('content_length')).toBe('5');
  });

  it('includes command in result entries', async () => {
    const mockProc: any = {
      stdout: { on: function(event: string, cb: Function) { if (event === "data") cb(Buffer.from("ok")); } },
      stderr: { on: function() {} },
      on: function(event: string, cb: Function) {
        if (event === "close") { setImmediate(() => cb(0)); }
        return mockProc;
      },
    };

    mockSpawn.mockImplementation(() => mockProc);

    const tool = new ExploreTool();
    const result = await tool.execute(
      JSON.stringify({ path: '/tmp', outline: 'test' }),
      new ToolContext()
    );

    expect((result as any).metadata.get('command')).toContain('-c');
    expect((result as any).metadata.get('command')).toContain('explorer');
    expect((result as any).metadata.get('command')).toContain('--hide-tools');
  });

  it('trims output whitespace', async () => {
    const mockProc: any = {
      stdout: {
        on: function(event: string, cb: Function) {
          if (event === "data") cb(Buffer.from("  output with spaces  \n"));
        },
      },
      stderr: { on: function() {} },
      on: function(event: string, cb: Function) {
        if (event === "close") { setImmediate(() => cb(0)); }
        return mockProc;
      },
    };

    mockSpawn.mockImplementation(() => mockProc);

    const tool = new ExploreTool();
    const result = await tool.execute(
      JSON.stringify({ path: '/tmp', outline: 'test' }),
      new ToolContext()
    );

    const output = resultStr(result);
    expect(output).toBe("output with spaces");
  });

  it('accepts object input (not JSON string)', async () => {
    const mockProc: any = {
      stdout: {
        on: function(event: string, cb: Function) {
          if (event === "data") cb(Buffer.from("ok"));
        },
      },
      stderr: { on: function() {} },
      on: function(event: string, cb: Function) {
        if (event === "close") { setImmediate(() => cb(0)); }
        return mockProc;
      },
    };

    mockSpawn.mockImplementation(() => mockProc);

    const tool = new ExploreTool();
    const result = await tool.execute(
      { path: '/project', outline: 'find tests' },
      new ToolContext()
    );

    const output = resultStr(result);
    expect(output).toBe("ok");
  });
});
