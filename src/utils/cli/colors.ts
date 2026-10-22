import fsPromises from "node:fs/promises";

export interface PaletteOptions {
  thinking?: string;
  tool_call?: string;
  tool_result?: string;
  final_response?: string;
  compacting?: string;
  progress?: string;
  use_colors?: boolean;
}

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
  bold: "1",
  dim: "2",
  underline: "4",
};

const RESET = "\x1b[0m";

export function applyColor(text: string, colorName: string, useColors: boolean): string {
  if (!useColors || !colorName) return text;
  const code = COLOR_MAP[colorName];
  if (!code) return text;
  return `\x1b[${code}m${text}${RESET}`;
}

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
 * Environment-level color opt-out, checked before any palette resolution:
 * - NO_COLOR (https://no-color.org): present and non-empty disables color.
 * - TERM=dumb: terminfo convention for a terminal without color capability.
 *
 * Respects the conventions so scripts, pipes, and assistant harnesses
 * consuming CLI output get plain text without passing --no-colors.
 */
export function colorDisabledByEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return true;
  return env.TERM === "dumb";
}

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
    // A named theme takes precedence over treating the value as a file path.
    const themeFn = NAMED_THEMES[themeFile.toLowerCase()];
    if (themeFn) {
      palette = new ColorPalette(themeFn());
    } else {
      try {
        const content = await fsPromises.readFile(themeFile, "utf-8");
        const custom = JSON.parse(content) as PaletteOptions;
        const base = new ColorPalette(dark_palette());
        palette = mergePalette(base, custom);
      } catch {
        // Unreadable/invalid theme file: fall back to the dark theme.
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

export function applyThinking(text: string, palette: ColorPalette): string {
  return applyColor(text, palette.thinking, palette.use_colors);
}

export function applyToolCall(text: string, palette: ColorPalette): string {
  return applyColor(text, palette.tool_call, palette.use_colors);
}

/**
 * The arguments segment of a tool-call line: the terminal's DEFAULT
 * foreground, painted over the line-wide tool_call color (the mode applier
 * wraps the whole line later in _flushText). The line color is re-opened
 * after the segment so any postfix text (template tails) stays in the
 * line's own color. Colors off -> text unchanged. Call AFTER the spoof
 * pass: ESC is itself a neutralized code point, so embedding ANSI before
 * spoofSafe would shred it.
 */
export function applyToolCallArgs(text: string, palette: ColorPalette): string {
  if (!palette.use_colors || text === "") return text;
  const lineCode = COLOR_MAP[palette.tool_call];
  const restore = lineCode ? `\x1b[${lineCode}m` : RESET;
  return `${RESET}${text}${restore}`;
}

/**
 * Cyan for the key labels of summarized k: v args (non-bash tools): a key
 * counts only at a pair boundary -- line start or right after the " · "
 * separator -- so a value that happens to contain ": " never lights up
 * (worst case with a hostile-looking value is a cosmetic miss either way;
 * the text is spoof-neutralized upstream). Tokens close with RESET back to
 * the default args color. Colors off -> text unchanged.
 */
export function applyArgKeyHighlight(text: string, palette: ColorPalette): string {
  if (!palette.use_colors || text === "") return text;
  const cyan = COLOR_MAP.cyan!;
  return text.replace(
    /(^| · )([A-Za-z_][A-Za-z0-9_]*)(: )/g,
    (_m: string, lead: string, key: string) => `${lead}\x1b[${cyan}m${key}:${RESET} `,
  );
}

/**
 * Shell-syntax highlighting for the grey tool-args segment (the bash tool's
 * command): command words (line start, after &&, ||, | or ;) red, control
 * operators magenta, everything else in the default args color. Quote-aware -- nothing
 * inside '...' or "..." is touched, a stray quote rides through verbatim,
 * and an env-assignment prefix (`FOO=1 cmd`) stays default while keeping the
 * command position. Backticks/$(...)/glued operators (`a|b`) are NOT parsed:
 * this is display candy, not a shell. Colors off -> text unchanged.
 */
export function applyShellHighlight(text: string, palette: ColorPalette): string {
  if (!palette.use_colors || text === "") return text;
  const red = COLOR_MAP.red!;
  let out = "";
  let cmdPos = true;
  for (const [t] of text.matchAll(/('[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"]+|\s+|['"])/g)) {
    if (t === "&&" || t === "||" || t === "|" || t === ";") {
      // Purple so the glue between commands reads as structure, not text.
      out += `\x1b[${COLOR_MAP.magenta!}m${t}${RESET}`;
      cmdPos = true;
    } else if (cmdPos && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      out += t; // env prefix: default, still command position
    } else if (cmdPos && /^["']/.test(t)) {
      out += t; // quoted word reads as itself; the command position is spent
      cmdPos = false;
    } else if (cmdPos && !/^\s/.test(t)) {
      out += `\x1b[${red}m${t}${RESET}`;
      cmdPos = false;
    } else {
      out += t;
    }
  }
  return out;
}

export function applyToolResult(text: string, palette: ColorPalette): string {
  return applyColor(text, palette.tool_result, palette.use_colors);
}

export function applyFinalResponse(text: string, palette: ColorPalette): string {
  return applyColor(text, palette.final_response, palette.use_colors);
}

export function applyCompacting(text: string, palette: ColorPalette): string {
  return applyColor(text, palette.compacting, palette.use_colors);
}

export function applyProgress(text: string, palette: ColorPalette): string {
  return applyColor(text, palette.progress, palette.use_colors);
}
