import { describe, it, expect } from 'bun:test';
import {
  ColorPalette,
  NAMED_THEMES,
  dark_palette,
  light_palette,
  monochrome_palette,
  applyColor,
  mergePalette,
  resolvePalette,
  applyThinking,
  applyToolCall,
  applyToolResult,
  applyFinalResponse,
  applyCompacting,
  colorDisabledByEnv,
  applyProgress,
  applyShellHighlight,
  applyArgKeyHighlight,
  applyArgSeparator,
} from '../../../src/utils/cli/colors.ts';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('ColorPalette', () => {
  it('creates with sensible defaults', () => {
    const p = new ColorPalette();
    expect(p.use_colors).toBe(true);
    expect(p.thinking).toBe('cyan');
    expect(p.tool_call).toBe('yellow');
    expect(p.arg_key).toBe('cyan');
    expect(p.shell_command).toBe('cyan');
    expect(p.shell_operator).toBe('bright_black');
    expect(p.arg_separator).toBe('bright_black');
  });

  it('accepts custom values overriding defaults', () => {
    const p = new ColorPalette({ thinking: 'red', use_colors: false });
    expect(p.thinking).toBe('red');
    expect(p.use_colors).toBe(false);
  });

  it('static default() creates a dark palette', () => {
    const p = ColorPalette.default();
    expect(p.use_colors).toBe(true);
    expect(p.thinking).toBe('cyan');
  });
});

describe('Named themes', () => {
  it('dark and light themes produce different palettes', () => {
    expect(dark_palette().thinking).not.toBe(light_palette().thinking);
    expect(dark_palette().final_response).not.toBe(light_palette().final_response);
    // Basic cyan washes out on light backgrounds; the arg accent must darken.
    expect(dark_palette().arg_key).not.toBe(light_palette().arg_key);
    expect(dark_palette().shell_command).not.toBe(light_palette().shell_command);
  });

  it('monochrome uses text styles instead of colors', () => {
    const mono = monochrome_palette();
    expect(mono.thinking).toBe('dim');
    expect(mono.tool_call).toBe('bold');
    expect(mono.tool_result).toBe('underline');
    expect(mono.arg_key).toBe('bold');
    expect(mono.shell_command).toBe('bold');
    expect(mono.shell_operator).toBe('dim');
    expect(mono.arg_separator).toBe('dim');
  });
});

describe('applyColor', () => {
  it('wraps text with ANSI codes when enabled', () => {
    const result = applyColor('hello', 'red', true);
    expect(result).toMatch(/\x1b\[\d+mhello\x1b\[0m/);
  });

  it('returns text unchanged when colors disabled', () => {
    expect(applyColor('hello', 'red', false)).toBe('hello');
  });

  it('returns text unchanged for unknown color', () => {
    expect(applyColor('hello', '' as string, true)).toBe('hello');
    expect(applyColor('hello', 'nonexistent', true)).toBe('hello');
  });
});

describe('mergePalette', () => {
  it('overrides specified fields while preserving others', () => {
    const base = new ColorPalette(dark_palette());
    const merged = mergePalette(base, { thinking: 'red' });
    expect(merged.thinking).toBe('red');
    expect(merged.tool_call).toBe(base.tool_call);
  });

  it('respects use_colors override', () => {
    const base = new ColorPalette(dark_palette());
    const merged = mergePalette(base, { use_colors: false });
    expect(merged.use_colors).toBe(false);
  });
});

describe('resolvePalette', () => {
  it('returns disabled palette when useColors is false', async () => {
    const p = await resolvePalette(null, null, null, false);
    expect(p.use_colors).toBe(false);
  });

  it('resolves named themes correctly', async () => {
    const darkPalette = await resolvePalette(null, null, 'dark', true);
    const lightPalette = await resolvePalette(null, null, 'light', true);
    expect(darkPalette.thinking).not.toBe(lightPalette.thinking);
  });

  it('defaults to dark theme when no theme specified', async () => {
    const p = await resolvePalette(null, null, null, true);
    expect(p.use_colors).toBe(true);
    expect(p.thinking).toBe('cyan');
  });

  it('applies config palette overrides', async () => {
    const p = await resolvePalette(null, { thinking: 'red' }, null, true);
    expect(p.thinking).toBe('red');
  });

  it('handles case-insensitive theme names', async () => {
    const p = await resolvePalette(null, null, 'DARK', true);
    expect(p.use_colors).toBe(true);
  });

  it('loads palette from file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colors-test-'));
    const filePath = path.join(tmpDir, 'theme.json');
    await fsPromises.writeFile(filePath, JSON.stringify({ thinking: 'red', tool_call: 'blue' }));
    try {
      const p = await resolvePalette(filePath, null, null, true);
      expect(p.thinking).toBe('red');
      expect(p.tool_call).toBe('blue');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to dark palette on invalid theme file', async () => {
    const p = await resolvePalette('/nonexistent/theme.json', null, null, true);
    expect(p.thinking).toBe('cyan');
  });

  it('resolves named theme via themeFile param', async () => {
    const p = await resolvePalette('light', null, null, true);
    expect(p.thinking).toBe('blue');
  });
});

// All apply* functions share the same pattern: apply color when enabled, return plain text when disabled.
// Test each one concisely.
describe('apply* formatting functions', () => {
  const functions = [
    { name: 'applyThinking', fn: applyThinking, field: 'thinking' },
    { name: 'applyToolCall', fn: applyToolCall, field: 'tool_call' },
    { name: 'applyToolResult', fn: applyToolResult, field: 'tool_result' },
    { name: 'applyFinalResponse', fn: applyFinalResponse, field: 'final_response' },
    { name: 'applyCompacting', fn: applyCompacting, field: 'compacting' },
    { name: 'applyProgress', fn: applyProgress, field: 'progress' },
  ];

  for (const { name, fn } of functions) {
    describe(name, () => {
      it('applies color from palette', () => {
        const p = ColorPalette.default();
        const result = fn('test text', p);
        expect(result).toMatch(/\x1b\[[\d;]+mtest text\x1b\[0m/);
      });

      it('returns plain text when colors disabled', () => {
        const p = new ColorPalette({ use_colors: false });
        expect(fn('plain text', p)).toBe('plain text');
      });
    });
  }
});

describe('NAMED_THEMES', () => {
  it('exports all three named themes', () => {
    expect(NAMED_THEMES.dark).toBeDefined();
    expect(NAMED_THEMES.light).toBeDefined();
    expect(NAMED_THEMES.monochrome).toBeDefined();
  });

  it('named theme functions return valid palettes', () => {
    expect(NAMED_THEMES.dark!()).toEqual(dark_palette());
    expect(NAMED_THEMES.light!()).toEqual(light_palette());
    expect(NAMED_THEMES.monochrome!()).toEqual(monochrome_palette());
  });
});

describe('colorDisabledByEnv', () => {
  it('disables on NO_COLOR present and non-empty', () => {
    expect(colorDisabledByEnv({ NO_COLOR: '1' })).toBe(true);
    expect(colorDisabledByEnv({ NO_COLOR: '0' })).toBe(true); // spec: any non-empty value
  });

  it('empty NO_COLOR does not disable', () => {
    expect(colorDisabledByEnv({ NO_COLOR: '' })).toBe(false);
  });

  it('disables on TERM=dumb', () => {
    expect(colorDisabledByEnv({ TERM: 'dumb' })).toBe(true);
  });

  it('normal environments pass', () => {
    expect(colorDisabledByEnv({})).toBe(false);
    expect(colorDisabledByEnv({ TERM: 'xterm-256color' })).toBe(false);
  });
});

describe('applyShellHighlight', () => {
  const on = new ColorPalette({ use_colors: true });
  const off = new ColorPalette({ use_colors: false });

  it('is a no-op with colors off', () => {
    expect(applyShellHighlight('cd /tmp && ls', off)).toBe('cd /tmp && ls');
  });

  it('highlights command words cyan; everything else rides the default', () => {
    expect(applyShellHighlight('ls -la', on)).toBe('\x1b[36mls\x1b[0m -la');
  });

  it('arms the command position after &&, ||, | and ;', () => {
    const out = applyShellHighlight('a && b || c | d ; e', on);
    for (const cmd of ['a', 'b', 'c', 'd', 'e']) {
      expect(out).toContain(`\x1b[36m${cmd}\x1b[0m`);
    }
    for (const [op, next] of [['&&', 'b'], ['||', 'c'], ['|', 'd'], [';', 'e']]) {
      // Operators dim and arm the next command word.
      expect(out).toContain(`\x1b[90m${op}\x1b[0m \x1b[36m${next}\x1b[0m`);
    }
  });

  it('splits glued operators without surrounding spaces', () => {
    // `;` glued to the previous word is the common shape: `echo hi; ls`.
    expect(applyShellHighlight('echo hi; ls -la', on)).toBe(
      '\x1b[31mecho\x1b[0m hi\x1b[35m;\x1b[0m \x1b[31mls\x1b[0m -la',
    );
    expect(applyShellHighlight('a&&b||c|d;e', on)).toBe(
      '\x1b[31ma\x1b[0m\x1b[35m&&\x1b[0m\x1b[31mb\x1b[0m\x1b[35m||\x1b[0m\x1b[31mc\x1b[0m\x1b[35m|\x1b[0m\x1b[31md\x1b[0m\x1b[35m;\x1b[0m\x1b[31me\x1b[0m',
    );
    // A lone `&` (background, `2>&1`) is not an operator and rides through.
    expect(applyShellHighlight('make -j 2>&1 & wait', on)).toBe(
      '\x1b[31mmake\x1b[0m -j 2>&1 & wait',
    );
    // Quoted operators still split nothing.
    expect(applyShellHighlight("grep 'a;b' f;wc -l f", on)).toBe(
      '\x1b[31mgrep\x1b[0m \'a;b\' f\x1b[35m;\x1b[0m\x1b[31mwc\x1b[0m -l f',
    );
  });

  it('never touches quoted text and carries stray quotes verbatim (no char loss)', () => {
    expect(applyShellHighlight('grep "a && b" src', on)).toBe(
      '\x1b[36mgrep\x1b[0m "a && b" src',
    );
    expect(applyShellHighlight("echo don't", on)).toBe("\x1b[36mecho\x1b[0m don't");
  });

  it('keeps env prefixes default-colored and the command position armed', () => {
    expect(applyShellHighlight('FOO=1 cmd arg', on)).toBe(
      'FOO=1 \x1b[36mcmd\x1b[0m arg',
    );
  });

  it('takes command and operator colors from the palette', () => {
    const p = new ColorPalette({ use_colors: true, shell_command: 'green', shell_operator: 'bold' });
    expect(applyShellHighlight('ls && pwd', p)).toBe(
      '\x1b[32mls\x1b[0m \x1b[1m&&\x1b[0m \x1b[32mpwd\x1b[0m',
    );
  });

  it('leaves a class unstyled when its palette color is empty or unknown', () => {
    const p = new ColorPalette({ use_colors: true, shell_command: 'nonexistent', shell_operator: '' });
    expect(applyShellHighlight('ls && pwd', p)).toBe('ls && pwd');
  });

  it('monochrome lights styles, never hues', () => {
    const mono = new ColorPalette(monochrome_palette());
    expect(applyShellHighlight('ls && pwd', mono)).toBe(
      '\x1b[1mls\x1b[0m \x1b[2m&&\x1b[0m \x1b[1mpwd\x1b[0m',
    );
  });
});

describe('applyArgKeyHighlight', () => {
  const on = new ColorPalette({ use_colors: true });
  const off = new ColorPalette({ use_colors: false });

  it('is a no-op with colors off', () => {
    expect(applyArgKeyHighlight('path: a.ts · limit: 10', off)).toBe('path: a.ts · limit: 10');
  });

  it('lights keys cyan at pair boundaries', () => {
    expect(applyArgKeyHighlight('path: a.ts · limit: 10', on)).toBe(
      '\x1b[36mpath:\x1b[0m a.ts · \x1b[36mlimit:\x1b[0m 10',
    );
  });

  it('never lights a value that merely contains ": " mid-stream', () => {
    expect(applyArgKeyHighlight('note: a: b', on)).toBe(
      '\x1b[36mnote:\x1b[0m a: b',
    );
  });

  it('skips keys with spaces or punctuation (cosmetic miss, never mangled)', () => {
    expect(applyArgKeyHighlight('odd key: x · fine: y', on)).toBe(
      'odd key: x · \x1b[36mfine:\x1b[0m y',
    );
  });

  it('takes the key color from the palette', () => {
    const p = new ColorPalette({ use_colors: true, arg_key: 'magenta' });
    expect(applyArgKeyHighlight('path: a.ts · limit: 10', p)).toBe(
      '\x1b[35mpath:\x1b[0m a.ts · \x1b[35mlimit:\x1b[0m 10',
    );
  });

  it('passes the text through when the palette color is empty or unknown', () => {
    const p = new ColorPalette({ use_colors: true, arg_key: '' });
    expect(applyArgKeyHighlight('path: a.ts · limit: 10', p)).toBe('path: a.ts · limit: 10');
    const q = new ColorPalette({ use_colors: true, arg_key: 'nonexistent' });
    expect(applyArgKeyHighlight('path: a.ts', q)).toBe('path: a.ts');
  });
});

describe('applyArgSeparator', () => {
  const on = new ColorPalette({ use_colors: true });
  const off = new ColorPalette({ use_colors: false });

  it('is a no-op with colors off', () => {
    expect(applyArgSeparator('path: a.ts · limit: 10', off)).toBe('path: a.ts · limit: 10');
  });

  it('dims the pair separator between summarized args', () => {
    expect(applyArgSeparator('a: 1 · b: 2', on)).toBe('a: 1\x1b[90m · \x1b[0mb: 2');
  });

  it('leaves single-pair lines untouched', () => {
    expect(applyArgSeparator('path: a.ts', on)).toBe('path: a.ts');
  });

  it('takes the dim color from the palette; empty or unknown stays plain', () => {
    const p = new ColorPalette({ use_colors: true, arg_separator: 'dim' });
    expect(applyArgSeparator('a: 1 · b: 2', p)).toBe('a: 1\x1b[2m · \x1b[0mb: 2');
    const q = new ColorPalette({ use_colors: true, arg_separator: '' });
    expect(applyArgSeparator('a: 1 · b: 2', q)).toBe('a: 1 · b: 2');
  });

  it('runs after the key pass without breaking its pair-boundary anchor', () => {
    // The anchor needs the bare separator; composing key-then-separator is
    // the sink order, and it lights both keys and both separators.
    const composed = applyArgSeparator(applyArgKeyHighlight('path: a.ts · limit: 10', on), on);
    expect(composed).toBe(
      '\x1b[36mpath:\x1b[0m a.ts\x1b[90m · \x1b[0m\x1b[36mlimit:\x1b[0m 10',
    );
  });
});
