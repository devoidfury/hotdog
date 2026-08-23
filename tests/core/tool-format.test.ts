// ToolFormat registry + selection (phase 2).
//
// Covers: the registry, wireFormat-style id resolution, the tool-utils seam
// (toolResult / toApiContent / formatToolResult delegating to a session-
// specific registry), and an end-to-end toy-format test proving result content
// flows to source:"tool" messages and is mangled at the wire.

import { describe, it, expect } from "bun:test";
import {
  createToolFormatRegistry,
  resolveToolFormatId,
} from "../../src/core/extensions/tool-format.ts";
import { xmlToolFormat } from "../../src/core/extensions/tool-format-xml.ts";
import {
  ToolResult,
  toolResult,
  formatToolResult,
} from "../../src/core/extensions/tool-utils.ts";
import { LlmClient } from "../../src/core/llm-client/client.ts";
import { MarkerMangler } from "../../src/core/marker-mangler.ts";
import { Message } from "../../src/core/context/message.ts";
import type { ModelConfig, ProviderDef } from "../../src/core/config/providers.ts";

function mc(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { name: "prov/model", temperature: null, contextLimit: 128000, tags: [], ...overrides };
}

// Toy format #1: markdown table. Emits raw text; never mangles.
const mdTableFormat: import("../../src/core/extensions/tool-format.ts").ToolFormat = {
  id: "md-table",
  markers: ["tool-result"],
  formatResult(result, toolName, meta) {
    const status = meta?.status || "success";
    const payload = typeof result === "string" ? result : JSON.stringify(result);
    return `| tool | status |\n|---|---|\n| ${toolName} | ${status} |\n\n${payload}`;
  },
};

// Toy format #2: content-parts output (exercises the parts path).
const partsFormat: import("../../src/core/extensions/tool-format.ts").ToolFormat = {
  id: "parts",
  markers: [],
  formatResult(result, toolName, meta) {
    const payload = typeof result === "string" ? result : JSON.stringify(result);
    return [
      { type: "text", text: `[${toolName}]` },
      { type: "text", text: payload },
    ];
  },
};

function regWithToys() {
  const reg = createToolFormatRegistry();
  reg.register(xmlToolFormat);
  reg.register(mdTableFormat);
  reg.register(partsFormat);
  return reg;
}

describe("ToolFormatRegistry", () => {
  it("registers and resolves by id", () => {
    const reg = createToolFormatRegistry();
    expect(reg.has("md-table")).toBe(false);
    reg.register(mdTableFormat);
    expect(reg.has("md-table")).toBe(true);
    expect(reg.get("md-table")).toBe(mdTableFormat);
    expect(reg.names()).toContain("md-table");
  });

  it("rejects formats without an id", () => {
    const reg = createToolFormatRegistry();
    expect(() => reg.register({ ...mdTableFormat, id: "" })).toThrow(/id/);
  });
});

describe("resolveToolFormatId (wireFormat-style chain)", () => {
  const providers: ProviderDef[] = [
    { name: "prov", models: [], toolFormat: "provider-fmt" },
    { name: "other", models: [] },
  ];

  it("model-level wins over provider-level", () => {
    expect(
      resolveToolFormatId({ name: "prov/model", toolFormat: "model-fmt" }, providers, "global-fmt"),
    ).toBe("model-fmt");
  });

  it("provider-level applies when model has none", () => {
    expect(resolveToolFormatId({ name: "prov/model" }, providers, "global-fmt")).toBe("provider-fmt");
  });

  it("falls back to global default when provider has none", () => {
    expect(resolveToolFormatId({ name: "other/model" }, providers, "global-fmt")).toBe("global-fmt");
  });

  it("falls back to xml when nothing is set", () => {
    expect(resolveToolFormatId({ name: "bare/model" }, undefined, undefined)).toBe("xml");
  });
});

describe("active format via LlmClient.toolFormatFor", () => {
  it("resolves model-level toolFormat from ModelConfig", () => {
    const client = new LlmClient({ chatTimeoutSecs: 60, maxRetries: 3, markerMangler: null, toolFormatRegistry: regWithToys() });
    expect(client.toolFormatFor(mc({ name: "prov/model", toolFormat: "md-table" })).id).toBe("md-table");
  });

  it("resolves provider-level toolFormat from providers", () => {
    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 3,
      providers: [{ name: "prov", models: [], toolFormat: "md-table" }],
      toolFormatRegistry: regWithToys(),
    });
    expect(client.toolFormatFor(mc()).id).toBe("md-table");
  });

  it("model-level beats provider-level", () => {
    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 3,
      providers: [{ name: "prov", models: [], toolFormat: "md-table" }],
      toolFormatRegistry: regWithToys(),
    });
    expect(client.toolFormatFor(mc({ toolFormat: "parts" })).id).toBe("parts");
  });

  it("global default (client option) is the floor", () => {
    const client = new LlmClient({ chatTimeoutSecs: 60, maxRetries: 3, toolFormat: "md-table", toolFormatRegistry: regWithToys() });
    expect(client.toolFormatFor(mc()).id).toBe("md-table");
  });

  it("defaults to xml when nothing is configured", () => {
    const client = new LlmClient({ chatTimeoutSecs: 60, maxRetries: 3, markerMangler: null });
    expect(client.toolFormatFor(mc()).id).toBe("xml");
  });

  it("unknown id in the injected registry throws a config error", () => {
    const client = new LlmClient({ chatTimeoutSecs: 60, maxRetries: 3, markerMangler: null, toolFormatRegistry: regWithToys() });
    expect(() => client.toolFormatFor(mc({ toolFormat: "nope" })).id).toThrow(/Unknown tool format "nope"/);
  });

  it("toolFormatFor uses the injected registry, not another session's", () => {
    // A client without an injected registry must not see formats registered
    // on a different (session-specific) registry.
    const otherSessionReg = regWithToys();
    expect(otherSessionReg.has("md-table")).toBe(true);
    const client = new LlmClient({ chatTimeoutSecs: 60, maxRetries: 3, markerMangler: null });
    expect(() => client.toolFormatFor(mc({ toolFormat: "md-table" })).id).toThrow(/Unknown tool format "md-table"/);
  });

  it("exposes the session's registry so the agent loop can resolve seam renders", () => {
    const reg = regWithToys();
    const client = new LlmClient({ chatTimeoutSecs: 60, maxRetries: 3, markerMangler: null, toolFormatRegistry: reg });
    expect(client.toolFormatRegistry).toBe(reg);
  });
});

describe("tool-utils seam delegates to the session's registry", () => {
  const reg = regWithToys();

  it("xml (default) output is unchanged from pre-seam behavior", () => {
    expect(toolResult("plain text", "read", undefined, reg)).toBe(
      '<tool name="read" status="success">\n  <output>plain text</output>\n</tool>',
    );
    const r = ToolResult.ok("hello world");
    expect(r.toApiContent("bash", undefined, reg)).toBe(
      '<tool name="bash" status="success">\n  <output>hello world</output>\n</tool>',
    );
    // short metadata as attributes, long as elements
    const r2 = ToolResult.ok("out").withEntry("page", "1").withEntry("diff", "x");
    expect(r2.toApiContent("edit", undefined, reg)).toContain('page="1"');
    expect(r2.toApiContent("edit", undefined, reg)).toContain("<diff>x</diff>");
  });

  it("md-table format rewrites toolResult() output", () => {
    expect(toolResult("hello", "read", "md-table", reg)).toBe(
      "| tool | status |\n|---|---|\n| read | success |\n\nhello",
    );
  });

  it("md-table format rewrites ToolResult.toApiContent() output", () => {
    const content = ToolResult.ok("payload").toApiContent("bash", "md-table", reg);
    expect(content).toContain("| bash | success |");
    expect(content).toContain("payload");
  });

  it("formatResult may return content parts (parts toy format)", () => {
    const out = toolResult("data", "fetch", "parts", reg);
    // Parts get JSON-stringified at the seam; the wire serializer would emit
    // them as content parts when used in a Message directly.
    expect(out).toContain('"type":"text"');
  });

  it("formatToolResult delegates for plain strings", () => {
    expect(formatToolResult("boom", "bash", false, "md-table", reg)).toContain("| bash | error |");
  });

  it("formatToolResult delegates ToolResult instances via toApiContent", () => {
    expect(formatToolResult(ToolResult.ok("x"), "bash", true, "md-table", reg)).toContain("| bash | success |");
  });

  it("two sessions with different registries do not interfere", () => {
    const sessionA = createToolFormatRegistry();
    sessionA.register(mdTableFormat);
    const sessionB = createToolFormatRegistry();
    // No md-table in session B's registry: an explicit name the session's
    // own registry cannot resolve is a config error (mirrors unknown
    // LlmProtocol ids) -- never a silent fallback to another format.
    expect(toolResult("hello", "read", "md-table", sessionA)).toContain("| read | success |");
    expect(() => toolResult("hello", "read", "md-table", sessionB)).toThrow(
      /Unknown tool format "md-table"/,
    );
  });
});

describe("explicit toolFormatName (agent-loop per-model resolution)", () => {
  const reg = regWithToys();

  it("formatToolResult uses the explicit name over the seam default", () => {
    expect(formatToolResult("boom", "bash", true, "md-table", reg)).toContain("| bash | success |");
    // No explicit name -> xml default.
    expect(formatToolResult("boom", "bash", true, undefined, reg)).toContain('<tool name="bash"');
  });

  it("formatToolResult passes the name through for ToolResult instances", () => {
    expect(formatToolResult(ToolResult.ok("x"), "bash", true, "md-table", reg)).toContain(
      "| bash | success |",
    );
  });

  it("toolResult and toApiContent accept an explicit name", () => {
    expect(toolResult("hello", "read", "md-table", reg)).toContain("| read | success |");
    expect(ToolResult.ok("payload").toApiContent("bash", "md-table", reg)).toContain(
      "| bash | success |",
    );
    // No explicit name -> xml default.
    expect(toolResult("hello", "read", undefined, reg)).toContain('<tool name="read"');
  });
});

describe("xml error element position (pre-seam parity)", () => {
  const reg = createToolFormatRegistry();
  reg.register(xmlToolFormat);

  it("failure: <error> is the first child, before long metadata", () => {
    const content = ToolResult.err("boom").withEntry("diff", "x").toApiContent("bash", undefined, reg);
    const lines = content.split("\n");
    expect(lines[0]).toBe('<tool name="bash" status="failure">');
    expect(lines[1]).toBe("  <error>boom</error>");
    expect(lines[2]).toBe("  <diff>x</diff>");
  });

  it("failure: short metadata still rides in attributes, error still first", () => {
    const content = ToolResult.err("boom").withEntry("page", "1").toApiContent("bash", undefined, reg);
    expect(content.split("\n")[1]).toBe("  <error>boom</error>");
    expect(content).toContain('page="1"');
  });

  it("success with an error metadata key: emitted as plain metadata, not pulled first", () => {
    // "diff" declared first: if the error were unshifted it would jump ahead.
    const content = ToolResult.ok("out")
      .withEntry("diff", "x")
      .withEntry("error", "stale")
      .toApiContent("bash", undefined, reg);
    const lines = content.split("\n");
    expect(lines[1]).toBe("  <diff>x</diff>");
    expect(lines[2]).toBe("  <error>stale</error>");
  });
});

describe("end-to-end: toy format flows to source:tool message and mangles at the wire", () => {
  it("md-table tool result is raw in context, mangled on the wire", async () => {
    const reg = createToolFormatRegistry();
    reg.register(mdTableFormat);

    // The tool-result string as the session's format emits it (raw in context).
    const resultStr = toolResult("The file says <tool-call name=\"x\">", "read", "md-table", reg);
    expect(resultStr).toContain("| read | success |");
    expect(resultStr).toContain("<tool-call name=\"x\">"); // raw, un-mangled

    // It lands in context as a source:"tool" message.
    const msg = new Message({ role: "tool", content: resultStr, toolCallId: "tc1", source: "tool" });

    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 3,
      markerMangler: new MarkerMangler(),
    });
    const request = client.buildChatRequest([msg], mc(), null, false);
    const wireContent = (request.messages as Array<{ content: string }>)[0]!.content as string;

    // Mangled at the wire: the core-protected token in the tool output is
    // aliased by the session mangler (default union = core prefixes),
    // while the raw stored message stays clean.
    expect(wireContent).not.toContain("<tool ");
    expect(wireContent).toMatch(/<m_[a-z2-9]{16}/);
    // Raw context stays clean (the stored message is untouched).
    expect(msg.content).toBe(resultStr);
  });

  it("xml format end-to-end keeps byte-identical tool markup on the wire", async () => {
    const reg = createToolFormatRegistry();
    reg.register(xmlToolFormat);

    const resultStr = ToolResult.ok("hello <b>&'\"").toApiContent("bash", undefined, reg);
    // toApiContent() keeps output raw (pre-seam behavior preserved by the
    // xml format's object path).
    expect(resultStr).toBe(
      '<tool name="bash" status="success">\n  <output>hello <b>&\'"</output>\n</tool>',
    );

    const msg = new Message({ role: "tool", content: resultStr, toolCallId: "tc1", source: "tool" });
    // No mangler: raw text passes through verbatim (the wire serializer is
    // the only mangle point; without a mangler there is nothing to mangle).
    const client = new LlmClient({ chatTimeoutSecs: 60, maxRetries: 3, markerMangler: null });
    const request = client.buildChatRequest([msg], mc(), null, false);
    const wireContent = (request.messages as Array<{ content: string }>)[0]!.content as string;

    // "tool" is not in the core PROTECTED_PREFIXES set for default config,
    // so the XML markup passes through verbatim at the wire.
    expect(wireContent).toBe(resultStr);
  });
});
