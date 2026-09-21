// Shared helpers for the conformance suite. See README.md for the rules.

import { expect } from "bun:test";

export interface ConformanceProvenance {
  source: "spec" | "official-example" | "recorded" | "derived";
  url: string;
  retrieved: string;
  sha256: string;
  note?: string;
}

export function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** Tamper seal: the recorded digest must match the fixture payload verbatim. */
export function assertSealed(prov: ConformanceProvenance, payload: string): void {
  expect(sha256(payload)).toBe(prov.sha256);
}

/** Load a JSON fixture: either {_provenance, raw} (seal over the raw external
 *  text) or {_provenance, ...payload} (seal over JSON.stringify of the
 *  payload minus _provenance -- for mechanically derived fixtures). */
export async function loadJsonFixture<T = Record<string, unknown>>(
  relPath: string,
): Promise<{ prov: ConformanceProvenance; data: T }> {
  const wrapper = await Bun.file(`${import.meta.dir}/fixtures/${relPath}`).json();
  const prov = wrapper._provenance as ConformanceProvenance;
  if (typeof wrapper.raw === "string") {
    assertSealed(prov, wrapper.raw);
    return { prov, data: JSON.parse(wrapper.raw) as T };
  }
  const { _provenance, ...rest } = wrapper;
  assertSealed(prov, JSON.stringify(rest));
  return { prov, data: rest as T };
}

/** Load a text fixture: "# key: value" provenance header, "---" separator, sealed payload. */
export async function loadTextFixture(
  relPath: string,
): Promise<{ prov: ConformanceProvenance; text: string }> {
  const all = await Bun.file(`${import.meta.dir}/fixtures/${relPath}`).text();
  const sep = all.indexOf("\n---\n");
  if (sep < 0) throw new Error(`${relPath}: missing provenance header`);
  const meta: Record<string, string> = {};
  for (const line of all.slice(0, sep).split("\n")) {
    const m = line.replace(/^#\s*/, "");
    const eq = m.indexOf(":");
    if (eq > 0) meta[m.slice(0, eq).trim()] = m.slice(eq + 1).trim();
  }
  const prov: ConformanceProvenance = {
    source: meta.source as ConformanceProvenance["source"],
    url: meta.url ?? "",
    retrieved: meta.retrieved ?? "",
    sha256: meta.sha256 ?? "",
    note: meta.note,
  };
  const text = all.slice(sep + 5);
  assertSealed(prov, text);
  return { prov, text };
}

/** ReadableStream over a string; chunkBytes > 0 feeds it in fixed-size chunks. */
export function streamFromText(text: string, chunkBytes = 0): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      if (chunkBytes <= 0) controller.enqueue(bytes);
      else
        for (let i = 0; i < bytes.length; i += chunkBytes)
          controller.enqueue(bytes.slice(i, i + chunkBytes));
      controller.close();
    },
  });
}
