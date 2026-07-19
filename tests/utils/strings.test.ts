// Tests for utils/strings.ts — camelCase, parseCliFlagKey.

import { describe, it, expect } from "bun:test";
import { camelCase, parseCliFlagKey } from "../../src/utils/strings.ts";

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
