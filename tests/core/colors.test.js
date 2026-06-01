import { describe, it, expect } from 'bun:test';
import {
  ColorPalette,
  NAMED_THEMES,
  dark_palette,
  light_palette,
  monochrome_palette,
  kindColorName,
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

describe('ColorPalette', () => {
  it('creates with defaults', () => {
    const p = new ColorPalette();
    expect(p.thinking).toBe('cyan');
    expect(p.tool_call).toBe('yellow');
    expect(p.tool_result).toBe('green');
    expect(p.final_response).toBe('bold_white');
    expect(p.compacting).toBe('bold_red');
    expect(p.progress).toBe('bright_black');
    expect(p.use_colors).toBe(true);
  });

  it('accepts custom values', () => {
    const p = new ColorPalette({ thinking: 'red', use_colors: false });
    expect(p.thinking).toBe('red');
    expect(p.use_colors).toBe(false);
  });

  it('creates default palette', () => {
    const p = ColorPalette.default();
    expect(p.thinking).toBe('cyan');
    expect(p.use_colors).toBe(true);
  });
});

describe('Named themes', () => {
  it('dark theme has expected colors', () => {
    const p = dark_palette();
    expect(p.thinking).toBe('cyan');
    expect(p.tool_call).toBe('yellow');
    expect(p.tool_result).toBe('green');
    expect(p.final_response).toBe('bold_white');
    expect(p.compacting).toBe('bold_red');
    expect(p.progress).toBe('bright_black');
  });

  it('light theme has expected colors', () => {
    const p = light_palette();
    expect(p.thinking).toBe('blue');
    expect(p.tool_call).toBe('magenta');
    expect(p.tool_result).toBe('green');
    expect(p.final_response).toBe('black');
    expect(p.compacting).toBe('red');
    expect(p.progress).toBe('bright_black');
  });

  it('monochrome theme has expected colors', () => {
    const p = monochrome_palette();
    expect(p.thinking).toBe('dim');
    expect(p.tool_call).toBe('bold');
    expect(p.tool_result).toBe('underline');
    expect(p.final_response).toBe('');
    expect(p.compacting).toBe('bold');
    expect(p.progress).toBe('bright_black');
  });

  it('NAMED_THEMES contains all themes', () => {
    expect(NAMED_THEMES.dark).toBeDefined();
    expect(NAMED_THEMES.light).toBeDefined();
    expect(NAMED_THEMES.monochrome).toBeDefined();
  });

  it('themes are functions', () => {
    expect(typeof NAMED_THEMES.dark).toBe('function');
    expect(typeof NAMED_THEMES.light).toBe('function');
    expect(typeof NAMED_THEMES.monochrome).toBe('function');
  });
});

describe('kindColorName', () => {
  const palette = dark_palette();

  it('maps kind 1 (thinking) to thinking color', () => {
    expect(kindColorName(1, palette)).toBe('cyan');
  });

  it('maps kind 2 (tool_call) to tool_call color', () => {
    expect(kindColorName(2, palette)).toBe('yellow');
  });

  it('maps kind 3 (tool_result) to tool_result color', () => {
    expect(kindColorName(3, palette)).toBe('green');
  });

  it('maps kind 4 (final_response) to final_response color', () => {
    expect(kindColorName(4, palette)).toBe('bold_white');
  });

  it('maps kind 6 (compacting) to compacting color', () => {
    expect(kindColorName(6, palette)).toBe('bold_red');
  });

  it('maps kind 10 (thinking) to thinking color', () => {
    expect(kindColorName(10, palette)).toBe('cyan');
  });

  it('maps kind 11 (progress) to progress color', () => {
    expect(kindColorName(11, palette)).toBe('bright_black');
  });

  it('returns null for unknown kind', () => {
    expect(kindColorName(99, palette)).toBeNull();
  });
});

describe('applyColor', () => {
  it('applies color code when useColors is true', () => {
    const result = applyColor('hello', 'red', true);
    expect(result).toContain('\x1b[31m');
    expect(result).toContain('hello');
    expect(result).toContain('\x1b[0m');
  });

  it('returns text unchanged when useColors is false', () => {
    expect(applyColor('hello', 'red', false)).toBe('hello');
  });

  it('returns text unchanged when colorName is null', () => {
    expect(applyColor('hello', null, true)).toBe('hello');
  });

  it('returns text unchanged for unknown color name', () => {
    expect(applyColor('hello', 'nonexistent', true)).toBe('hello');
  });

  it('applies all known color codes', () => {
    const colors = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
    for (const color of colors) {
      const result = applyColor('x', color, true);
      expect(result).toContain('x');
      expect(result).toContain('\x1b[');
      expect(result).toContain('\x1b[0m');
    }
  });

  it('applies bold variants', () => {
    expect(applyColor('x', 'bold_red', true)).toContain('\x1b[1;31m');
    expect(applyColor('x', 'bold_white', true)).toContain('\x1b[1;37m');
  });

  it('applies special formats', () => {
    expect(applyColor('x', 'dim', true)).toContain('\x1b[2m');
    expect(applyColor('x', 'underline', true)).toContain('\x1b[4m');
    expect(applyColor('x', 'bright_black', true)).toContain('\x1b[90m');
  });
});

describe('mergePalette', () => {
  it('overrides only specified fields', () => {
    const base = dark_palette();
    const custom = { thinking: 'red' };
    const merged = mergePalette(base, custom);
    expect(merged.thinking).toBe('red');
    expect(merged.tool_call).toBe('yellow'); // unchanged
    expect(merged.tool_result).toBe('green'); // unchanged
  });

  it('overrides use_colors', () => {
    const base = dark_palette();
    const custom = { use_colors: false };
    const merged = mergePalette(base, custom);
    expect(merged.use_colors).toBe(false);
  });

  it('uses base values for unspecified custom fields', () => {
    const base = dark_palette();
    const custom = {};
    const merged = mergePalette(base, custom);
    expect(merged.thinking).toBe('cyan');
  });
});

describe('resolvePalette', () => {
  it('returns disabled palette when useColors is false', () => {
    const p = resolvePalette(null, null, null, false);
    expect(p.use_colors).toBe(false);
  });

  it('resolves dark named theme', () => {
    const p = resolvePalette(null, null, 'dark', true);
    expect(p.thinking).toBe('cyan');
    expect(p.use_colors).toBe(true);
  });

  it('resolves light named theme', () => {
    const p = resolvePalette(null, null, 'light', true);
    expect(p.thinking).toBe('blue');
    expect(p.use_colors).toBe(true);
  });

  it('resolves monochrome named theme', () => {
    const p = resolvePalette(null, null, 'monochrome', true);
    expect(p.thinking).toBe('dim');
    expect(p.use_colors).toBe(true);
  });

  it('defaults to dark theme when no theme specified', () => {
    const p = resolvePalette(null, null, null, true);
    expect(p.thinking).toBe('cyan');
    expect(p.use_colors).toBe(true);
  });

  it('applies config palette overrides', () => {
    const p = resolvePalette(null, { thinking: 'red' }, null, true);
    expect(p.thinking).toBe('red');
  });

  it('handles case-insensitive theme names', () => {
    const p = resolvePalette(null, null, 'DARK', true);
    expect(p.thinking).toBe('cyan');
  });
});

describe('Event formatters', () => {
  const palette = dark_palette();

  it('applyThinking uses thinking color', () => {
    const result = applyThinking('thoughts', palette);
    expect(result).toContain('\x1b[36m'); // cyan code
  });

  it('applyToolCall uses tool_call color', () => {
    const result = applyToolCall('tool call', palette);
    expect(result).toContain('\x1b[33m'); // yellow code
  });

  it('applyToolResult uses tool_result color', () => {
    const result = applyToolResult('result', palette);
    expect(result).toContain('\x1b[32m'); // green code
  });

  it('applyFinalResponse uses final_response color', () => {
    const result = applyFinalResponse('response', palette);
    expect(result).toContain('\x1b[1;37m'); // bold_white code
  });

  it('applyCompacting uses compacting color', () => {
    const result = applyCompacting('compact', palette);
    expect(result).toContain('\x1b[1;31m'); // bold_red code
  });

  it('applyProgress uses progress color', () => {
    const result = applyProgress('progress', palette);
    expect(result).toContain('\x1b[90m'); // bright_black code
  });
});
