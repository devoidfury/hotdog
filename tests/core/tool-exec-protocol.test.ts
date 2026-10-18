// Tool exec protocol: line codec + error/result serialization round-trips.
// Pure unit tests -- no spawned processes (see tool-exec-broker-spawn.test.ts).

import { describe, it, expect } from "bun:test";
import {
  LineDecoder,
  encodeFrame,
  serializeWireError,
  reviveWireError,
  serializeToolResult,
  reviveToolResult,
} from "@core/tool-exec-protocol.ts";
import { ToolResult, TOOL_STOP_LOOP } from "@core/extensions/tool-utils.ts";
import {
  TransientError,
  AssistantRetryableError,
  ToolError,
  formatError,
  isExpectedError,
} from "@core/error.ts";

describe("LineDecoder", () => {
  it("splits complete lines and buffers the partial tail", () => {
    const d = new LineDecoder();
    expect(d.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(d.push('2}\n{"c":3}\n')).toEqual(['{"b":2}', '{"c":3}']);
    expect(d.push("")).toEqual([]);
  });

  it("accepts CRLF terminators and skips blank lines", () => {
    const d = new LineDecoder();
    expect(d.push("one\r\n\r\ntwo\n")).toEqual(["one", "two"]);
  });

  it("flushes an unterminated final line at EOF", () => {
    const d = new LineDecoder();
    expect(d.push("full\npartial")).toEqual(["full"]);
    expect(d.end()).toEqual(["partial"]);
    expect(d.end()).toEqual([]);
  });
});

describe("encodeFrame", () => {
  it("produces a single line that round-trips through JSON.parse", () => {
    const frame = { id: "1", op: "invoke", tool: "bash", ctx: { note: "two\nlines" } };
    const line = encodeFrame(frame);
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual(frame);
  });
});

describe("wire errors", () => {
  it("keeps TransientError retryable across the boundary", () => {
    const revived = reviveWireError(serializeWireError(new TransientError("flaky")));
    expect(revived).toBeInstanceOf(TransientError);
    expect(revived.message).toBe("flaky");
    expect(isExpectedError(revived)).toBe(true);
  });

  it("keeps the AssistantRetryableError hint", () => {
    const w = serializeWireError(
      AssistantRetryableError.WithHint("timed out", "use a faster command"),
    );
    expect(w.hint).toBe("use a faster command");
    const revived = reviveWireError(w);
    expect(revived).toBeInstanceOf(AssistantRetryableError);
    expect((revived as AssistantRetryableError).hint).toBe("use a faster command");
  });

  it("classifies expected errors message-only and unexpected errors with the stack", () => {
    const expected = reviveWireError(serializeWireError(new ToolError("denied")));
    expect(isExpectedError(expected)).toBe(true);
    expect(formatError(expected)).toBe("denied");

    const boom = new Error("bug");
    const w = serializeWireError(boom);
    expect(w.expected).toBe(false);
    const revived = reviveWireError(w);
    expect(isExpectedError(revived)).toBe(false);
    // The classification survives; the stack TEXT survives too (for logs).
    expect(revived.stack).toBe(boom.stack);
  });

  it("stringifies non-Error throws", () => {
    const w = serializeWireError("just a string");
    expect(w.message).toBe("just a string");
    expect(w.expected).toBe(false);
  });
});

describe("wire results", () => {
  it("round-trips a full ToolResult with metadata, hint, images, and stop-loop", () => {
    const tr = ToolResult.ok("out")
      .withEntries({ a: "1", b: 2 })
      .withHint("do better")
      .withImages([{ type: "image" }]);
    const w = serializeToolResult(tr) as Extract<
      ReturnType<typeof serializeToolResult>,
      { kind: "tool-result" }
    >;
    expect(w.kind).toBe("tool-result");
    expect(w.metadata).toEqual([["a", "1"], ["b", "2"]]);

    const revived = reviveToolResult(serializeToolResult(tr.withStopLoop()));
    expect(revived).toBeInstanceOf(ToolResult);
    const r = revived as ToolResult;
    expect(r.output).toBe("out");
    expect(r.hint).toBe("do better");
    expect(r.images).toEqual([{ type: "image" }]);
    expect((revived as Record<symbol, unknown>)[TOOL_STOP_LOOP]).toBe(true);
    expect(r.toApiContent("t").status).toBe("success");
  });

  it("round-trips a failed ToolResult", () => {
    const revived = reviveToolResult(serializeToolResult(ToolResult.err("nope")));
    expect(revived).toBeInstanceOf(ToolResult);
    expect((revived as ToolResult).success).toBe(false);
    expect((revived as ToolResult).error).toBe("nope");
  });

  it("keeps plain return values under the value discriminator", () => {
    expect(reviveToolResult(serializeToolResult("text"))).toBe("text");
    expect(reviveToolResult(serializeToolResult({ n: 1 }))).toEqual({ n: 1 });
  });

  it("stringifies values that cannot survive JSON transport", () => {
    const cyc: Record<string, unknown> = { name: "loop" };
    cyc.self = cyc;
    const w = serializeToolResult(cyc);
    expect(w.kind).toBe("value");
    // Stringified rather than dropped: the frame still encodes cleanly.
    expect(typeof (w as { value: unknown }).value).toBe("string");
    expect(() => encodeFrame(w)).not.toThrow();
  });
});
