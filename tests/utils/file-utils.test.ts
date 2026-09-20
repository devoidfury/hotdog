// Tests for utils/file-utils.ts — front matter, path-mistake correction,
// name validation, aspect loading, and the shared write-tool skeleton
// (writeWithinWorkspace / safeMkdir / detectFileStyleAt).

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
  const mod = await import("@utils/file-utils.ts");
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

// ── writeWithinWorkspace / safeMkdir / detectFileStyleAt ─────────────────────

import type { ToolContext } from "@core/extensions/types.ts";
import { PathEscapeError } from "@utils/workspace.ts";

let writeWithinWorkspace: typeof import("@utils/file-utils.ts").writeWithinWorkspace;
let safeMkdir: typeof import("@utils/file-utils.ts").safeMkdir;
let detectFileStyleAt: typeof import("@utils/file-utils.ts").detectFileStyleAt;

beforeAll(async () => {
  const mod = await import("@utils/file-utils.ts");
  writeWithinWorkspace = mod.writeWithinWorkspace;
  safeMkdir = mod.safeMkdir;
  detectFileStyleAt = mod.detectFileStyleAt;
});

const ctxWithWorkspace = (resolveSafe: (p: string) => string): ToolContext =>
  ({ get: () => ({ resolveSafe }) }) as unknown as ToolContext;

const okWriteFn = async () => {};

describe("writeWithinWorkspace", () => {
  it("rejects missing or unparseable input with the parse-error string", async () => {
    const expected = "Error parsing arguments: expected a JSON object with required 'path' and 'content' strings";
    const ctx = ctxWithWorkspace((p) => p);
    const cases: (string | Record<string, unknown> | null)[] = [
      null,
      "",
      "not json",
      {},
      { path: "a.txt" }, // content undefined
      { content: "x" }, // path missing
      { path: "", content: "x" }, // path empty
    ];
    for (const input of cases) {
      const res = await writeWithinWorkspace(input, ctx, {
        writeFn: okWriteFn, writeErrorLabel: "Write", resultKey: "bytes_written",
      });
      expect(res.success).toBe(false);
      expect(res.error).toBe(expected);
    }
  });

  it("passes a PathEscapeError message through verbatim", async () => {
    const ctx = ctxWithWorkspace(() => {
      throw new PathEscapeError("path escapes the workspace");
    });
    const res = await writeWithinWorkspace(
      { path: "../outside", content: "x" }, ctx,
      { writeFn: okWriteFn, writeErrorLabel: "Write", resultKey: "bytes_written" },
    );
    expect(res.success).toBe(false);
    expect(res.error).toBe("path escapes the workspace");
  });

  it("wraps other resolve failures", async () => {
    const ctx = ctxWithWorkspace(() => {
      throw new Error("bad symlink");
    });
    const res = await writeWithinWorkspace(
      { path: "a.txt", content: "x" }, ctx,
      { writeFn: okWriteFn, writeErrorLabel: "Write", resultKey: "bytes_written" },
    );
    expect(res.error).toBe("Error resolving path: bad symlink");
  });

  it("reports mkdir failure as a tool error", async () => {
    // dirname of the resolved path is a regular file, so mkdir fails (ENOTDIR)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-ww-mkdir-"));
    try {
      const blocker = path.join(tmpDir, "blocker");
      fs.writeFileSync(blocker, "not a dir");
      const res = await writeWithinWorkspace(
        { path: "sub/file.txt", content: "x" },
        ctxWithWorkspace(() => path.join(blocker, "sub", "file.txt")),
        { writeFn: okWriteFn, writeErrorLabel: "Write", resultKey: "bytes_written" },
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain("Error creating directory:");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("labels write failures with the tool's writeErrorLabel", async () => {
    const ctx = ctxWithWorkspace((p) => path.resolve(p));
    const res = await writeWithinWorkspace(
      { path: "a.txt", content: "x" }, ctx,
      {
        writeFn: async () => { throw new Error("disk gone"); },
        writeErrorLabel: "Error appending file",
        resultKey: "bytes_written",
      },
    );
    expect(res.error).toBe("Error appending file: disk gone");
  });

  it("writes and reports the utf-8 byte count under resultKey", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-ww-ok-"));
    try {
      let written: [string, string] | null = null;
      const res = await writeWithinWorkspace(
        { path: "nested/a.txt", content: "héllo" },
        ctxWithWorkspace((p) => path.join(tmpDir, p)),
        {
          writeFn: async (p, c) => { written = [p, c]; },
          writeErrorLabel: "Write",
          resultKey: "bytes_written",
        },
      );
      expect(res.success).toBe(true);
      expect(written).not.toBeNull();
      // parent dir is created by the helper
      expect(fs.existsSync(path.join(tmpDir, "nested"))).toBe(true);
      expect(JSON.parse(res.output)).toEqual({ path: "nested/a.txt", bytes_written: 6 }); // é is 2 bytes
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs prepareContent and counts the prepared bytes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-ww-prep-"));
    try {
      let captured = "";
      const res = await writeWithinWorkspace(
        { path: "a.txt", content: "abc" },
        ctxWithWorkspace((p) => path.join(tmpDir, p)),
        {
          writeFn: async (_p, c) => { captured = c; },
          writeErrorLabel: "Write",
          resultKey: "n",
          prepareContent: async (_p, c) => `${c}\r\n`,
        },
      );
      expect(captured).toBe("abc\r\n");
      expect(JSON.parse(res.output)).toEqual({ path: "a.txt", n: 5 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("safeMkdir", () => {
  it("creates nested dirs and returns null", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-mkdir-"));
    try {
      const target = path.join(tmpDir, "a", "b", "c");
      expect(await safeMkdir(target)).toBeNull();
      expect(fs.existsSync(target)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns a ToolResult error instead of throwing", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-mkdir-"));
    try {
      const blocker = path.join(tmpDir, "blocker");
      fs.writeFileSync(blocker, "file");
      const res = await safeMkdir(path.join(blocker, "sub"));
      expect(res).not.toBeNull();
      expect(res!.success).toBe(false);
      expect(res!.error).toContain("Error creating directory:");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("detectFileStyleAt", () => {
  it("returns null for a missing file", async () => {
    expect(await detectFileStyleAt(path.join(os.tmpdir(), "hotdog-nonexistent-9f3a", "x.txt"))).toBeNull();
  });

  it("detects BOM and CRLF from the file bytes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-style-"));
    try {
      const f = path.join(tmpDir, "crlf.txt");
      fs.writeFileSync(f, "\uFEFFone\r\ntwo\r\n");
      expect(await detectFileStyleAt(f)).toEqual({ bom: true, eol: "\r\n" });

      const lf = path.join(tmpDir, "lf.txt");
      fs.writeFileSync(lf, "one\ntwo\n");
      expect(await detectFileStyleAt(lf)).toEqual({ bom: false, eol: "\n" });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
