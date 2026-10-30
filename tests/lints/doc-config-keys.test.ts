// Docs-vs-rescue key contract: every top-level key docs/config-reference.md
// documents as a valid `defaults.json` setting must pass rescue's known-key
// verdict (UNKNOWN/DUPLICATE stage in src/core/config/rescue.ts checkKeys()).
//
// Why (2026-10-28 review, H7): `services` and `envScrub` were documented and
// read at runtime yet flagged UNKNOWN because they sat in neither
// CONFIG_SCHEMA nor EXTRA_KNOWN_KEYS. That is a drift class, not a typo: the
// docs and rescue's allow-list have no shared source. This lint is the shared
// source.
//
// Extraction scope (known ceilings, stated honestly):
// - A documented top-level key is a `### \`key\`` header in the doc (depth-3,
//   single backticked identifier). Nested `#### \`a.b\`` headers are skipped.
// - Plus the key column of the "Enabled-only extensions" table.
// - Keys whose own section says "Resolution: CLI only" are skipped: the doc
//   itself disclaims a config-file layer (e.g. configDebug), so an UNKNOWN
//   verdict from rescue there is correct, not drift.
// - The doc's JSON examples are NOT parsed (they contain deprecated aliases
//   and nested samples; header + table are the normative surface).
// - `services` is NOT covered here: it is documented in
//   docs/agents/extensions.md ("set services.<name> in config"), not in
//   config-reference.md, so this scan cannot see it. It is covered by
//   tests/core/rescue.test.ts instead.
//
// Verdict logic mirrors rescue checkKeys() exactly:
//   CONFIG_SCHEMA keys + extractConfigLayerKeys(CONFIG_SCHEMA) +
//   EXTRA_KNOWN_KEYS + registered extension config params.
// Extension params come from BOTH bundled tiers: a key for an experimental
// extension (fileWatch) is only reachable when the user opts into
// `@experimental` in extensionPaths -- and registerExtensionMetadata then
// registers its params before rescue dispatches, so a user who follows the
// documented opt-in gets a known key.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_SCHEMA, extractConfigLayerKeys } from "@core/config/schema-loader.ts";
import { EXTRA_KNOWN_KEYS } from "@core/config/rescue.ts";
import { getExtensionConfigDefaults } from "@core/extensions/extensions.ts";

const ROOT = join(import.meta.dir, "../..");
const DOC_REL = "docs/config-reference.md";

/** Same normalization rescue's checkKeys uses. */
function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[-_]/g, "");
}

/** Top-level keys the doc presents as valid defaults.json settings. */
export function documentedTopLevelKeys(
  md: string,
): Array<{ key: string; line: number }> {
  const lines = md.split("\n");
  const found: Array<{ key: string; line: number }> = [];

  lines.forEach((line, i) => {
    const h = line.match(/^### `([A-Za-z][A-Za-z0-9]*)`/);
    if (!h) return;
    // Skip sections that disclaim a config-file layer ("CLI only").
    for (let j = i + 1; j < lines.length; j++) {
      if (/^#{1,4} /.test(lines[j]!)) break;
      if (/CLI only/i.test(lines[j]!)) return;
    }
    found.push({ key: h[1]!, line: i + 1 });
  });

  // Enabled-only extensions table: `| \`key\` | ... |` rows, section-scoped so
  // the property tables (nested field names) elsewhere are not swept in.
  let inTable = false;
  lines.forEach((line, i) => {
    if (/^### Enabled-only extensions/.test(line)) {
      inTable = true;
      return;
    }
    if (inTable && /^#{1,4} /.test(line)) inTable = false;
    if (!inTable) return;
    const m = line.match(/^\| `([A-Za-z][A-Za-z0-9]*)` \|/);
    if (m) found.push({ key: m[1]!, line: i + 1 });
  });

  return found;
}

/**
 * Documented keys rescue would report UNKNOWN. `known` is the same set
 * checkKeys() builds at runtime (already normalized).
 */
export function findUnknownDocumentedKeys(
  md: string,
  known: Set<string>,
): Array<{ key: string; line: number }> {
  const flagged = new Map<string, { key: string; line: number }>();
  for (const { key, line } of documentedTopLevelKeys(md)) {
    if (!known.has(normalizeKey(key)) && !flagged.has(key)) {
      flagged.set(key, { key, line });
    }
  }
  return Array.from(flagged.values());
}

// Drift the lint currently accepts instead of blessing, with the reason.
// Each entry documents CURRENT behavior only; none is silently added to the
// allow-list. Resolve by fixing the doc section or the runtime read, then
// prune the entry here.
const KNOWN_DRIFT: Record<string, string> = {
  // TODO(docs-vs-rescue drift, 2026-10-28 review follow-up): the doc section
  // (config-reference.md "### `promptsPath`") presents top-level `promptsPath`
  // as a valid config-file setting, but at runtime only the CLI flag
  // (--prompts-path, via the prompts extension `cli` layer) and the nested
  // `prompts.promptsPath` are read; a top-level `promptsPath` in
  // defaults.json IS ignored, so rescue's UNKNOWN verdict is currently
  // correct and the DOC is wrong. Fix belongs in the doc (or in the prompts
  // extension's layers), not in rescue's allow-list -- out of the H7/H6 scope.
  promptsPath: "documented as config-file key but only CLI + prompts.promptsPath resolve at runtime; doc is wrong, not rescue",
};

describe("lint: documented defaults.json keys pass rescue's known-key verdict", () => {
  it("self-test: planted bogus key in the doc is flagged", () => {
    const md =
      "## Core Settings\n\n### `defaultModel`\n\n- **Type:** string\n\n" +
      "### `totallyNotASetting123`\n\n- **Type:** string\n";
    const known = new Set(["defaultmodel"]);
    expect(findUnknownDocumentedKeys(md, known)).toEqual([
      { key: "totallyNotASetting123", line: 7 },
    ]);
  });

  it("self-test: real-ish known keys pass, case/separator variants included", () => {
    const md = "### `defaultModel`\n\nbody\n\n### `default_model`\n\nbody\n";
    const known = new Set(["defaultmodel"]);
    expect(findUnknownDocumentedKeys(md, known)).toEqual([]);
  });

  it("self-test: CLI-only sections are skipped; nested headers are not keys", () => {
    const md =
      "### `configDebugish`\n\n- **Resolution:** CLI only (no config file layer)\n\n" +
      "### `workspace`\n\nbody\n\n#### `workspace.paths`\n\nbody\n\n### `bogus2`\n";
    const known = new Set(["workspace"]);
    expect(findUnknownDocumentedKeys(md, known)).toEqual([
      { key: "bogus2", line: 13 },
    ]);
  });

  it("self-test: Enabled-only extensions table is scanned, property tables are not", () => {
    const md =
      "### Enabled-only extensions\n\ntext\n\n" +
      "| Config key | Extension |\n|---|---|\n| `mysteryKey` | `mystery` |\n\n" +
      "### Some Other\n\n| Field | Type |\n|---|---|\n| `enabled` | boolean |\n";
    const known = new Set<string>();
    expect(findUnknownDocumentedKeys(md, known)).toEqual([
      { key: "mysteryKey", line: 7 },
    ]);
  });

  it("repo doc: no documented key is UNKNOWN to rescue (modulo KNOWN_DRIFT)", async () => {
    const md = readFileSync(join(ROOT, DOC_REL), "utf-8");
    const [coreParams, experimentalParams] = await Promise.all([
      getExtensionConfigDefaults(["@extensions"]),
      getExtensionConfigDefaults(["@experimental"]),
    ]);
    const known = new Set<string>(
      [
        ...Object.keys(CONFIG_SCHEMA),
        ...extractConfigLayerKeys(CONFIG_SCHEMA),
        ...EXTRA_KNOWN_KEYS,
        ...coreParams.map((p) => p.key),
        ...experimentalParams.map((p) => p.key),
      ].map(normalizeKey),
    );

    const unknown = findUnknownDocumentedKeys(md, known);
    const unexplained = unknown.filter((u) => !(u.key in KNOWN_DRIFT));
    expect(unexplained).toEqual([]);

    // Drift entries must match reality: prune this file when one disappears.
    for (const key of Object.keys(KNOWN_DRIFT)) {
      expect(unknown.map((u) => u.key)).toContain(key);
    }

    // Guard a vacuous pass (extraction silently matching nothing).
    expect(documentedTopLevelKeys(md).length).toBeGreaterThan(50);
  });
});
