// Persisted fetch-policy approvals: read/append over the state file.
// Failure paths are the point -- corrupt files and dead entries must read
// as empty (fail toward prompting), never throw, never fail open.

import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAllowEntry,
  readAllowEntries,
  FETCH_POLICY_STATE_FILENAME,
} from "@utils/fetch-policy/store.ts";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "fetch-policy-store-")), FETCH_POLICY_STATE_FILENAME);
}

describe("readAllowEntries", () => {
  it("reads a missing file as empty, no warning path", () => {
    expect(readAllowEntries(join(tmpdir(), "no-such-dir-xyz", "fetch-policy.json"))).toEqual([]);
  });

  it("reads a corrupt file as empty", () => {
    const p = tmpPath();
    writeFileSync(p, "{ not json");
    expect(readAllowEntries(p)).toEqual([]);
  });

  it("reads a version mismatch as empty", () => {
    const p = tmpPath();
    writeFileSync(p, JSON.stringify({ version: 99, allow: [{ origin: "https://x.example" }] }));
    expect(readAllowEntries(p)).toEqual([]);
  });

  it("skips invalid entries and keeps the valid ones", () => {
    const p = tmpPath();
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        allow: [
          { origin: "https://good.example", addedAt: "2026-01-01T00:00:00.000Z" },
          { origin: "https://good.example/path" }, // path: not an origin
          { origin: "" },
          "https://string-form.example", // non-object
          { addedAt: "x" }, // no origin
        ],
      }),
    );
    const entries = readAllowEntries(p);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.origin).toBe("https://good.example");
  });

  it("dedupes case-insensitively", () => {
    const p = tmpPath();
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        allow: [{ origin: "https://A.example" }, { origin: "https://a.example" }],
      }),
    );
    expect(readAllowEntries(p)).toHaveLength(1);
  });
});

describe("appendAllowEntry", () => {
  it("creates the file, round-trips the entry, dedupes", async () => {
    const p = tmpPath();
    expect(await appendAllowEntry(p, "https://api.github.com", "fetch tool")).toBe(true);
    const entries = readAllowEntries(p);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.origin).toBe("https://api.github.com");
    expect(entries[0]!.note).toBe("fetch tool");
    expect(entries[0]!.addedAt).not.toBe("");

    expect(await appendAllowEntry(p, "HTTPS://API.GitHub.com")).toBe(false); // dedupe, no write
    expect(readAllowEntries(p)).toHaveLength(1);
  });

  it("survives a corrupt file by rewriting it with the new entry", async () => {
    const p = tmpPath();
    writeFileSync(p, "]]not json[[");
    expect(await appendAllowEntry(p, "https://after-corrupt.example")).toBe(true);
    expect(readAllowEntries(p)).toEqual([
      { origin: "https://after-corrupt.example", addedAt: expect.any(String) },
    ]);
  });

  it("serializes concurrent appends: both entries survive", async () => {
    const p = tmpPath();
    await Promise.all([
      appendAllowEntry(p, "https://one.example"),
      appendAllowEntry(p, "https://two.example"),
      appendAllowEntry(p, "https://one.example"),
    ]);
    const origins = readAllowEntries(p).map((e) => e.origin).sort();
    expect(origins).toEqual(["https://one.example", "https://two.example"]);
    // The file is valid JSON at rest (temp + rename, never a torn write).
    expect(() => JSON.parse(readFileSync(p, "utf-8"))).not.toThrow();
  });
});
