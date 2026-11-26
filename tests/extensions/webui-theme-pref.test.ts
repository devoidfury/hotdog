// Theme preference + built-in registry + custom themes (ui/theme-pref.ts)
// against fake Storage and a fake documentElement -- no mock.module. Plus
// the CSS-shape pins: the two built-in palettes must live where the token
// split says they live (hotdog = bare :root default, purple = the purple
// block), the registry's swatch mirror must match the CSS bytes verbatim,
// and no accent rgba may leak outside a theme rule.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_THEME_ID,
  EDITABLE_TOKENS,
  THEME_CUSTOM_STORAGE_KEY,
  THEME_REGISTRY,
  THEME_STORAGE_KEY,
  THEME_VARS,
  accentDerivedTokens,
  applyStoredTheme,
  applyThemeId,
  clearInlineTheme,
  inkForAccent,
  labelForTheme,
  loadCustomThemes,
  loadThemeId,
  newThemeId,
  paletteOf,
  resolveTheme,
  saveCustomThemes,
  saveThemeId,
  themeChoices,
  writeInlineTheme,
  type ThemeColors,
  type ThemeRoot,
  type WebUITheme,
} from "@extensions/webui/ui/theme-pref.ts";
import type { DraftStorage } from "@extensions/webui/ui/draft.ts";

class FakeStorage implements DraftStorage {
  readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class ThrowingStorage implements DraftStorage {
  getItem(): string | null {
    throw new Error("SecurityError: storage access denied");
  }
  setItem(): void {
    throw new Error("SecurityError: storage access denied");
  }
  removeItem(): void {
    throw new Error("SecurityError: storage access denied");
  }
}

class FakeRoot implements ThemeRoot {
  readonly attrs = new Map<string, string>();
  readonly props = new Map<string, string>();
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  style = {
    setProperty: (name: string, value: string) => {
      this.props.set(name, value);
    },
    removeProperty: (name: string) => {
      this.props.delete(name);
    },
  };
}

/** A complete custom palette with one obvious variation per token group. */
function customColors(over: ThemeColors = {}): ThemeColors {
  const colors: ThemeColors = {};
  for (const t of EDITABLE_TOKENS) colors[t.name] = "#202020";
  colors["--accent"] = "#00ff00";
  return { ...colors, ...over };
}

const CUSTOM_KEY = THEME_CUSTOM_STORAGE_KEY;

describe("loadThemeId", () => {
  it("no stored key means the default palette", () => {
    expect(loadThemeId(new FakeStorage())).toBe(DEFAULT_THEME_ID);
  });

  it("round-trips the stored id under the house key", () => {
    // "purple" is the NON-default id: a round-trip of the default would
    // barely differ from the no-key case.
    const s = new FakeStorage();
    saveThemeId("purple", s);
    expect(s.map.get(THEME_STORAGE_KEY)).toBe("purple");
    expect(loadThemeId(s)).toBe("purple");
  });

  it("garbage and unknown ids fall back to the default", () => {
    const s = new FakeStorage();
    for (const junk of ["beige", "1", "", "   ", "PURPLE", "HOTDOG", JSON.stringify({ id: "hotdog" })]) {
      s.map.set(THEME_STORAGE_KEY, junk);
      expect(loadThemeId(s)).toBe(DEFAULT_THEME_ID);
    }
  });

  it("a stored CUSTOM id is valid only while its entry is still in storage", () => {
    const s = new FakeStorage();
    saveCustomThemes([{ id: "forest", label: "Forest", colors: customColors(), builtIn: false }], s);
    saveThemeId("forest", s);
    expect(loadThemeId(s)).toBe("forest");
    saveCustomThemes([], s); // deleted elsewhere: the id degrades, not strands
    expect(loadThemeId(s)).toBe(DEFAULT_THEME_ID);
  });

  it("a throwing storage degrades to the default and never propagates", () => {
    expect(loadThemeId(new ThrowingStorage())).toBe(DEFAULT_THEME_ID);
    expect(() => saveThemeId("hotdog", new ThrowingStorage())).not.toThrow();
    expect(loadCustomThemes(new ThrowingStorage())).toEqual([]);
    expect(() => saveCustomThemes([], new ThrowingStorage())).not.toThrow();
  });

  it("even ACCESSING window.localStorage may throw without breaking the read", () => {
    const win = window as unknown as { localStorage?: unknown };
    const prev = win.localStorage;
    try {
      Object.defineProperty(win, "localStorage", {
        configurable: true,
        get() {
          throw new Error("SecurityError: access denied");
        },
      });
      expect(loadThemeId()).toBe(DEFAULT_THEME_ID);
      expect(() => saveThemeId("hotdog")).not.toThrow();
      expect(() => applyStoredTheme()).not.toThrow();
    } finally {
      Object.defineProperty(win, "localStorage", { configurable: true, writable: true, value: prev });
    }
  });
});

describe("registry", () => {
  it("the first entry is the default and ids are unique", () => {
    expect(THEME_REGISTRY[0]!.id).toBe(DEFAULT_THEME_ID);
    expect(new Set(THEME_REGISTRY.map((t) => t.id)).size).toBe(THEME_REGISTRY.length);
  });

  it("every built-in palette is complete over the editable tokens", () => {
    for (const theme of THEME_REGISTRY) {
      expect(theme.builtIn).toBe(true);
      for (const token of EDITABLE_TOKENS) {
        expect(theme.colors[token.name]).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(Object.keys(theme.colors).length).toBe(EDITABLE_TOKENS.length);
    }
  });

  it("every registry entry renders once a block ships for it (data-driven check)", () => {
    // The recipe promises one CSS block per id; drive that off the registry
    // itself so a new entry without a block fails here, not on a blank tab.
    const css = readFileSync(
      join(import.meta.dir, "../../src/extensions/webui/ui/styles.css"),
      "utf8",
    );
    for (const theme of THEME_REGISTRY) {
      if (theme.id === DEFAULT_THEME_ID) continue; // bare :root, no attribute
      expect(css).toContain(`:root[data-theme="${theme.id}"]`);
    }
  });

  it("THEME_VARS is the 17 editable tokens plus the accent and status derivatives", () => {
    expect(THEME_VARS).toEqual([
      ...EDITABLE_TOKENS.map((t) => t.name),
      "--accent-hover",
      "--accent-active",
      "--accent-soft",
      "--accent-glow",
      "--success-soft",
      "--error-soft",
    ]);
  });

  it("labels come from the registry, unknown ids show the default's label", () => {
    expect(labelForTheme("hotdog")).toBe("Hotdog");
    expect(labelForTheme("ghost")).toBe(labelForTheme(DEFAULT_THEME_ID));
  });

  it("labels resolve customs from storage; choices are built-ins then customs", () => {
    const s = new FakeStorage();
    saveCustomThemes([{ id: "forest", label: "Forest", colors: customColors(), builtIn: false }], s);
    expect(labelForTheme("forest", s)).toBe("Forest");
    expect(themeChoices(s).map((t) => t.id)).toEqual(["hotdog", "purple", "forest"]);
    expect(themeChoices(new FakeStorage()).map((t) => t.id)).toEqual(["hotdog", "purple"]);
  });
});

describe("custom theme storage", () => {
  it("round-trips a saved palette through the house key", () => {
    const s = new FakeStorage();
    const theme: WebUITheme = { id: "forest", label: "Forest", colors: customColors(), builtIn: false };
    saveCustomThemes([theme], s);
    const back = loadCustomThemes(s);
    expect(back.length).toBe(1);
    expect(back[0]!.id).toBe("forest");
    expect(back[0]!.builtIn).toBe(false);
    expect(back[0]!.colors).toEqual(theme.colors);
  });

  it("a palette missing the status slots falls back to the default's values", () => {
    // The status hues joined the set after the storage shape shipped; an
    // older (or hand-written) palette without them loads whole.
    const partial = customColors();
    delete partial["--success"];
    delete partial["--warning"];
    delete partial["--error"];
    const s = new FakeStorage();
    s.map.set(CUSTOM_KEY, JSON.stringify([{ id: "forest", label: "Forest", colors: partial }]));
    const back = loadCustomThemes(s);
    expect(back.length).toBe(1);
    expect(back[0]!.colors["--success"]).toBe(THEME_REGISTRY[0]!.colors["--success"]);
    expect(back[0]!.colors["--warning"]).toBe(THEME_REGISTRY[0]!.colors["--warning"]);
    expect(back[0]!.colors["--error"]).toBe(THEME_REGISTRY[0]!.colors["--error"]);
  });

  it("unreadable JSON is the empty list, never a throw", () => {
    const s = new FakeStorage();
    for (const junk of ["{", "null", '"forest"', "[", "{}", "42"]) {
      s.map.set(CUSTOM_KEY, junk);
      expect(loadCustomThemes(s)).toEqual([]);
    }
  });

  it("a bad entry drops alone; its good neighbors survive", () => {
    const s = new FakeStorage();
    const good = { id: "forest", label: "Forest", colors: customColors() };
    s.map.set(
      CUSTOM_KEY,
      JSON.stringify([
        good,
        { id: "BrOken", label: "uppercase id", colors: customColors() },
        { id: "purple", label: "shadowing a built-in", colors: customColors() },
        { id: "forest", label: "duplicate id", colors: customColors() },
        { id: "no-colors", label: "no palette" },
        { id: "bad-hex", label: "one bad token", colors: { ...customColors(), "--accent": "red" } },
        { id: "missing-token", label: "incomplete", colors: { "--bg-canvas": "#010203" } },
        { id: "", label: "empty id", colors: customColors() },
        { id: "ok2", label: "  Padded  ", colors: { ...customColors(), "--text-muted": "#A9A9A9" } },
      ]),
    );
    const themes = loadCustomThemes(s);
    expect(themes.map((t) => t.id)).toEqual(["forest", "ok2"]);
    expect(themes[1]!.label).toBe("Padded");
    expect(themes[1]!.colors["--text-muted"]).toBe("#a9a9a9"); // normalized lowercase
  });

  it("ids follow the slug rule: dots, spaces and quotes never reach storage-read ids", () => {
    expect(newThemeId("My Cool Theme!", [])).toBe("my-cool-theme");
    expect(newThemeId("  --Weird/../Id--  ", [])).toBe("weird-id");
    expect(newThemeId("!!!", [])).toBe("theme"); // all-punctuation still slugs
    expect(newThemeId("forest", ["forest", "theme"])).toBe("forest-2");
    expect(newThemeId("forest", ["forest", "forest-2"])).toBe("forest-3");
    expect(newThemeId("a".repeat(50), [])).toBe("a".repeat(32));
  });

  it("labels resolve, palettes resolve, unresolvable ids get the default palette", () => {
    const s = new FakeStorage();
    const colors = customColors();
    saveCustomThemes([{ id: "forest", label: "Forest", colors, builtIn: false }], s);
    expect(resolveTheme("forest", s)!.colors).toEqual(colors);
    expect(paletteOf("forest", s)).toEqual(colors);
    expect(paletteOf("purple", s)).toEqual(THEME_REGISTRY[1]!.colors);
    expect(paletteOf("ghost", s)).toEqual(THEME_REGISTRY[0]!.colors);
  });
});

describe("accent derivation", () => {
  it("the ink rule reproduces the committed built-in choices", () => {
    // hotdog's mustard is bright -> dark ink; purple is dark -> white.
    expect(inkForAccent("#e0a32e")).toBe("#161312");
    expect(inkForAccent("#7c5cff")).toBe("#ffffff");
  });

  it("an accent pick yields the four derived slots", () => {
    const d = accentDerivedTokens("#00ff00");
    expect(Object.keys(d).sort()).toEqual([
      "--accent-active",
      "--accent-glow",
      "--accent-hover",
      "--accent-soft",
    ]);
    expect(d["--accent-hover"]).toBe("#00db00"); // 255*0.86 rounded
    expect(d["--accent-active"]).toBe("#00b800"); // 255*0.72 rounded
    expect(d["--accent-soft"]).toBe("rgba(0, 255, 0, 0.12)");
    expect(d["--accent-glow"]).toBe("rgba(0, 255, 0, 0.25)");
  });
});

describe("applyThemeId / applyStoredTheme", () => {
  it("the default REMOVES the attribute (the committed bare-:root look)", () => {
    const root = new FakeRoot();
    root.attrs.set("data-theme", "purple");
    applyThemeId(DEFAULT_THEME_ID, root);
    expect(root.attrs.has("data-theme")).toBe(false);
  });

  it("a non-default BUILT-IN id sets data-theme and leaves the sheet in charge", () => {
    const root = new FakeRoot();
    applyThemeId("purple", root);
    expect(root.attrs.get("data-theme")).toBe("purple");
    expect(root.props.size).toBe(0); // no inline vars: the CSS block renders
  });

  it("a custom theme sets its id AND writes its palette inline (derivatives included)", () => {
    const s = new FakeStorage();
    saveCustomThemes([{ id: "forest", label: "Forest", colors: customColors(), builtIn: false }], s);
    const root = new FakeRoot();
    // Fake storage is not window.localStorage; resolve inline via storage read:
    // applyThemeId reads the DEFAULT storage, so seed the browser store for this one.
    const win = window as unknown as { localStorage: DraftStorage };
    const prev = win.localStorage;
    try {
      win.localStorage = s;
      applyThemeId("forest", root);
    } finally {
      win.localStorage = prev;
    }
    expect(root.attrs.get("data-theme")).toBe("forest");
    expect(root.props.get("--bg-canvas")).toBe("#202020");
    expect(root.props.get("--accent")).toBe("#00ff00");
    expect(root.props.get("--accent-hover")).toBe("#00db00");
    expect(root.props.get("--accent-soft")).toBe("rgba(0, 255, 0, 0.12)");
    expect(root.props.size).toBe(THEME_VARS.length);
  });

  it("switching to a built-in lifts the custom inline palette off the root", () => {
    const root = new FakeRoot();
    writeInlineTheme(customColors(), root);
    expect(root.props.size).toBeGreaterThan(0);
    applyThemeId("purple", root);
    expect(root.props.size).toBe(0);
    applyThemeId(DEFAULT_THEME_ID, root);
    expect(root.props.size).toBe(0);
    expect(root.attrs.has("data-theme")).toBe(false);
  });

  it("writeInlineTheme skips garbage tokens instead of writing them", () => {
    const root = new FakeRoot();
    writeInlineTheme({ "--bg-canvas": "red", "--accent": "#0000ff" } as ThemeColors, root);
    expect(root.props.has("--bg-canvas")).toBe(false);
    expect(root.props.get("--accent")).toBe("#0000ff");
    clearInlineTheme(root);
    expect(root.props.size).toBe(0);
  });

  it("writeInlineTheme derives the status washes from the palette's hues", () => {
    const root = new FakeRoot();
    writeInlineTheme(customColors({ "--success": "#00ff00", "--error": "#ff0000" }), root);
    expect(root.props.get("--success-soft")).toBe("rgba(0, 255, 0, 0.12)");
    expect(root.props.get("--error-soft")).toBe("rgba(255, 0, 0, 0.12)");
    clearInlineTheme(root);
  });

  it("an id nothing resolves to renders the default (a custom deleted elsewhere)", () => {
    const root = new FakeRoot();
    root.attrs.set("data-theme", "forest");
    applyThemeId("forest", root); // storage ships no such theme
    expect(root.attrs.has("data-theme")).toBe(false);
    expect(root.props.size).toBe(0);
  });

  it("a boot with the pref stored applies it; no pref clears the attribute", () => {
    const s = new FakeStorage();
    const root = new FakeRoot();
    s.map.set(THEME_STORAGE_KEY, "purple");
    expect(applyStoredTheme(s, root)).toBe("purple");
    expect(root.attrs.get("data-theme")).toBe("purple");

    s.map.set(THEME_STORAGE_KEY, "beige"); // garbage: hotdog-default path
    expect(applyStoredTheme(s, root)).toBe(DEFAULT_THEME_ID);
    expect(root.attrs.has("data-theme")).toBe(false);

    s.map.clear();
    root.attrs.set("data-theme", "purple");
    expect(applyStoredTheme(s, root)).toBe(DEFAULT_THEME_ID);
    expect(root.attrs.has("data-theme")).toBe(false);
  });
});

describe("index.html pre-paint theme script (zero-flash)", () => {
  const html = readFileSync(
    join(import.meta.dir, "../../src/extensions/webui/ui/index.html"),
    "utf8",
  );

  it("the inline script mirrors the module: keys, default id, data-theme call", () => {
    // The pre-paint copy lives outside the module, so these strings are the
    // ONLY link between the two halves. Drift in either direction -- the
    // module renames a key, the inline copy stops matching the default --
    // reads red here (both sides ride the module's exported constants).
    expect(html).toContain(`"${THEME_STORAGE_KEY}"`);
    expect(html).toContain(`"${CUSTOM_KEY}"`);
    expect(html).toContain(`"${DEFAULT_THEME_ID}"`);
    expect(html).toContain('setAttribute("data-theme"');
    // Custom palettes land inline before first paint, names/values re-checked.
    expect(html).toContain("setProperty");
    expect(html).toContain("--accent-hover");
  });

  it("the script sits in the head, before any body content", () => {
    // The whole point is ZERO FLASH: the stored palette must land on <html>
    // before the browser has anything to paint -- a script relocated below
    // <body> must fail these order pins.
    const headEnd = html.indexOf("</head>");
    const bodyStart = html.indexOf("<body");
    expect(headEnd).toBeGreaterThan(-1);
    expect(bodyStart).toBeGreaterThan(headEnd);
    expect(html.indexOf(THEME_STORAGE_KEY)).toBeLessThan(headEnd);
    expect(html.indexOf(CUSTOM_KEY)).toBeLessThan(headEnd);
    expect(html.indexOf('setAttribute("data-theme"')).toBeLessThan(headEnd);
  });
});

describe("styles.css token split", () => {
  const css = readFileSync(
    join(import.meta.dir, "../../src/extensions/webui/ui/styles.css"),
    "utf8",
  );
  const ruleRange = (open: string): [number, number] => {
    const start = css.indexOf(open);
    if (start < 0) throw new Error(`missing rule: ${open}`);
    const end = css.indexOf("\n}", start);
    return [start, end < 0 ? css.length : end];
  };
  const [rootStart, rootEnd] = ruleRange(":root {");
  const [purpleStart, purpleEnd] = ruleRange(':root[data-theme="purple"] {');

  it("the registry swatch mirror matches the CSS blocks verbatim", () => {
    // THEME_REGISTRY.colors feeds the editor's swatches; the page renders
    // from these blocks. If the two drift, a swatch LIES -- so every
    // editable token of every built-in is pinned against its block bytes.
    const blocks: Record<string, string> = {
      hotdog: css.slice(rootStart, rootEnd),
      purple: css.slice(purpleStart, purpleEnd),
    };
    for (const theme of THEME_REGISTRY) {
      const block = blocks[theme.id];
      expect(block).toBeDefined();
      for (const token of EDITABLE_TOKENS) {
        expect(block).toContain(`${token.name}: ${theme.colors[token.name]}`);
      }
    }
  });

  it("the purple values do NOT sit in the bare :root", () => {
    const root = css.slice(rootStart, rootEnd);
    expect(root).not.toContain("124, 92, 255");
    expect(root).not.toContain("#7c5cff");
  });

  it("no literal accent rgba survives outside a theme rule", () => {
    // The .compacting and .system-message tints now ride color-mix over
    // var(--accent).
    const leaked: string[] = [];
    const re = /rgba\((?:124, 92, 255|224, 163, 46)/g;
    for (let m = re.exec(css); m; m = re.exec(css)) {
      const i = m.index;
      const inRoot = i >= rootStart && i <= rootEnd;
      const inPurple = i >= purpleStart && i <= purpleEnd;
      if (!inRoot && !inPurple) leaked.push(css.slice(i, css.indexOf(";", i)));
    }
    expect(leaked).toEqual([]);
    expect(css).toContain("color-mix(in srgb, var(--accent) 15%, transparent)");
    expect(css).toContain("color-mix(in srgb, var(--accent) 40%, transparent)");
  });
});
