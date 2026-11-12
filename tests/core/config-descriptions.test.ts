// Core-schema prose guard. Every node in src/core/core.config.json -- leaves
// and the two object groups alike -- must carry a non-empty single-line
// description: the settings panel renders the raw keyPath when one is missing,
// which is precisely the fallback this test exists to prevent. Plus a shape
// pin: descriptions are the ONLY thing allowed to churn. The digest covers the
// schema with every `description` key stripped (property prose AND cliFlag
// prose -- both are docs, not shape) and key order preserved, so adding or
// rewording a description never trips it while any type/enum/layer/bounds
// change (or a reorder) does. When a schema change is intentional, recompute
// the digest the same way the strip below does it and update the pin.

import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMA_PATH = join(import.meta.dir, "../../src/core/core.config.json");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, any>;

// ade5edfd... = sha256 of the stable JSON.stringify of the schema with all
// description keys stripped, as of the descriptions sweep (61 additions).
// 48140af4... = recomputed with the logLevel/logTarget additions (2026-11-11).
// 7e0ad013... = recomputed for the envScrubbing config layer (owner ruling
// 2026-11-11 mid-run: the key became file-settable, {source:"config"} inserted
// between the cli falsy layer and {default:true}; the settings panel ships and
// writes it from that change -- see tests/extensions/websocket-config-clionly).
// 75637d0d... = recomputed for the inert-key fix: maxRetries/toolRetryDelay got
// config layers + minimum:0 bounds and taskProfile a config layer, and the dead
// temperature/prompt keys were RETIRED (REMOVED_KEYS tombstones in rescue.ts).
const SHAPE_PIN = "75637d0dbe652fbebb206b6d355ea27fe0a46e50ad70e5429df7618f2649004b";

/** Every schema node with its keyPath: each top-level entry, each nested
 *  properties child, and each items.properties child, recursively. */
function collectNodes(node: any, path: string, out: Array<[string, any]>): void {
  out.push([path, node]);
  if (node?.properties) {
    for (const [k, v] of Object.entries(node.properties)) collectNodes(v, `${path}.${k}`, out);
  }
  if (node?.items?.properties) {
    for (const [k, v] of Object.entries(node.items.properties)) collectNodes(v, `${path}.items.${k}`, out);
  }
}

function stripDescriptions(node: any): unknown {
  if (Array.isArray(node)) return node.map(stripDescriptions);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "description") continue;
      out[k] = stripDescriptions(v);
    }
    return out;
  }
  return node;
}

describe("core schema descriptions", () => {
  const nodes: Array<[string, any]> = [];
  for (const [key, prop] of Object.entries(schema)) collectNodes(prop, key, nodes);

  it("covers the whole schema (63 nodes: 61 leaves + 2 groups)", () => {
    // Guards the walker itself: if the schema grows a node, this count moving
    // is the reminder that the new node needs a description too.
    expect(nodes.length).toBe(63);
  });

  it("every node carries a non-empty single-line description", () => {
    for (const [path, node] of nodes) {
      const d = node.description;
      expect(typeof d === "string" && d.trim().length > 0, `missing description: ${path}`).toBe(true);
      expect(d.includes("\n") || d.includes("\r"), `multiline description: ${path}`).toBe(false);
    }
  });

  it("shape pin: non-description fields are unchanged", () => {
    const digest = createHash("sha256")
      .update(JSON.stringify(stripDescriptions(schema)))
      .digest("hex");
    expect(digest).toBe(SHAPE_PIN);
  });

  it("toolExec and execFence keep their closed enum sets", () => {
    // Redundant with the digest, spelled out because the settings editor's
    // dropdown AND its write gate both stamp these enums.
    expect(schema.toolExec.enum).toEqual(["worker", "inline"]);
    expect(schema.execFence.enum).toEqual(["off", "probe"]);
  });

  it("logLevel and logTarget keep their closed enum sets and config/default layers", () => {
    // Same reason as above (dropdown + write gate), plus the layer shape:
    // env beats config INSIDE resolveLogLevel/resolveLogTarget at boot (the
    // logger is born before schema resolution), so the layers here are the
    // settings-panel view, deliberately config-then-default.
    expect(schema.logLevel.enum).toEqual(["debug", "info", "warn", "error"]);
    expect(schema.logTarget.enum).toEqual(["stderr", "stdout", "none"]);
    expect(schema.logLevel.layers).toEqual([
      { source: "config", key: "logLevel" },
      { default: "info" },
    ]);
    expect(schema.logTarget.layers).toEqual([
      { source: "config", key: "logTarget" },
      { default: "stderr" },
    ]);
  });
});
