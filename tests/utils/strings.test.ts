// Tests for utils/strings.ts — camelCase, parseCliFlagKey.

import { describe, it, expect } from "bun:test";
import { camelCase, parseCliFlagKey, suggestCandidates, xmlEscape } from "@utils/strings.ts";

describe("camelCase", () => {
  it("converts snake_case and kebab-case to camelCase", () => {
    expect(camelCase("hello_world")).toBe("helloWorld");
    expect(camelCase("default_model")).toBe("defaultModel");
    expect(camelCase("hello-world")).toBe("helloWorld");
    expect(camelCase("my-cool-extension")).toBe("myCoolExtension");
  });

  it("handles mixed separators and edge cases", () => {
    expect(camelCase("hello_world-test")).toBe("helloWorldTest");
    expect(camelCase("alreadyCamel")).toBe("alreadyCamel");
    expect(camelCase("simple")).toBe("simple");
    expect(camelCase("_leading")).toBe("Leading");
    expect(camelCase("-leading")).toBe("Leading");
  });

  it("handles consecutive separators", () => {
    expect(camelCase("a__b")).toBe("a_B");
    expect(camelCase("a--b")).toBe("a-B");
  });
});

describe("parseCliFlagKey", () => {
  it("strips dashes and converts to camelCase", () => {
    expect(parseCliFlagKey("-model")).toBe("model");
    expect(parseCliFlagKey("--show-token-use")).toBe("showTokenUse");
    expect(parseCliFlagKey("--chat-timeout-secs")).toBe("chatTimeoutSecs");
  });

  it("handles flags without dashes", () => {
    expect(parseCliFlagKey("model")).toBe("model");
    expect(parseCliFlagKey("showTokenUse")).toBe("showTokenUse");
    expect(parseCliFlagKey("show-token-use")).toBe("showTokenUse");
  });
});


describe("xmlEscape", () => {
  it("escapes & < > \" '", () => {
    expect(xmlEscape("a & b < c > d \"e\" 'f'")).toBe("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;");
  });
  it("returns unchanged string with no special chars", () => {
    expect(xmlEscape("hello world")).toBe("hello world");
  });
  it("handles empty string", () => {
    expect(xmlEscape("")).toBe("");
  });
});

describe("suggestCandidates", () => {
  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "");

  it("returns normalized exact matches first", () => {
    expect(suggestCandidates("--show_token_use", ["--show-token-use", "--model"], { normalize: norm }))
      .toEqual(["--show-token-use"]);
  });

  it("falls back to substring matches (both directions)", () => {
    expect(suggestCandidates("sess", ["session", "show-prompt", "info"], { normalize: norm }))
      .toEqual(["session"]);
    expect(suggestCandidates("search_files", ["search_files_content", "read"], { normalize: norm }))
      .toEqual(["search_files_content"]);
  });

  it("falls back to one-edit typos", () => {
    expect(suggestCandidates("modl", ["model", "loud", "json"], { normalize: norm }))
      .toEqual(["model"]);
    expect(suggestCandidates("inf", ["info", "profiles"], { normalize: norm }))
      .toEqual(["info"]);
  });

  it("skips the substring tier for tiny targets", () => {
    // A 1-char typo must not yield near-arbitrary candidates ("o" is a
    // substring of almost every flag name).
    expect(suggestCandidates("o", ["config", "model", "loud", "json"], { normalize: norm })).toEqual([]);
    // Such targets still get one-edit matches ("ca" is one deletion from "cat").
    expect(suggestCandidates("ca", ["cat", "config"], { normalize: norm })).toEqual(["cat"]);
  });

  it("prefers the substring tier when both tiers could match", () => {
    // "profil" is a substring of both AND one edit from "profile"; substring wins by tier.
    const out = suggestCandidates("profil", ["profile", "profiles", "prompt"], { normalize: norm });
    expect(out).toEqual(["profile", "profiles"]);
  });

  it("returns nothing for unrelated targets and empty targets", () => {
    expect(suggestCandidates("quantum_flux", ["read", "edit"], { normalize: norm })).toEqual([]);
    expect(suggestCandidates("", ["read"], { normalize: norm })).toEqual([]);
    expect(suggestCandidates("----", ["read"], { normalize: norm })).toEqual([]);
  });

  it("caps results at the given limit", () => {
    const many = ["xabx1", "xabx2", "xabx3", "xabx4", "xabx5", "xabx6"];
    expect(suggestCandidates("abx", many, { limit: 3 })).toEqual(["xabx1", "xabx2", "xabx3"]);
  });

  it("ignores substring tier keys of two chars or less", () => {
    // target "re" would match "read" by substring, but 2-char candidate keys are excluded;
    // and the target itself being short is fine as long as candidate keys are longer.
    expect(suggestCandidates("rea", ["read", "edit"])).toEqual(["read"]);
  });

  it("defaults to identity normalization", () => {
    expect(suggestCandidates("read", ["Read", "read"], { limit: 5 })).toEqual(["read"]);
  });
});
