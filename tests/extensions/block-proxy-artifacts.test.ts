// Tests for the proxy-artifact fence (block-proxy-artifacts.ts).
//
// Host construction discipline: every matching host is assembled from fragments so this
// file's own bytes never match the blocklist -- an edit/grep tool call carrying these
// test contents must not trip the fence it tests. A self-scan test enforces the property.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { BLOCKED, findBlocked, verdict, WARNED_CAP } from "@extensions/tool-call-repair/block-proxy-artifacts.ts";
import { create as createRepairExtension } from "@extensions/tool-call-repair/index.ts";
import { HOOKS } from "@core/hooks.ts";

const LABEL = "routify" + "-file-proxy-sg";
const LABEL_OVERSEA = "routify" + "-file-oversea";
const PUBLIC_EP = ".oss-ap-southeast-1" + ".aliyuncs.com";
const DUALSTACK_EP = ".ap-southeast-1.oss" + ".aliyuncs.com";
const ACCELERATE_EP = ".oss-accelerate" + ".aliyuncs.com";
const IO_TLD = ".oss-ap-southeast-1" + ".aliyuncs.io";

const signed = (host: string) =>
  `https://${host}/proxy_temp_file/production/trace_210184/requestId_6b58/9296a87?Expires=1814047991&Signature=Gz9`;

describe("findBlocked", () => {
  it("blocks the canonical incident host (rule 1)", () => {
    const hit = findBlocked(signed(LABEL + PUBLIC_EP));
    expect(hit).not.toBeNull();
    expect(hit!.why).toContain("incident host");
  });

  it("blocks the dual-stack endpoint form (rule 2)", () => {
    expect(findBlocked(signed(LABEL + DUALSTACK_EP))).not.toBeNull();
  });

  it("blocks proxy-less labels on accelerate endpoints (template family, rule 2)", () => {
    expect(findBlocked(signed(LABEL_OVERSEA + ACCELERATE_EP))).not.toBeNull();
  });

  it("blocks the io TLD variant (rule 2)", () => {
    expect(findBlocked(signed(LABEL + IO_TLD))).not.toBeNull();
  });

  it("leaves ordinary URLs alone", () => {
    expect(findBlocked("https://example.com/docs/page?x=1")).toBeNull();
    expect(findBlocked("curl -s https://bun.sh/index.html")).toBeNull();
  });

  it("leaves a bare label mention (no aliyuncs endpoint) alone", () => {
    expect(findBlocked(`grep -rn ${LABEL} src/`)).toBeNull();
  });

  it("leaves legitimate non-routify aliyuncs buckets alone (retired-rule case)", () => {
    expect(findBlocked("https://my-bucket.oss-cn-hangzhou" + ".aliyuncs.com/data.csv")).toBeNull();
  });
});

describe("verdict", () => {
  const dial = signed(LABEL + PUBLIC_EP);

  it("first block in a session carries the full guidance", () => {
    const warned = new Map<string, boolean>();
    const msg = verdict(dial, warned, "s1")!;
    expect(msg).toContain("Blocked by block-proxy-artifacts policy");
    expect(msg).toContain("Do NOT retry");
    expect(msg).toContain("Go back to the original publisher URL");
    expect(warned.get("s1")).toBe(true);
  });

  it("repeats in the same session get the terse one-liner", () => {
    const warned = new Map<string, boolean>();
    const first = verdict(dial, warned, "s1")!;
    const repeat = verdict(dial, warned, "s1")!;
    expect(repeat).toContain("Do NOT retry");
    expect(repeat).toContain("Fetch the original publisher URL directly.");
    expect(repeat).not.toContain("Go back to the original publisher URL");
    expect(repeat.length).toBeLessThan(first.length);
  });

  it("a fresh session gets the full guidance again", () => {
    const warned = new Map<string, boolean>();
    verdict(dial, warned, "s1");
    expect(verdict(dial, warned, "s2")!).toContain("Go back to the original publisher URL");
  });

  it("clears the warned map past the cap", () => {
    const warned = new Map<string, boolean>();
    for (let i = 0; i <= WARNED_CAP; i++) warned.set(`filler-${i}`, true);
    const msg = verdict(dial, warned, "fresh")!;
    expect(warned.size).toBe(1);
    // The session was not warned before the wholesale clear, so "first" still holds.
    expect(msg).toContain("Go back to the original publisher URL");
  });
});

describe("TOOL_CALL gate wiring", () => {
  function gateHandler() {
    const ext = createRepairExtension({ config: {} } as any);
    return ext.hooks![HOOKS.TOOL_CALL] as (p: unknown) => { action?: string; result?: unknown } | undefined;
  }

  it("blocks a fetch call carrying a fabricated artifact URL", () => {
    const handler = gateHandler();
    const verdict = handler({
      toolCallId: "c1",
      toolName: "fetch",
      input: JSON.stringify({ url: signed(LABEL + PUBLIC_EP) }),
      agent: { sessionId: "s1" },
    });
    expect(verdict?.action).toBe("block");
    expect(String(verdict?.result)).toContain("Do NOT retry");
  });

  it("blocks a bash curl carrying a fabricated artifact URL", () => {
    const handler = gateHandler();
    const verdict = handler({
      toolCallId: "c2",
      toolName: "bash",
      input: JSON.stringify({ command: `curl -s ${signed(LABEL + DUALSTACK_EP)} -o out.bin` }),
      agent: { sessionId: "s1" },
    });
    expect(verdict?.action).toBe("block");
  });

  it("returns nothing (not a no-op continue) for allowed calls", () => {
    const handler = gateHandler();
    expect(
      handler({
        toolCallId: "c3",
        toolName: "fetch",
        input: JSON.stringify({ url: "https://example.com/ok" }),
        agent: { sessionId: "s1" },
      }),
    ).toBeUndefined();
  });
});

describe("self-compatibility", () => {
  it("neither source file matches its own blocklist", () => {
    const sources = [
      import.meta.dir + "/../../src/extensions/tool-call-repair/block-proxy-artifacts.ts",
      import.meta.dir + "/block-proxy-artifacts.test.ts",
    ];
    for (const path of sources) {
      const text = readFileSync(path, "utf8");
      for (const b of BLOCKED) {
        b.pattern.lastIndex = 0;
        expect(b.pattern.test(text)).toBe(false);
      }
    }
  });
});
