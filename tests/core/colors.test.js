import { describe, it, expect } from 'bun:test';
import {
  ColorPalette,
  dark_palette,
  light_palette,
  monochrome_palette,
  applyColor,
  mergePalette,
  resolvePalette,
} from '../../src/core/ui/colors.js';

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
});
