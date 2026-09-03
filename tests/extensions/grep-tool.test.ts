import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fsSync from "node:fs";
import path from "node:path";
import { GrepTool, grepNative } from "../../src/extensions/core-tools/grep.ts";
import { resultStr, getDisplay, tmpDir, toolCtx, cleanupDir } from "../helpers.ts";

let dir: string;

beforeAll(() => {
  dir = tmpDir();
});

afterAll(() => {
  cleanupDir(dir);
});

describe("GrepTool.toToolDef", () => {
  it("returns a tool definition with correct name", () => {
    const def = new GrepTool({ maxResults: 100, maxOutputLines: 600 }).toToolDef();
    expect(def.type).toBe("function");
    expect(def.function.name).toBe("grep");
  });

  it("requires only pattern", () => {
    const def = new GrepTool({ maxResults: 100, maxOutputLines: 600 }).toToolDef();
    expect(def.function.parameters.required).toEqual(["pattern"]);
  });
});

describe("GrepTool.callDisplay", () => {
  it("shows pattern and path", () => {
    const display = new GrepTool({ maxResults: 100, maxOutputLines: 600 }).callDisplay({
      pattern: "hello",
      path: "src",
    });
    expect(display).toBe("'hello' in src");
  });

  it("shows dot for default path", () => {
    const display = new GrepTool({ maxResults: 100, maxOutputLines: 600 }).callDisplay({ pattern: "foo" });
    expect(display).toBe("'foo' in .");
  });

  it("handles invalid input gracefully", () => {
    expect(new GrepTool({ maxResults: 100, maxOutputLines: 600 }).callDisplay("not json")).toBe("not json");
    expect(new GrepTool({ maxResults: 100, maxOutputLines: 600 }).callDisplay({})).toBe("");
    expect(new GrepTool({ maxResults: 100, maxOutputLines: 600 }).callDisplay(null)).toBe("");
  });
});

describe("GrepTool.execute", () => {
  it("finds matches in files", async () => {
    fsSync.writeFileSync(
      path.join(dir, "hello.js"),
      'console.log("hello world")',
    );
    fsSync.writeFileSync(path.join(dir, "other.js"), 'console.log("goodbye")');

    const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
    const result = getDisplay(
      await tool.execute({ pattern: "hello", path: dir }, toolCtx()),
    );

    expect(resultStr(result)).toContain("hello.js");
    expect(resultStr(result)).toContain("hello world");
  });

  it("finds regex matches", async () => {
    fsSync.writeFileSync(
      path.join(dir, "test.py"),
      "item1 = 1\nitem2 = 2\nfoo = 3",
    );

    const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
    const result = getDisplay(
      await tool.execute({ pattern: "item\\d+", path: dir }, toolCtx()),
    );

    expect(resultStr(result)).toContain("test.py");
    expect(resultStr(result)).toContain("item1");
    expect(resultStr(result)).toContain("item2");
  });

  it("is case-sensitive by default", async () => {
    fsSync.writeFileSync(path.join(dir, "case.js"), "HelloCase sensitive");

    const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
    const result = getDisplay(
      await tool.execute({ pattern: "hellocase", path: dir }, toolCtx()),
    );

    expect(resultStr(result)).toContain("No matches found");
  });

  it("matches case-insensitively with ignore_case", async () => {
    fsSync.writeFileSync(path.join(dir, "case.js"), "HelloCase sensitive");

    const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
    const result = getDisplay(
      await tool.execute({ pattern: "hellocase", path: dir, ignore_case: true }, toolCtx()),
    );

    expect(resultStr(result)).toContain("HelloCase");
  });

  it("filters by file type", async () => {
    fsSync.writeFileSync(path.join(dir, "test.js"), "hello world");
    fsSync.writeFileSync(path.join(dir, "test.py"), "hello world");
    fsSync.writeFileSync(path.join(dir, "test.txt"), "hello world");

    const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
    const result = getDisplay(
      await tool.execute(
        { pattern: "hello", path: dir, type: "py" },
        toolCtx(),
      ),
    );

    expect(resultStr(result)).toContain("test.py");
    expect(result).not.toContain("test.js");
    expect(result).not.toContain("test.txt");
  });

  it("respects max_results", async () => {
    for (let i = 0; i < 10; i++) {
      fsSync.writeFileSync(
        path.join(dir, `file${i}.js`),
        `line with hello ${i}`,
      );
    }

    const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
    const result = getDisplay(
      await tool.execute(
        { pattern: "hello", path: dir, max_results: 3 },
        toolCtx(),
      ),
    );

    // Should have at most 3 results
    const lines = result.split("\n").filter((l) => l.includes("file"));
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it("returns no matches when nothing found", async () => {
    fsSync.writeFileSync(path.join(dir, "file.txt"), "hello world");

    const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
    const result = getDisplay(
      await tool.execute({ pattern: "zzzznotfound", path: dir }, toolCtx()),
    );

    expect(resultStr(result)).toContain("No matches found");
  });

  it("throws AssistantRetryableError on invalid regex", async () => {
    const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
    await expect(
      tool.execute({ pattern: "[invalid", path: dir }, toolCtx())
    ).rejects.toThrow(/Invalid regex/);
  });

  it("returns error on invalid JSON input", async () => {
    const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
    const result = getDisplay(await tool.execute("not json", toolCtx()));
    expect(resultStr(result)).toContain("Error parsing arguments");
  });

  it("returns error on missing pattern", async () => {
    const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
    const result = getDisplay(await tool.execute({ path: "." }, toolCtx()));
    expect(resultStr(result)).toContain("Error parsing arguments");
  });

  it("handles input as string JSON", async () => {
    fsSync.writeFileSync(path.join(dir, "file.js"), "hello world");

    const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
    const result = getDisplay(
      await tool.execute(
        JSON.stringify({ pattern: "hello", path: dir }),
        toolCtx(),
      ),
    );

    expect(resultStr(result)).toContain("file.js");
    expect(resultStr(result)).toContain("hello world");
  });

  it("searches recursively", async () => {
    fsSync.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fsSync.writeFileSync(path.join(dir, "root.js"), "hello");
    fsSync.writeFileSync(path.join(dir, "sub", "nested.js"), "hello");

    const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
    const result = getDisplay(
      await tool.execute({ pattern: "hello", path: dir }, toolCtx()),
    );

    expect(resultStr(result)).toContain("root.js");
    expect(resultStr(result)).toContain("nested.js");
  });
});

describe("GrepTool.execute — native fallback (no rg on PATH)", () => {
  // rg/fd are present in most dev environments, so execute() never reaches
  // the native walker. Hide rg via PATH to exercise isBinary() + grepNative.
  async function runNative(tool: GrepTool, args: Record<string, unknown>): Promise<string> {
    const oldPath = process.env.PATH;
    const emptyBin = tmpDir("hotdog-empty-bin-");
    process.env.PATH = emptyBin;
    try {
      const result = getDisplay(await tool.execute(args, toolCtx()));
      return resultStr(result);
    } finally {
      process.env.PATH = oldPath;
      cleanupDir(emptyBin);
    }
  }

  it("skips binary files and searches text files", async () => {
    const dir2 = tmpDir();
    try {
      // NUL byte within the first 512 bytes -> binary
      fsSync.writeFileSync(
        path.join(dir2, "data.bin"),
        Buffer.concat([Buffer.from("hello"), Buffer.from([0]), Buffer.from("hello")]),
      );
      fsSync.writeFileSync(path.join(dir2, "notes.txt"), "hello plain text");

      const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
      const output = await runNative(tool, { pattern: "hello", path: dir2 });

      expect(output).toContain("notes.txt");
      expect(output).not.toContain("data.bin");
    } finally {
      cleanupDir(dir2);
    }
  });

  it("treats a NUL past byte 512 as text (only the first 512 bytes are probed)", async () => {
    const dir2 = tmpDir();
    try {
      const buf = Buffer.alloc(600);
      buf.fill(0x61, 0, 599); // 'a' x 599, then a NUL at byte 599
      buf[599] = 0;
      fsSync.writeFileSync(path.join(dir2, "sparse.bin"), buf);

      const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
      const output = await runNative(tool, { pattern: "a", path: dir2 });

      expect(output).toContain("sparse.bin");
    } finally {
      cleanupDir(dir2);
    }
  });
});

describe("GrepTool.execute — context and truncation", () => {
  // rg is present in most dev environments; hide it via PATH to also cover
  // the native walker (same behavior is now expected from both paths).
  async function runWith(tool: GrepTool, args: Record<string, unknown>, hideRg: boolean) {
    const oldPath = process.env.PATH;
    const emptyBin = hideRg ? tmpDir("hotdog-empty-bin-") : null;
    if (emptyBin) process.env.PATH = emptyBin;
    try {
      return await tool.execute(args, toolCtx());
    } finally {
      process.env.PATH = oldPath;
      if (emptyBin) cleanupDir(emptyBin);
    }
  }

  function contextFixture(): string {
    const dir2 = tmpDir();
    fsSync.writeFileSync(
      path.join(dir2, "ctx.txt"),
      "before one\nmatch alpha\nafter one\nfiller\nmatch beta\nlast line",
    );
    return dir2;
  }

  for (const [label, hideRg] of [
    ["rg path", false],
    ["native path", true],
  ] as const) {
    it(`includes context lines around matches (${label})`, async () => {
      const dir2 = contextFixture();
      try {
        const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
        const result = await runWith(
          tool,
          { pattern: "match", path: dir2, context: 1 },
          hideRg,
        );
        const text = resultStr(result);
        expect(text).toContain("before one");
        expect(text).toContain("match alpha");
        expect(text).toContain("after one");
        expect(text).toContain("filler");
        expect(text).toContain("match beta");
        expect(text).toContain("last line");
      } finally {
        cleanupDir(dir2);
      }
    });

    it(`no context lines when context is 0 (${label})`, async () => {
      const dir2 = contextFixture();
      try {
        const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
        const result = await runWith(
          tool,
          { pattern: "match", path: dir2 },
          hideRg,
        );
        const text = resultStr(result);
        expect(text).toContain("match alpha");
        expect(text).not.toContain("before one");
        expect(text).not.toContain("after one");
      } finally {
        cleanupDir(dir2);
      }
    });

    it(`reports truncated and the true total when matches exceed max_results (${label})`, async () => {
      const dir2 = tmpDir();
      for (let i = 0; i < 5; i++) {
        fsSync.writeFileSync(path.join(dir2, `t${i}.txt`), `hello ${i}`);
      }
      try {
        const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
        const result = await runWith(
          tool,
          { pattern: "hello", path: dir2, max_results: 2 },
          hideRg,
        );
        const lines = resultStr(result).split("\n").filter(Boolean);
        expect(lines.length).toBeLessThanOrEqual(2);
        expect(result.metadata?.get("results")).toBe("5");
        expect(result.metadata?.get("truncated")).toBe("true");
      } finally {
        cleanupDir(dir2);
      }
    });

    it(`reports the total without truncated when matches fit max_results (${label})`, async () => {
      const dir2 = tmpDir();
      for (let i = 0; i < 3; i++) {
        fsSync.writeFileSync(path.join(dir2, `t${i}.txt`), `hello ${i}`);
      }
      try {
        const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
        const result = await runWith(
          tool,
          { pattern: "hello", path: dir2, max_results: 10 },
          hideRg,
        );
        expect(resultStr(result).split("\n").filter(Boolean).length).toBe(3);
        expect(result.metadata?.get("results")).toBe("3");
        expect(result.metadata?.get("truncated")).toBeUndefined();
      } finally {
        cleanupDir(dir2);
      }
    });
  }
});

describe("GrepTool.execute — rg argument-injection guard", () => {
  // A model-supplied pattern must never reach rg as a flag. Without the
  // "--" separator, a pattern like "--pre=/bin/sh" makes rg pipe every
  // scanned file through sh (RCE). The payload below proves execution:
  // if the flag fires, rg runs it and MARKER appears on disk.
  it("treats a flag-shaped pattern as a literal pattern (rg path)", async () => {
    const dir2 = tmpDir();
    const marker = path.join(dir2, "MARKER");
    try {
      fsSync.writeFileSync(
        path.join(dir2, "payload.txt"),
        `touch ${marker}\n`,
      );

      const tool = new GrepTool({ maxResults: 100, maxOutputLines: 600 });
      const result = await tool.execute(
        { pattern: "--pre=/bin/sh", path: dir2 },
        toolCtx(),
      );

      expect(resultStr(result)).toContain("No matches found");
      expect(fsSync.existsSync(marker)).toBe(false);
    } finally {
      cleanupDir(dir2);
    }
  });
});

describe("grepNative ignoreCase", () => {
  it("honors the ignoreCase flag in the native walker", async () => {
    const dir2 = tmpDir();
    try {
      fsSync.writeFileSync(path.join(dir2, "a.txt"), "FooBar line\n");

      const ci = await grepNative("foobar", dir2, 10, 0, null, true);
      expect(ci.totalMatches).toBe(1);

      const cs = await grepNative("foobar", dir2, 10, 0, null, false);
      expect(cs.totalMatches).toBe(0);
    } finally {
      cleanupDir(dir2);
    }
  });
});
