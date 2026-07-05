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
  applyProgress,
} from '../../src/core/ui/colors.js';
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
  });

  it('monochrome uses text styles instead of colors', () => {
    const mono = monochrome_palette();
    expect(mono.thinking).toBe('dim');
    expect(mono.tool_call).toBe('bold');
    expect(mono.tool_result).toBe('underline');
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
    expect(applyColor('hello', null, true)).toBe('hello');
    expect(applyColor('hello', 'nonexistent', true)).toBe('hello');
  });
});

describe('mergePalette', () => {
  it('overrides specified fields while preserving others', () => {
    const base = dark_palette();
    const merged = mergePalette(base, { thinking: 'red' });
    expect(merged.thinking).toBe('red');
    expect(merged.tool_call).toBe(base.tool_call);
  });

  it('respects use_colors override', () => {
    const base = dark_palette();
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

describe('applyThinking', () => {
  it('applies thinking color from palette', () => {
    const p = ColorPalette.default();
    const result = applyThinking('thinking text', p);
    expect(result).toMatch(/\x1b\[\d+mthinking text\x1b\[0m/);
  });

  it('returns plain text when colors disabled', () => {
    const p = new ColorPalette({ use_colors: false });
    expect(applyThinking('text', p)).toBe('text');
  });
});

describe('applyToolCall', () => {
  it('applies tool_call color from palette', () => {
    const p = ColorPalette.default();
    const result = applyToolCall('call text', p);
    expect(result).toMatch(/\x1b\[33mcall text\x1b\[0m/);
  });

  it('returns plain text when colors disabled', () => {
    const p = new ColorPalette({ use_colors: false });
    expect(applyToolCall('text', p)).toBe('text');
  });
});

describe('applyToolResult', () => {
  it('applies tool_result color from palette', () => {
    const p = ColorPalette.default();
    const result = applyToolResult('result text', p);
    expect(result).toMatch(/\x1b\[32mresult text\x1b\[0m/);
  });

  it('returns plain text when colors disabled', () => {
    const p = new ColorPalette({ use_colors: false });
    expect(applyToolResult('text', p)).toBe('text');
  });
});

describe('applyFinalResponse', () => {
  it('applies final_response color from palette', () => {
    const p = ColorPalette.default();
    const result = applyFinalResponse('response', p);
    expect(result).toMatch(/\x1b\[1;37mresponse\x1b\[0m/);
  });

  it('returns plain text when colors disabled', () => {
    const p = new ColorPalette({ use_colors: false });
    expect(applyFinalResponse('text', p)).toBe('text');
  });
});

describe('applyCompacting', () => {
  it('applies compacting color from palette', () => {
    const p = ColorPalette.default();
    const result = applyCompacting('compacting', p);
    expect(result).toMatch(/\x1b\[1;31mcompacting\x1b\[0m/);
  });

  it('returns plain text when colors disabled', () => {
    const p = new ColorPalette({ use_colors: false });
    expect(applyCompacting('text', p)).toBe('text');
  });
});

describe('applyProgress', () => {
  it('applies progress color from palette', () => {
    const p = ColorPalette.default();
    const result = applyProgress('progress', p);
    expect(result).toMatch(/\x1b\[90mprogress\x1b\[0m/);
  });

  it('returns plain text when colors disabled', () => {
    const p = new ColorPalette({ use_colors: false });
    expect(applyProgress('text', p)).toBe('text');
  });
});

describe('NAMED_THEMES', () => {
  it('exports all three named themes', () => {
    expect(NAMED_THEMES.dark).toBeDefined();
    expect(NAMED_THEMES.light).toBeDefined();
    expect(NAMED_THEMES.monochrome).toBeDefined();
  });

  it('named theme functions return valid palettes', () => {
    expect(NAMED_THEMES.dark()).toEqual(dark_palette());
    expect(NAMED_THEMES.light()).toEqual(light_palette());
    expect(NAMED_THEMES.monochrome()).toEqual(monochrome_palette());
  });
});
