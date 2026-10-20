import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { parseJsonLines } from "@utils/json-lines.ts";
import { initializeLogger, resetLoggerForTesting, type LogEvent } from "@utils/logger.ts";
import { HookSystem } from "@core/hooks.ts";

// Capture warn output: a fresh HookSystem owns the "log" hook, target "none"
// keeps the default stderr handler off.
let warned: string[] = [];

beforeAll(() => {
  resetLoggerForTesting();
  const hooks = new HookSystem();
  hooks.on("log", (data) => {
    const { level, message } = data as LogEvent;
    if (level === "warn") warned.push(message);
  });
  initializeLogger({ hooks, minLevel: "debug", target: "none" });
});

afterAll(() => {
  resetLoggerForTesting();
});

describe("parseJsonLines", () => {
  it("parses lines, trimming whitespace and dropping blanks", () => {
    const out = parseJsonLines<{ a: number }>('{"a":1}\n\n  {"a":2}  \n');
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("returns [] for empty or blank input", () => {
    expect(parseJsonLines("")).toEqual([]);
    expect(parseJsonLines("\n \n\t\n")).toEqual([]);
  });

  it("skips bad lines by default and stays silent", () => {
    warned = [];
    const out = parseJsonLines<{ a: number }>('{"a":1}\nnot json\n{"a":2}');
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
    expect(warned).toEqual([]);
  });

  it('"skip" warns nothing even when every line is bad', () => {
    warned = [];
    expect(parseJsonLines("nope\nalso nope", "skip")).toEqual([]);
    expect(warned).toEqual([]);
  });

  it('"warn" drops the line but logs its number, label and snippet', () => {
    warned = [];
    const out = parseJsonLines<{ a: number }>('{"a":1}\nbroken,\n{"a":2}', "warn", "spawn-log");
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain("[spawn-log]");
    expect(warned[0]).toContain("line 2");
    expect(warned[0]).toContain('"broken,"');
  });

  it('"warn" truncates long snippets at 80 chars', () => {
    warned = [];
    parseJsonLines("x".repeat(200), "warn");
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain(`${"x".repeat(80)}...`);
    expect(warned[0]!.length).toBeLessThan(140);
  });

  it("warns once per bad line, counting blanks and skips", () => {
    warned = [];
    parseJsonLines('bad1\n\n{"ok":true}\n   \nbad2', "warn");
    expect(warned.length).toBe(2);
    expect(warned[0]).toContain("line 1");
    expect(warned[1]).toContain("line 5");
  });

  it("keeps non-object JSON values: shape checks stay with the caller", () => {
    expect(parseJsonLines<unknown>("null\n7\n[1,2]")).toEqual([null, 7, [1, 2]]);
  });
});
