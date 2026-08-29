// Tests for utils/file-utils.ts — front matter, path-mistake correction,
// name validation, and aspect loading.

import { describe, it, expect, beforeAll } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const hasWarning = (warnings: string[], substring: string) =>
  warnings.some((w: string) => w.includes(substring));

// ── Dynamic imports (avoid circular deps) ────────────────────────────────────

let validateNameable: (name: string | null | undefined, label: string, dirName: string) => string[];
let parseFrontMatter: (content: string) => { frontMatter?: Record<string, unknown>; body?: string } | null;
let correctCommonPathMistakes: (strPath: string, dirPath?: string) => [string, string | undefined];
let loadAspects: (aspectNames: string[] | null, aspectsDir?: string) => Promise<{ name: string; content: string }[]>;

beforeAll(async () => {
  const mod = await import("../../src/utils/file-utils.ts");
  validateNameable = mod.validateNameable;
  parseFrontMatter = mod.parseFrontMatter;
  correctCommonPathMistakes = mod.correctCommonPathMistakes;
  loadAspects = mod.loadAspects;
});

// ── validateNameable ─────────────────────────────────────────────────────────

describe("validateNameable", () => {
  it("returns no warnings for valid names", () => {
    expect(validateNameable("my-tool", "Tool", "my-tool")).toEqual([]);
    expect(validateNameable("my-tool-name", "Tool", "my-tool-name")).toEqual([]);
    expect(validateNameable("tool-123", "Tool", "tool-123")).toEqual([]);
    expect(validateNameable("a".repeat(64), "Tool", "a".repeat(64))).toEqual([]);
  });

  it("warns for name mismatches, empty names, invalid chars, and formatting", () => {
    expect(hasWarning(validateNameable("my-tool", "Tool", "different"), "does not match")).toBe(true);
    expect(hasWarning(validateNameable("", "Tool", "my-tool"), "name is empty")).toBe(true);
    expect(hasWarning(validateNameable(null, "Tool", "my-tool"), "name is empty")).toBe(true);
    expect(hasWarning(validateNameable("MyTool", "Tool", "mytool"), "contains invalid character")).toBe(true);
    expect(hasWarning(validateNameable("my_tool", "Tool", "my-tool"), "contains invalid character")).toBe(true);
    expect(hasWarning(validateNameable("my tool", "Tool", "my-tool"), "contains invalid character")).toBe(true);
    expect(hasWarning(validateNameable("-tool", "Tool", "tool"), "must not start or end with a hyphen")).toBe(true);
    expect(hasWarning(validateNameable("tool--name", "Tool", "tool-name"), "must not contain consecutive hyphens")).toBe(true);
    expect(hasWarning(validateNameable("a".repeat(65), "Tool", "a".repeat(65)), "exceeds 64 characters")).toBe(true);
  });

  it("accumulates multiple warnings", () => {
    expect(validateNameable("-MyTool--", "Tool", "different").length).toBeGreaterThan(1);
  });
});

// ── parseFrontMatter ─────────────────────────────────────────────────────────

describe("parseFrontMatter", () => {
  it("parses valid front matter", () => {
    const result = parseFrontMatter("---\nname: test\ntype: skill\n---\n\nBody content here");
    expect(result).not.toBeNull();
    expect(result!.frontMatter).toEqual({ name: "test", type: "skill" });
    expect(result!.body).toBe("\nBody content here");
  });

  it("handles edge cases", () => {
    expect(parseFrontMatter("Just plain text")).toBeNull();
    expect(parseFrontMatter("---\n---\nBody")).toBeNull(); // no content between delimiters

    const result = parseFrontMatter("---\nname: test\n---");
    expect(result!.body).toBe("");

    const result2 = parseFrontMatter("---\n  \n---\nBody");
    expect(result2).not.toBeNull();
    expect(result2!.body).toBe("Body");
  });
});

// ── correctCommonPathMistakes ────────────────────────────────────────────────

describe("correctCommonPathMistakes", () => {
  it("fixes common path mistakes", () => {
    expect(correctCommonPathMistakes("/.")[0]).toBe("./");
    expect(correctCommonPathMistakes("/**/*")[0]).toBe("**/*");
    expect(correctCommonPathMistakes("/*")[0]).toBe("*");
    expect(correctCommonPathMistakes("**/*", "/")[1]).toBe("./");
    expect(correctCommonPathMistakes("src/core", "/project")).toEqual(["src/core", "/project"]);
  });
});


// ── loadAspects ──────────────────────────────────────────────────────────────

describe("loadAspects", () => {
  it("returns empty array for null/empty/non-existent aspects", async () => {
    expect(await loadAspects(null)).toEqual([]);
    expect(await loadAspects([])).toEqual([]);
    expect(await loadAspects(["nonexistent-aspect"], "/tmp/nonexistent-dir")).toEqual([]);
  });

  it("loads existing aspect files", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-aspect-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "coding.aspect.md"), "# Coding aspect\n\nSome content");
      const result = await loadAspects(["coding"], tmpDir);
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("coding");
      expect(result[0]!.content).toContain("Coding aspect");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips empty aspect files", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-aspect-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "empty.aspect.md"), "   ");
      expect(await loadAspects(["empty"], tmpDir)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
