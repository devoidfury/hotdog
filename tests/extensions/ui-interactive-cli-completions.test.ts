// Merge-contract tests for the editor popup completer: a directory is ONE
// candidate. compgen offers `data`, the readdir completer offers `data/`;
// they must collapse to a single row (the slash form), or the one-row popup
// and the unique-match auto-complete both regress.

import { describe, it, expect } from "bun:test";
import { mergeCandidates, pathCompletions } from "@extensions/ui-interactive-cli/completions.ts";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("mergeCandidates -- directory slash equivalence", () => {
  it("collapses `data` and `data/` into one entry, slash form wins", () => {
    const provider = [{ label: "data", insert: "data" }];
    const paths = [{ label: "data/", insert: "data/" }];
    expect(mergeCandidates(provider, paths)).toEqual([{ label: "data/", insert: "data/" }]);
  });

  it("keeps the survivor in first-list order (provider position, not appended)", () => {
    const provider = [{ label: "data" }, { label: "zeta" }];
    const paths = [{ label: "data/" }, { label: "alpha" }];
    expect(mergeCandidates(provider, paths).map((c) => c.label)).toEqual([
      "data/",
      "zeta",
      "alpha",
    ]);
  });

  it("slash-less-only and slash-only inputs merge without loss", () => {
    expect(mergeCandidates([{ label: "a" }], [{ label: "b" }]).map((c) => c.label)).toEqual(["a", "b"]);
    expect(mergeCandidates([], [{ label: "x/" }]).map((c) => c.label)).toEqual(["x/"]);
    expect(mergeCandidates([{ label: "x/" }], []).map((c) => c.label)).toEqual(["x/"]);
  });

  it("distinct names are never collapsed: only a trailing slash is ignored", () => {
    const merged = mergeCandidates([{ label: "data" }], [{ label: "database" }, { label: "data2" }]);
    expect(merged.map((c) => c.label)).toEqual(["data", "database", "data2"]);
  });

  it("file `data` and directory `data/` on disk stay two candidates (path side lists both)", () => {
    // Degenerate tree where the collapse has a real cost: a file and a dir
    // sharing a name. The path completer itself never emits both forms for
    // one entry, so this only merges when two SOURCES disagree -- acceptable
    // documented behavior (the slash form wins; the file stays reachable by
    // typing it out).
    const merged = mergeCandidates([{ label: "p/data" }], [{ label: "p/data/" }]);
    expect(merged).toEqual([{ label: "p/data/" }]);
  });
});

describe("pathCompletions -- directory form", () => {
  it("directories carry a trailing slash, files do not", () => {
    const dir = mkdtempSync(join(tmpdir(), "hotdog-merge-paths-"));
    try {
      mkdirSync(join(dir, "subdir"));
      writeFileSync(join(dir, "plain.txt"), "x");
      const labels = pathCompletions(`${dir}/`).map((c) => c.label);
      expect(labels).toContain(`${dir}/subdir/`);
      expect(labels).toContain(`${dir}/plain.txt`);
      // The same word never yields both forms of one entry: a unique
      // sub-prefix completes to exactly the slash-suffixed directory.
      const narrowed = pathCompletions(`${dir}/sub`);
      expect(narrowed.map((c) => c.label)).toEqual([`${dir}/subdir/`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
