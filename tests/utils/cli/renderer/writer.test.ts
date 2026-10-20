// BoundedWriter (§1, pi BoundedTerminalWriter precedent): 1 MiB UTF-8 cap per
// write, surrogate pairs never straddle a chunk boundary.

import { describe, it, expect } from "bun:test";
import { BoundedWriter, MAX_WRITE_BYTES } from "@utils/cli/renderer/writer.ts";

const enc = new TextEncoder();

function collect(s: string): string[] {
  const chunks: string[] = [];
  new BoundedWriter((c) => chunks.push(c)).write(s);
  return chunks;
}

function isHigh(u: string | undefined): boolean {
  return u !== undefined && u.charCodeAt(0) >= 0xd800 && u.charCodeAt(0) <= 0xdbff;
}
function isLow(s: string): boolean {
  return s.charCodeAt(0) >= 0xdc00 && s.charCodeAt(0) <= 0xdfff;
}

describe("BoundedWriter", () => {
  it("exports the 1 MiB cap", () => {
    expect(MAX_WRITE_BYTES).toBe(1048576);
  });

  it("input under the cap is exactly one write; empty writes nothing", () => {
    expect(collect("hello")).toEqual(["hello"]);
    expect(collect("")).toEqual([]);
    expect(collect("\u00e9".repeat(500_000)).length).toBe(1); // exactly 1 MiB of 2-byte chars (escape form: precomposed or the count lies)
  });

  it("a surrogate pair sitting on the boundary moves whole into the next chunk", () => {
    // Two ASCII bytes of headroom: the pair's 4 bytes do not fit.
    const s = "a".repeat(MAX_WRITE_BYTES - 2) + "\u{1f600}";
    const chunks = collect(s);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(MAX_WRITE_BYTES - 2));
    expect(chunks[1]).toBe("\u{1f600}");
  });

  it("a pair ending exactly on the boundary stays intact", () => {
    const s = "a".repeat(MAX_WRITE_BYTES - 4) + "\u{1f600}" + "b";
    const chunks = collect(s);
    expect(chunks.length).toBe(2);
    expect(enc.encode(chunks[0]!).length).toBe(MAX_WRITE_BYTES);
    expect(isHigh(chunks[0]!.slice(-1))).toBe(false);
    expect(chunks[1]).toBe("b");
  });

  it("mixed-script flood: every chunk within budget, concat exact, no split pairs", () => {
    const src = ["ascii", "日本語テキスト", "\u{1f600}emoji\u{1f1fa}\u{1f1f8}", "émojis mélangés", "\u{200d}zwj\u{fe0f}"]
      .join(" • ")
      .repeat(30_000);
    const chunks = collect(src);
    expect(chunks.length).toBeGreaterThan(2);
    let bytesTotal = 0;
    for (const [i, c] of chunks.entries()) {
      const bytes = enc.encode(c).length;
      expect(bytes).toBeLessThanOrEqual(MAX_WRITE_BYTES);
      bytesTotal += bytes;
      if (i > 0) expect(isLow(c)).toBe(false); // chunk never starts with a low surrogate
      if (i < chunks.length - 1) expect(isHigh(c.slice(-1))).toBe(false); // nor ends with a high one
    }
    expect(chunks.join("")).toBe(src);
    expect(bytesTotal).toBe(enc.encode(src).length);
  });

  it("lone surrogates pass through without throwing", () => {
    const s = "x".repeat(MAX_WRITE_BYTES - 3) + "\ud83d" + "tail";
    const chunks = collect(s);
    expect(chunks.join("")).toBe(s);
    for (const c of chunks) expect(enc.encode(c).length).toBeLessThanOrEqual(MAX_WRITE_BYTES);
  });
});
