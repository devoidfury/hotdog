import fsPromises from "node:fs/promises";

// CLI color palettes and ANSI color helpers.

export interface PaletteOptions {
  thinking?: string;
  tool_call?: string;
  tool_result?: string;
  final_response?: string;
  compacting?: string;
  progress?: string;
  use_colors?: boolean;
}

/**
 * Color mapping for each OutputEvent variant.
 * Each variant gets a named color that can be configured or loaded from a theme file.
 */
export class ColorPalette {
  thinking: string;
  tool_call: string;
  tool_result: string;
  final_response: string;
  compacting: string;
  progress: string;
  use_colors: boolean;

  constructor(options: PaletteOptions = {}) {
    this.thinking = options.thinking ?? "cyan";
    this.tool_call = options.tool_call ?? "yellow";
    this.tool_result = options.tool_result ?? "green";
    this.final_response = options.final_response ?? "bold_white";
    this.compacting = options.compacting ?? "bold_red";
    this.progress = options.progress ?? "bright_black";
    this.use_colors = options.use_colors ?? true;
  }

  static default(): ColorPalette {
    return new ColorPalette(dark_palette());
  }
}

// ── Named Themes ──────────────────────────────────────────────────────────────

export const NAMED_THEMES: Record<string, () => PaletteOptions> = {
  dark: dark_palette,
  light: light_palette,
  monochrome: monochrome_palette,
};

export function dark_palette(): PaletteOptions {
  return {
    thinking: "cyan",
    tool_call: "yellow",
    tool_result: "green",
    final_response: "bold_white",
    compacting: "bold_red",
    progress: "bright_black",
    use_colors: true,
  };
}

export function light_palette(): PaletteOptions {
  return {
    thinking: "blue",
    tool_call: "magenta",
    tool_result: "green",
    final_response: "black",
    compacting: "red",
    progress: "bright_black",
    use_colors: true,
  };
}

export function monochrome_palette(): PaletteOptions {
  return {
    thinking: "dim",
    tool_call: "bold",
    tool_result: "underline",
    final_response: "",
    compacting: "bold",
    progress: "bright_black",
    use_colors: true,
  };
}

// ── ANSI Color Codes ──────────────────────────────────────────────────────────

const COLOR_MAP: Record<string, string> = {
  black: "30",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  white: "37",
  bold_black: "1;30",
  bold_red: "1;31",
  bold_green: "1;32",
  bold_yellow: "1;33",
  bold_blue: "1;34",
  bold_magenta: "1;35",
  bold_cyan: "1;36",
  bold_white: "1;37",
  bright_black: "90",
  dim: "2",
  underline: "4",
};

const RESET = "\x1b[0m";

/**
 * Apply a color name to a string.
 * If `use_colors` is false, returns the text unchanged.
 */
export function applyColor(text: string, colorName: string, useColors: boolean): string {
  if (!useColors || !colorName) return text;
  const code = COLOR_MAP[colorName];
  if (!code) return text;
  return `\x1b[${code}m${text}${RESET}`;
}

// ── Palette Resolution ────────────────────────────────────────────────────────

/**
 * Merge a custom palette into a base palette, overriding only non-default fields.
 */
export function mergePalette(base: ColorPalette, custom: PaletteOptions): ColorPalette {
  return new ColorPalette({
    thinking: custom.thinking || base.thinking,
    tool_call: custom.tool_call || base.tool_call,
    tool_result: custom.tool_result || base.tool_result,
    final_response: custom.final_response || base.final_response,
    compacting: custom.compacting || base.compacting,
    progress: custom.progress || base.progress,
    use_colors:
      custom.use_colors !== undefined ? custom.use_colors : base.use_colors,
  });
}

/**
 * Resolve the effective color palette from CLI args, config, and theme file.
 */
export async function resolvePalette(
  themeFile: string | null | undefined,
  configPalette: PaletteOptions | null | undefined,
  namedTheme: string | null | undefined,
  useColors: boolean,
): Promise<ColorPalette> {
  if (!useColors) {
    return new ColorPalette({ use_colors: false });
  }

  let palette: ColorPalette;
  if (themeFile) {
    // Check if it's a named theme or a file path
    const themeFn = NAMED_THEMES[themeFile.toLowerCase()];
    if (themeFn) {
      palette = new ColorPalette(themeFn());
    } else {
      // Try to load from file
      try {
        const content = await fsPromises.readFile(themeFile, "utf-8");
        const custom = JSON.parse(content) as PaletteOptions;
        const base = new ColorPalette(dark_palette());
        palette = mergePalette(base, custom);
      } catch {
        // Fall back to named theme
        palette = new ColorPalette(dark_palette());
      }
    }
  } else if (namedTheme && NAMED_THEMES[namedTheme.toLowerCase()]) {
    palette = new ColorPalette(NAMED_THEMES[namedTheme.toLowerCase()]!());
  } else {
    palette = new ColorPalette(dark_palette());
  }

  if (configPalette) {
    palette = mergePalette(palette, configPalette);
  }

  palette.use_colors = true;
  return palette;
}

// ── Event Formatters with Color ───────────────────────────────────────────────

/**
 * Apply thinking color to text.
 */
export function applyThinking(text: string, palette: ColorPalette): string {
  return applyColor(text, palette.thinking, palette.use_colors);
}

/**
 * Apply tool call color to text.
 */
export function applyToolCall(text: string, palette: ColorPalette): string {
  return applyColor(text, palette.tool_call, palette.use_colors);
}

/**
 * Apply tool result color to text.
 */
export function applyToolResult(text: string, palette: ColorPalette): string {
  return applyColor(text, palette.tool_result, palette.use_colors);
}

/**
 * Apply final response color to text.
 */
export function applyFinalResponse(text: string, palette: ColorPalette): string {
  return applyColor(text, palette.final_response, palette.use_colors);
}

/**
 * Apply compacting color to text.
 */
export function applyCompacting(text: string, palette: ColorPalette): string {
  return applyColor(text, palette.compacting, palette.use_colors);
}

/**
 * Apply progress color to text.
 */
export function applyProgress(text: string, palette: ColorPalette): string {
  return applyColor(text, palette.progress, palette.use_colors);
}
