// Theme preference + registry (ui/theme-pref.ts) against fake Storage and a
// fake documentElement -- no mock.module. Plus the CSS-shape pins: the two
// palettes must live where the token split says they live (hotdog = bare
// :root default, purple = the purple block) and no accent rgba may leak
// outside a theme rule.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_THEME_ID,
  saveThemeId,
  THEME_REGISTRY,
  THEME_STORAGE_KEY,
  applyStoredTheme,
  applyThemeId,
  labelForTheme,
  loadThemeId,
  nextThemeId,
  type ThemeRoot,
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
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
}

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

  it("a throwing storage degrades to the default and never propagates", () => {
    expect(loadThemeId(new ThrowingStorage())).toBe(DEFAULT_THEME_ID);
    expect(() => saveThemeId("hotdog", new ThrowingStorage())).not.toThrow();
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

describe("registry cycle", () => {
  it("the first entry is the default and ids are unique", () => {
    expect(THEME_REGISTRY[0]!.id).toBe(DEFAULT_THEME_ID);
    expect(new Set(THEME_REGISTRY.map((t) => t.id)).size).toBe(THEME_REGISTRY.length);
  });

  it("clicks cycle in registry order and wrap", () => {
    expect(nextThemeId("hotdog")).toBe("purple");
    expect(nextThemeId("purple")).toBe("hotdog");
    // An id outside the registry (a theme deleted since the last visit)
    // resumes at the default rather than stranding the cycle.
    expect(nextThemeId("ghost")).toBe(DEFAULT_THEME_ID);
  });

  it("labels come from the registry, unknown ids show the default's label", () => {
    expect(labelForTheme("hotdog")).toBe("Hotdog");
    expect(labelForTheme("ghost")).toBe(labelForTheme(DEFAULT_THEME_ID));
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
});

describe("index.html pre-paint theme script (zero-flash)", () => {
  const html = readFileSync(
    join(import.meta.dir, "../../src/extensions/webui/ui/index.html"),
    "utf8",
  );

  it("the inline script mirrors the module: storage key, default id, data-theme call", () => {
    // The pre-paint copy lives outside the module, so these strings are the
    // ONLY link between the two halves. Drift in either direction -- the
    // module renames the key, the inline copy stops matching the default --
    // reads red here (both sides ride the module's exported constants).
    expect(html).toContain(`"${THEME_STORAGE_KEY}"`);
    expect(html).toContain(`"${DEFAULT_THEME_ID}"`);
    expect(html).toContain('setAttribute("data-theme"');
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
    expect(html.indexOf('setAttribute("data-theme"')).toBeLessThan(headEnd);
  });
});

describe("applyThemeId / applyStoredTheme", () => {
  it("the default REMOVES the attribute (the committed bare-:root look)", () => {
    const root = new FakeRoot();
    root.attrs.set("data-theme", "purple");
    applyThemeId(DEFAULT_THEME_ID, root);
    expect(root.attrs.has("data-theme")).toBe(false);
  });

  it("a non-default id sets data-theme to the registry id", () => {
    const root = new FakeRoot();
    applyThemeId("purple", root);
    expect(root.attrs.get("data-theme")).toBe("purple");
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

  it("the bare :root carries the hotdog default palette verbatim", () => {
    // Hotdog is the zero-choice default: the mustard values live in the
    // bare :root.
    const root = css.slice(rootStart, rootEnd);
    expect(root).toContain("--accent: #e0a32e");
    expect(root).toContain("--bg-base: #0f0e0d");
    expect(root).toContain("--text-inverse: #161312");
    expect(root).toContain("--border: #38302a");
  });

  it("the purple block carries the committed HEAD palette verbatim", () => {
    // Purple is now the attribute-selected alternative, not the bare-:root
    // look.
    const pp = css.slice(purpleStart, purpleEnd);
    for (const token of [
      "--accent: #7c5cff",
      "--accent-hover: #6b4de0",
      "--accent-active: #5a3dc4",
      "--accent-soft: rgba(124, 92, 255, 0.12)",
      "--accent-glow: rgba(124, 92, 255, 0.25)",
      "--text-inverse: #ffffff",
      "--bg-base: #0d0d0f",
      "--text-primary: #e8e8ed",
      "--text-secondary: #9a9ab0",
      "--border: #2a2a38",
      "--border-light: #36364a",
    ]) {
      expect(pp).toContain(token);
    }
    // The purple values must NOT sit in the bare :root anymore.
    expect(css.slice(rootStart, rootEnd)).not.toContain("124, 92, 255");
    expect(css.slice(rootStart, rootEnd)).not.toContain("#7c5cff");
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
