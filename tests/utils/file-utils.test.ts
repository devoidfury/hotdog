// Tests for utils/file-utils.ts — path validation, file I/O, front matter,
// name validation, permission checks, and aspect loading.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const hasWarning = (warnings: string[], substring: string) =>
  warnings.some((w: string) => w.includes(substring));

// ── Dynamic imports (avoid circular deps) ────────────────────────────────────

let validateNameable: (name: string | null | undefined, label: string, dirName: string) => string[];
let parseFrontMatter: (content: string) => { frontMatter?: Record<string, unknown>; body?: string } | null;
let IOError: any;
let correctCommonPathMistakes: (strPath: string, dirPath?: string) => [string, string | undefined];
let loadAspects: (aspectNames: string[] | null, aspectsDir?: string) => Promise<{ name: string; content: string }[]>;
let writeFileWithParents: (filePath: string, content: string | Uint8Array) => Promise<void>;
let fileSize: (filePath: string) => Promise<number>;
let checkWritable: (filePath: string) => Promise<boolean>;
let checkReadable: (filePath: string) => Promise<boolean>;

beforeAll(async () => {
  const mod = await import("../../src/utils/file-utils.ts");
  validateNameable = mod.validateNameable;
  parseFrontMatter = mod.parseFrontMatter;
  IOError = mod.IOError;
  correctCommonPathMistakes = mod.correctCommonPathMistakes;
  loadAspects = mod.loadAspects;
  writeFileWithParents = mod.writeFileWithParents;
  fileSize = mod.fileSize;
  checkWritable = mod.checkWritable;
  checkReadable = mod.checkReadable;
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

// ── IOError ──────────────────────────────────────────────────────────────────

describe("IOError", () => {
  it("creates errors with correct messages", () => {
    expect(IOError.PathNotFound("/some/path").message).toContain("Path not found");
    expect(IOError.PathOutside("/etc/passwd", "/project").message).toContain("/etc/passwd");
    expect(IOError.NotWritable("/dir", "permission denied").message).toContain("permission denied");
    expect(IOError.NotReadable("/file.txt").message).toContain("/file.txt");
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

// ── writeFileWithParents ─────────────────────────────────────────────────────

describe("writeFileWithParents", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-test-writefile-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes file and creates parent dirs", async () => {
    const filePath = path.join(tmpDir, "a", "b", "c", "test.txt");
    await writeFileWithParents(filePath, "content");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("content");
  });

  it("overwrites existing file", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await writeFileWithParents(filePath, "v1");
    await writeFileWithParents(filePath, "v2");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("v2");
  });
});


// ── fileSize ─────────────────────────────────────────────────────────────────

describe("fileSize", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-test-size-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns file size in bytes", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "hello world");
    const size = await fileSize(filePath);
    expect(size).toBe(11);
  });
});

// ── checkWritable ────────────────────────────────────────────────────────────

describe("checkWritable", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-test-writable-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true for writable file", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "data");
    expect(await checkWritable(filePath)).toBe(true);
  });

  it("returns true for new file in writable dir", async () => {
    const filePath = path.join(tmpDir, "new-file.txt");
    expect(await checkWritable(filePath)).toBe(true);
  });

  it("throws for unwritable directory", async () => {
    const roDir = path.join(tmpDir, "readonly");
    fs.mkdirSync(roDir, { recursive: true });
    fs.chmodSync(roDir, 0o555);
    const filePath = path.join(roDir, "test.txt");
    await expect(checkWritable(filePath)).rejects.toThrow("not writable");
    fs.chmodSync(roDir, 0o755);
  });

  it("returns true for existing read-only file (parent dir is writable)", async () => {
    const filePath = path.join(tmpDir, "readonly-file.txt");
    fs.writeFileSync(filePath, "data");
    fs.chmodSync(filePath, 0o444);
    expect(await checkWritable(filePath)).toBe(true);
    fs.chmodSync(filePath, 0o644);
  });
});

// ── checkReadable ────────────────────────────────────────────────────────────

describe("checkReadable", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-test-readable-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true for readable file", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "data");
    expect(await checkReadable(filePath)).toBe(true);
  });

  it("throws for non-existent path", async () => {
    await expect(checkReadable("/nonexistent/path/file.txt")).rejects.toThrow(
      "does not exist",
    );
  });

  it("throws for unreadable file", async () => {
    const filePath = path.join(tmpDir, "no-read.txt");
    fs.writeFileSync(filePath, "data");
    fs.chmodSync(filePath, 0o000);
    await expect(checkReadable(filePath)).rejects.toThrow("not readable");
    fs.chmodSync(filePath, 0o644);
  });
});
