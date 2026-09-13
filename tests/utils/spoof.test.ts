// Tests for utils/spoof.ts -- spoofing code-point neutralization (SPF-1).

import { describe, it, expect } from "bun:test";
import { neutralizeSpoofing, spoofSafe } from "@utils/spoof.ts";

describe("neutralizeSpoofing", () => {
  it("leaves clean text untouched with count 0", () => {
    const r = neutralizeSpoofing("git diff --stat src/spoof.ts");
    expect(r.text).toBe("git diff --stat src/spoof.ts");
    expect(r.count).toBe(0);
  });

  it("preserves tab and newline (alignment and multi-line prompts)", () => {
    const r = neutralizeSpoofing("a\tb\nc\r?");
    expect(r.text).toBe("a\tb\nc[U+000D]?");
    expect(r.count).toBe(1);
  });

  it("neutralizes the trojan-source bidi override and counts it", () => {
    // `git di<U+202E>ff` -- renders as "git diff" but runs "git di?ff".
    const r = neutralizeSpoofing("git di\u{202E}ff");
    expect(r.text).toBe("git di[U+202E]ff");
    expect(r.count).toBe(1);
  });

  it("neutralizes all bidi embeddings/overrides and isolates", () => {
    const bidi = "\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
    const r = neutralizeSpoofing(bidi);
    expect(r.count).toBe(9);
    expect(r.text).toBe(
      "[U+202A][U+202B][U+202C][U+202D][U+202E][U+2066][U+2067][U+2068][U+2069]",
    );
  });

  it("neutralizes zero-widths faking `rm -rf ./` as `rm -rf /`", () => {
    const r = neutralizeSpoofing("rm -rf /\u200B*");
    expect(r.text).toBe("rm -rf /[U+200B]*");
    expect(r.count).toBe(1);
    // ZWJ / ZWNJ / word joiner / BOM are in the set too.
    expect(neutralizeSpoofing("\u200d\u200c\u2060\ufeff").count).toBe(4);
  });

  it("neutralizes ANSI CSI/OSC introducers -- ESC is the sequence", () => {
    const erase = neutralizeSpoofing("x\u001b[2Ky");
    expect(erase.text).toBe("x[U+001B][2Ky");
    expect(erase.count).toBe(1);
    // OSC title set: ESC + terminating BEL both go.
    const osc = neutralizeSpoofing("\u001b]0;approved\u0007");
    expect(osc.count).toBe(2);
    expect(osc.text).toBe("[U+001B]]0;approved[U+0007]");
  });

  it("neutralizes backspace, CR and other C0 except tab/LF, plus DEL and C1", () => {
    // BS can claw back chars ("rm -rf /tmp\u0008\u0008\u0008.. /")
    expect(neutralizeSpoofing("\u0008").count).toBe(1);
    expect(neutralizeSpoofing("\u007f").count).toBe(1);
    expect(neutralizeSpoofing("\u009b").count).toBe(1); // 8-bit CSI
    expect(neutralizeSpoofing("\u2060\u2064").count).toBe(2);
    expect(neutralizeSpoofing("\ufff9\ufffb").count).toBe(2);
  });

  it("is idempotent -- the [U+XXXX] tokens are pure ASCII", () => {
    const once = neutralizeSpoofing("git di\u{202E}ff \u001b[31m");
    const twice = neutralizeSpoofing(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.count).toBe(0);
  });

  it("counts every occurrence", () => {
    expect(neutralizeSpoofing("\u202e\u202e\u202e").count).toBe(3);
  });

  it("spoofSafe returns just the text", () => {
    expect(spoofSafe("a\ufeffb")).toBe("a[U+FEFF]b");
  });
});
