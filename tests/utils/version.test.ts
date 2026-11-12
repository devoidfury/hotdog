// Unit tests for the manifest `sdk` range grammar (src/utils/version.ts).

import { describe, it, expect } from "bun:test";
import { parseVersion, parseVersionRange, rangeMatches } from "@utils/version.ts";

describe("parseVersion", () => {
  it("accepts 1-3 numeric segments", () => {
    expect(parseVersion("1")).toEqual([1]);
    expect(parseVersion("0.16")).toEqual([0, 16]);
    expect(parseVersion("0.16.2")).toEqual([0, 16, 2]);
  });

  it("refuses everything else", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("1.2.3.4")).toBeNull();
    expect(parseVersion("1.2.x")).toBeNull();
    expect(parseVersion("v1.2")).toBeNull();
    expect(parseVersion("1.2-rc1")).toBeNull();
  });
});

describe("parseVersionRange", () => {
  it("accepts the comparator grammar", () => {
    expect(parseVersionRange(">=0.16")).toEqual([{ op: ">=", segments: [0, 16] }]);
    expect(parseVersionRange(">=0.16 <1.0")).toHaveLength(2);
    expect(parseVersionRange("=1.2.3")).toEqual([{ op: "=", segments: [1, 2, 3] }]);
    expect(parseVersionRange("1.2.3")).toEqual([{ op: "=", segments: [1, 2, 3] }]);
    expect(parseVersionRange(" >= 0.16 ")).toEqual([{ op: ">=", segments: [0, 16] }]);
  });

  it("refuses empty ranges and anything outside the grammar", () => {
    expect(parseVersionRange("")).toBeNull();
    expect(parseVersionRange("   ")).toBeNull();
    expect(parseVersionRange("^0.16")).toBeNull();
    expect(parseVersionRange("~0.16")).toBeNull();
    expect(parseVersionRange("0.16 || >=1.0")).toBeNull();
    expect(parseVersionRange(">=0.16 <")).toBeNull();
    expect(parseVersionRange("=>0.16")).toBeNull();
    expect(parseVersionRange("*.0.1")).toBeNull();
  });
});

describe("rangeMatches", () => {
  it("zero-pads missing segments on both sides", () => {
    const r = parseVersionRange(">=0.16");
    expect(rangeMatches("0.16", r)).toBe(true);
    expect(rangeMatches("0.16.0", r)).toBe(true);
    expect(rangeMatches("0.16.9", r)).toBe(true);
    expect(rangeMatches("0.15.9", r)).toBe(false);
  });

  it("implements every comparator", () => {
    expect(rangeMatches("1.0.0", parseVersionRange(">1.0.0"))).toBe(false);
    expect(rangeMatches("1.0.1", parseVersionRange(">1.0.0"))).toBe(true);
    expect(rangeMatches("1.0.0", parseVersionRange("<1.0.0"))).toBe(false);
    expect(rangeMatches("0.9.9", parseVersionRange("<1.0.0"))).toBe(true);
    expect(rangeMatches("1.0.0", parseVersionRange("<=1.0.0"))).toBe(true);
    expect(rangeMatches("1.0.1", parseVersionRange("<=1.0.0"))).toBe(false);
    expect(rangeMatches("0.16.2", parseVersionRange("=0.16.2"))).toBe(true);
    expect(rangeMatches("0.16.3", parseVersionRange("=0.16.2"))).toBe(false);
  });

  it("ANDs multiple comparators", () => {
    const r = parseVersionRange(">=0.16 <1.0");
    expect(rangeMatches("0.16.0", r)).toBe(true);
    expect(rangeMatches("0.99.99", r)).toBe(true);
    expect(rangeMatches("0.15.0", r)).toBe(false);
    expect(rangeMatches("1.0.0", r)).toBe(false);
  });

  it("compares numerically, not lexically", () => {
    expect(rangeMatches("0.100.0", parseVersionRange(">0.16.0"))).toBe(true);
    expect(rangeMatches("10.0.0", parseVersionRange(">9.0.0"))).toBe(true);
  });

  it("empty comparator set and unparsable versions never match", () => {
    expect(rangeMatches("0.16.0", [])).toBe(false);
    expect(rangeMatches("0.16.0", null)).toBe(false);
    expect(rangeMatches("garbage", parseVersionRange(">=0.1"))).toBe(false);
  });
});
