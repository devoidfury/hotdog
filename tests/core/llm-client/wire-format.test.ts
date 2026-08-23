// Wire-format tests.
//
// Phase 0 pinned the pre-extraction behavior of LlmClient.buildChatRequest
// (characterization); phase 2 moved serialization into
// src/core/llm-client/serialize.ts and flipped the `images` leak assertion.
// Assertions marked "BUG (fixed in phase N)" document known issues that
// flip in later phases; everything else must survive refactors intact.
//
// NOTE: protected marker tags are built by string concatenation, never as
// literal tag text, so the mangler-alias fossil scan stays green.

import { describe, it, expect } from "bun:test";
import { LlmClient } from "../../../src/core/llm-client/client.ts";
import { MarkerMangler, buildAliasPattern } from "../../../src/core/marker-mangler.ts";
import { Message } from "../../../src/core/context/message.ts";
import type { ModelConfig } from "../../../src/core/config/providers.ts";

function mc(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { name: "gpt-4", temperature: null, contextLimit: 128000, tags: [], ...overrides };
}

// Protected marker names (from marker-mangler.ts PROTECTED_PREFIXES),
// assembled as tags at runtime.
const SUMMARY_TAG = "previous-context-summary";
const FILE_TAG = "file-include";
const TASK_TAG = "task-result";
const tag = (name: string): string => `<${name}>`;
const closedTag = (name: string, inner: string): string => `<${name}>${inner}</${name}>`;

// Mixed conversation: system, user, harness, assistant w/ tool_calls, tool,
// user w/ images. Every message carries its provenance source.
function sampleMessages(): Message[] {
  return [
    new Message({ role: "system", source: "system", content: "You are a test harness." }),
    new Message({ role: "user", source: "user", content: "Do the thing" }),
    new Message({ role: "harness", source: "harness", content: "Continuing from summary." }),
    new Message({
      role: "assistant",
      source: "model",
      content: "Let me check",
      toolCalls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: '{"cmd": "ls"}' } }],
    }),
    new Message({ role: "tool", source: "tool", content: "file1\nfile2", toolCallId: "tc1" }),
    new Message({
      role: "user",
      source: "user",
      content: "What is this?",
      images: [{ type: "image_url", mimeType: "image/png", data: "aW1hZ2U=" }],
    }),
  ];
}

// The exact wire shape for sampleMessages() (null mangler).
// JSON.stringify-equality also pins key order per message.
// NOTE: the internal `images` array is intentionally NOT a wire field --
// image parts live inside `content` (see serializer). Phase 0 characterized
// the pre-extraction leak of `images` onto the wire; phase 2 dropped it.
const WIRE_SHAPE = [
  { role: "system", content: "You are a test harness." },
  { role: "user", content: "Do the thing" },
  // Internal role "harness" rides "user" on the wire (system-first).
  { role: "user", content: "Continuing from summary." },
  {
    role: "assistant",
    content: "Let me check",
    tool_calls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: '{"cmd": "ls"}' } }],
  },
  { role: "tool", content: "file1\nfile2", tool_call_id: "tc1" },
  {
    role: "user",
    content: [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
    ],
  },
];

function buildRequest(client: LlmClient, messages: Message[]): Record<string, unknown> {
  return client.buildChatRequest(messages, mc(), null, false);
}

describe("wire-format characterization (phase 0)", () => {
  describe("null mangler: exact wire shape", () => {
    it("serializes a mixed conversation to snake_case wire records", () => {
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: null });
      const request = buildRequest(client, sampleMessages());

      expect(request.model).toBe("gpt-4");
      expect(request.stream).toBe(false);
      expect(request.tools).toBeUndefined();
      expect((request.messages as unknown[]).length).toBe(6);

      // Order-insensitive structural equality.
      expect(request.messages).toEqual(WIRE_SHAPE);
      // Order-sensitive: JSON.stringify compares key order inside objects.
      expect(JSON.stringify(request.messages)).toBe(JSON.stringify(WIRE_SHAPE));

      // Provenance is internal-only: `source` never rides the wire.
      for (const m of request.messages as Array<Record<string, unknown>>) {
        expect(m).not.toHaveProperty("source");
      }

      // Phase 2 fix: the internal `images` key no longer rides the wire;
      // image data reaches the model only via content parts.
      const withImages = (request.messages as Array<Record<string, unknown>>)[5]!;
      expect(withImages).not.toHaveProperty("images");
    });
  });

  describe("identity mangler: passthrough", () => {
    it("produces the same wire shape as the null mangler", () => {
      const identity = { escape: (s: string) => s, unescape: (s: string) => s, addPrefixes: () => {} } as unknown as MarkerMangler;
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: identity });
      const request = buildRequest(client, sampleMessages());
      expect(JSON.stringify(request.messages)).toBe(JSON.stringify(WIRE_SHAPE));
    });
  });

  describe("real MarkerMangler: role-based rules", () => {
    it("skips system-sourced messages entirely", () => {
      const mangler = new MarkerMangler();
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: mangler });
      const raw = `Rules: wrap old context in ${closedTag(SUMMARY_TAG, "summary")}.`;
      const messages = [new Message({ role: "system", source: "system", content: raw })];
      const request = buildRequest(client, messages);
      const wire = (request.messages as Array<Record<string, unknown>>)[0]!;
      // System defines the markers; it must arrive un-mangled.
      expect(wire.content).toBe(raw);
    });

    it("legacy system-role message without source is untrusted and mangled", () => {
      const mangler = new MarkerMangler();
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: mangler });
      const raw = closedTag(SUMMARY_TAG, "legacy");
      const messages = [new Message({ role: "system", content: raw })];
      const request = buildRequest(client, messages);
      const wire = (request.messages as Array<Record<string, unknown>>)[0]!;
      // Role alone no longer grants trust; provenance does.
      expect(wire.content as string).not.toContain(tag(SUMMARY_TAG));
      expect((wire.content as string).match(buildAliasPattern())).not.toBeNull();
    });

    it("mangles protected markers in user content to a session alias", () => {
      const mangler = new MarkerMangler();
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: mangler });
      const raw = closedTag(SUMMARY_TAG, "we were debugging the parser");
      const messages = [new Message({ role: "user", content: raw })];
      const request = buildRequest(client, messages);
      const wire = (request.messages as Array<Record<string, unknown>>)[0]!;
      const escaped = wire.content as string;
      expect(escaped).not.toContain(tag(SUMMARY_TAG));
      expect(escaped).not.toContain(`</${SUMMARY_TAG}>`);
      expect(escaped.match(buildAliasPattern())).not.toBeNull();
      // The mangler round-trips: what goes out is exactly what unescape brings back.
      expect(mangler.unescape(escaped)).toBe(raw);
    });

    it("mangles assistant content, tool content, and content-part arrays", () => {
      const mangler = new MarkerMangler();
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: mangler });
      const messages = [
        new Message({ role: "assistant", content: closedTag(FILE_TAG, "read it") }),
        new Message({ role: "tool", content: closedTag(TASK_TAG, "done"), toolCallId: "tc1" }),
        new Message({
          role: "user",
          content: closedTag(SUMMARY_TAG, "img"),
          images: [{ type: "image_url", mimeType: "image/png", data: "aW1hZ2U=" }],
        }),
      ];
      const request = buildRequest(client, messages);
      const wire = request.messages as Array<Record<string, unknown>>;

      expect(wire[0]!.content as string).not.toContain(tag(FILE_TAG));
      expect((wire[1]!.content as string).match(buildAliasPattern())).not.toBeNull();

      // Content parts: text parts mangled, non-text parts untouched.
      const parts = wire[2]!.content as Array<Record<string, unknown>>;
      expect(parts).toHaveLength(2);
      expect(parts[0]!.text as string).not.toContain(tag(SUMMARY_TAG));
      expect((parts[0]!.text as string).match(buildAliasPattern())).not.toBeNull();
      expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } });
    });

    it("mangles tool_calls function name and arguments", () => {
      const mangler = new MarkerMangler();
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: mangler });
      const messages = [
        new Message({
          role: "assistant",
          content: "ok",
          toolCalls: [
            {
              id: "tc1",
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ path: closedTag(FILE_TAG, "x") }) },
            },
          ],
        }),
      ];
      const request = buildRequest(client, messages);
      const wire = (request.messages as Array<Record<string, unknown>>)[0]!;
      const fn = (wire.tool_calls as Array<Record<string, unknown>>)[0]!.function as Record<string, unknown>;
      // Plain identifier names pass through escape() unchanged.
      expect(fn.name).toBe("bash");
      expect(fn.arguments as string).not.toContain(tag(FILE_TAG));
      expect((fn.arguments as string).match(buildAliasPattern())).not.toBeNull();
    });

    it("FIXED (phase 3): harness messages keep real markers on the wire", () => {
      // Phase 0 characterized the old bug: harness-injected content (compaction
      // summary, task result) was mangled, so real marker names were rewritten
      // to aliases. Provenance "harness" now exempts it.
      const mangler = new MarkerMangler();
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: mangler });
      const raw = closedTag(SUMMARY_TAG, "harness-injected summary");
      const messages = [new Message({ role: "harness", source: "harness", content: raw })];
      const request = buildRequest(client, messages);
      const wire = (request.messages as Array<Record<string, unknown>>)[0]!;
      expect(wire.role).toBe("user");
      expect(wire.content).toBe(raw);

      // Regression guard: an untrusted user message with the same content is
      // still mangled.
      const messages2 = [new Message({ role: "user", source: "user", content: raw })];
      const request2 = buildRequest(client, messages2);
      const wire2 = (request2.messages as Array<Record<string, unknown>>)[0]!;
      expect(wire2.content as string).not.toContain(tag(SUMMARY_TAG));
      expect((wire2.content as string).match(buildAliasPattern())).not.toBeNull();
    });

    it("model-sourced assistant content is always mangled", () => {
      const mangler = new MarkerMangler();
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: mangler });
      const raw = closedTag(SUMMARY_TAG, "model echo");
      const messages = [new Message({ role: "assistant", source: "model", content: raw })];
      const request = buildRequest(client, messages);
      const wire = (request.messages as Array<Record<string, unknown>>)[0]!;
      expect(wire.content as string).not.toContain(tag(SUMMARY_TAG));
      expect((wire.content as string).match(buildAliasPattern())).not.toBeNull();
    });
  });

  describe("harness provenance exemption (phase 2)", () => {
    it("does not mangle harness messages in system-first format", () => {
      const mangler = new MarkerMangler();
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: mangler });
      const raw = closedTag(SUMMARY_TAG, "harness-injected summary");
      const messages = [
        new Message({ role: "harness", source: "harness", content: raw }),
        new Message({ role: "user", source: "user", content: raw }),
      ];
      const request = buildRequest(client, messages);
      const wire = request.messages as Array<Record<string, unknown>>;

      // Harness message: real markers intact, rides "user" (system-first).
      expect(wire[0]!.role).toBe("user");
      expect(wire[0]!.content).toBe(raw);
      // Untrusted user message: mangled.
      expect(wire[1]!.content as string).not.toContain(tag(SUMMARY_TAG));
      expect((wire[1]!.content as string).match(buildAliasPattern())).not.toBeNull();
    });
  });

  describe("untrusted content parts (raw at rest, mangled at the wire)", () => {
    const PAYLOAD = closedTag(SUMMARY_TAG, "payload");

    it("mangles untrusted parts inside harness messages; trusted parts stay real", () => {
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: new MarkerMangler() });
      const messages = [
        new Message({
          role: "harness",
          source: "harness",
          content: [
            { type: "text", text: `<${SUMMARY_TAG}>` },
            { type: "untrusted", text: PAYLOAD },
            { type: "text", text: `</${SUMMARY_TAG}>` },
          ],
        }),
      ];
      const request = buildRequest(client, messages);
      const wire = (request.messages as Array<Record<string, unknown>>)[0]!;
      const parts = wire.content as Array<Record<string, unknown>>;
      expect(parts).toHaveLength(3);
      // Trusted wrapper parts: real markers, untouched.
      expect(parts[0]!.text).toBe(`<${SUMMARY_TAG}>`);
      expect(parts[2]!.text).toBe(`</${SUMMARY_TAG}>`);
      // Untrusted part: mangled, and renamed to a plain "text" part on the wire.
      expect(parts[1]!.type).toBe("text");
      expect(parts[1]!.text as string).not.toContain(tag(SUMMARY_TAG));
      expect((parts[1]!.text as string).match(buildAliasPattern())).not.toBeNull();
    });

    it("renames untrusted parts to text without a mangler (raw content)", () => {
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: null });
      const messages = [
        new Message({
          role: "harness",
          source: "harness",
          content: [
            { type: "text", text: "frame" },
            { type: "untrusted", text: PAYLOAD },
          ],
        }),
      ];
      const request = buildRequest(client, messages);
      const wire = (request.messages as Array<Record<string, unknown>>)[0]!;
      expect(wire.content).toEqual([
        { type: "text", text: "frame" },
        { type: "text", text: PAYLOAD },
      ]);
    });

    it("mangles untrusted parts in non-harness messages too (belt and braces)", () => {
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: new MarkerMangler() });
      const messages = [
        new Message({
          role: "user",
          source: "user",
          content: [{ type: "untrusted", text: PAYLOAD }],
        }),
      ];
      const request = buildRequest(client, messages);
      const wire = (request.messages as Array<Record<string, unknown>>)[0]!;
      const parts = wire.content as Array<Record<string, unknown>>;
      expect(parts[0]!.type).toBe("text");
      expect(parts[0]!.text as string).not.toContain(tag(SUMMARY_TAG));
      expect((parts[0]!.text as string).match(buildAliasPattern())).not.toBeNull();
    });
  });

  describe("wire format selection (phase 2)", () => {
    it("defaults to system-first when modelConfig.wireFormat is unset", () => {
      const mangler = new MarkerMangler();
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: mangler });
      const messages = [new Message({ role: "harness", source: "harness", content: "x" })];
      const request = client.buildChatRequest(messages, mc(), null, false);
      expect((request.messages as Array<Record<string, unknown>>)[0]!.role).toBe("user");
    });

    it("selects developer format for modelConfig.wireFormat === 'developer'", () => {
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: null });
      const messages = [new Message({ role: "harness", source: "harness", content: "x" })];
      const request = client.buildChatRequest(
        messages,
        mc({ wireFormat: "developer" }),
        null,
        false,
      );
      expect((request.messages as Array<Record<string, unknown>>)[0]!.role).toBe("developer");
    });
  });

  describe("developer format mapping (phase 4)", () => {
    const SUMMARY = closedTag(SUMMARY_TAG, "harness content");

    function mixedConversation(): Message[] {
      return [
        new Message({ role: "system", source: "system", content: "sys" }),
        new Message({ role: "harness", source: "harness", content: SUMMARY }),
        new Message({ role: "user", source: "user", content: SUMMARY }),
        new Message({
          role: "assistant",
          source: "model",
          content: "ack",
          toolCalls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: "{}" } }],
        }),
        new Message({ role: "tool", source: "tool", content: "out", toolCallId: "tc1" }),
      ];
    }

    function roles(
      client: LlmClient,
      messages: Message[],
      wireFormat?: "system-first" | "developer",
    ): string[] {
      const request = client.buildChatRequest(messages, mc(wireFormat ? { wireFormat } : {}), null, false);
      return (request.messages as Array<Record<string, unknown>>).map((m) => m.role as string);
    }

    it("maps harness messages to developer; everything else unchanged", () => {
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: null });
      const messages = mixedConversation();

      expect(roles(client, messages, "developer")).toEqual([
        "system", "developer", "user", "assistant", "tool",
      ]);
      // system-first keeps harness user messages on role:"user".
      expect(roles(client, messages, "system-first")).toEqual([
        "system", "user", "user", "assistant", "tool",
      ]);
      // Unset defaults to system-first.
      expect(roles(client, messages)).toEqual([
        "system", "user", "user", "assistant", "tool",
      ]);
    });

    it("keeps every other field identical to system-first", () => {
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: null });
      const messages = mixedConversation();
      const dev = client.buildChatRequest(messages, mc({ wireFormat: "developer" }), null, false)
        .messages as Array<Record<string, unknown>>;
      const sys = client.buildChatRequest(messages, mc(), null, false)
        .messages as Array<Record<string, unknown>>;

      expect(dev).toHaveLength(sys.length);
      for (let i = 0; i < sys.length; i++) {
        // Roles differ only where the mapping table says so.
        expect({ ...(dev[i] as object), role: 0 }).toEqual({ ...(sys[i] as object), role: 0 });
      }
    });

    it("mangles identically across formats (trust rule is format-agnostic)", () => {
      const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: new MarkerMangler() });
      const messages = mixedConversation();
      const dev = client.buildChatRequest(messages, mc({ wireFormat: "developer" }), null, false)
        .messages as Array<Record<string, unknown>>;
      const sys = client.buildChatRequest(messages, mc(), null, false)
        .messages as Array<Record<string, unknown>>;

      // Harness message: real markers intact in both formats.
      expect(dev[1]!.content).toBe(SUMMARY);
      expect(sys[1]!.content).toBe(SUMMARY);
      // Untrusted user: mangled in both formats, same alias.
      expect(dev[2]!.content).not.toBe(SUMMARY);
      expect(sys[2]!.content).not.toBe(SUMMARY);
      expect(dev[2]!.content).toBe(sys[2]!.content);
    });
  });
});
