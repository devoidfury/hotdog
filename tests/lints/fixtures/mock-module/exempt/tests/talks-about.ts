import { describe, expect, it } from "bun:test";

// Never reach for mock.module( here; the ban says so. (comment only)
const phrase = "mock.module( is banned"; // string only

describe("exempt", () => {
  it("passes", () => {
    expect(phrase).toContain("banned");
  });
});
