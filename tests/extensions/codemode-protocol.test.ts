// codemode host<->child wire protocol: direct unit tests for the parse leg.
// The bridge only ever emits well-formed frames, so the violation branches
// are unreachable through integration runs, and parseHostFrame executes
// inside the child (a separate process, invisible to coverage). Both parsers
// are tested here, one case per structural rule: a null return means "the
// peer's stream cannot be trusted", so each rejection is pinned.

import { describe, expect, it } from "bun:test";

import {
  createFrameDecoder,
  encodeLine,
  FrameOverflowError,
  NON_CALLABLE,
  parseChildFrame,
  parseHostFrame,
  RUNNER_CAP_EXIT,
} from "@experimental/codemode/host/protocol.ts";
import { FRAME_MAX_BYTES } from "@experimental/codemode/options.ts";

describe("protocol constants and framing", () => {
  it("pins the non-callable name and the cap exit code", () => {
    expect(NON_CALLABLE).toBe("codemode");
    expect(RUNNER_CAP_EXIT).toBe(86);
  });

  it("encodeLine emits the frame plus the NDJSON terminator", () => {
    expect(encodeLine({ t: "out", item: { kind: "text", text: "hi" } })).toBe(
      '{"t":"out","item":{"kind":"text","text":"hi"}}\n',
    );
  });

  it("createFrameDecoder decodes lines at the codemode cap and fails on overflow", () => {
    const decoder = createFrameDecoder();
    expect(decoder.push('{"t":"done","ok":true}\n')).toEqual(['{"t":"done","ok":true}']);
    // One byte past the cap is a violation; the decoder stays failed after it.
    expect(() => decoder.push("x".repeat(FRAME_MAX_BYTES + 1) + "\n")).toThrow(FrameOverflowError);
    expect(() => decoder.push("{}\n")).toThrow(FrameOverflowError);
  });
});

describe("parseChildFrame", () => {
  it("rejects non-JSON and non-object payloads", () => {
    expect(parseChildFrame("not json")).toBeNull();
    expect(parseChildFrame("[1,2]")).toBeNull();
    expect(parseChildFrame("7")).toBeNull();
    expect(parseChildFrame("null")).toBeNull();
  });

  it("accepts call frames and passes args through verbatim", () => {
    expect(parseChildFrame(JSON.stringify({ t: "call", id: 3, name: "bash", args: { command: "ls" } })))
      .toEqual({ t: "call", id: 3, name: "bash", args: { command: "ls" } });
    expect(parseChildFrame('{"t":"call","id":0,"name":"x"}'))
      .toEqual({ t: "call", id: 0, name: "x", args: undefined });
  });

  it("rejects call frames with a non-numeric id or non-string name", () => {
    expect(parseChildFrame(JSON.stringify({ t: "call", id: "1", name: "bash" }))).toBeNull();
    expect(parseChildFrame(JSON.stringify({ t: "call", id: 1, name: 5 }))).toBeNull();
  });

  it("accepts meta searchTools with and without a numeric limit", () => {
    expect(parseChildFrame(JSON.stringify({ t: "meta", id: 1, op: "searchTools", query: "file" })))
      .toEqual({ t: "meta", id: 1, op: "searchTools", query: "file" });
    expect(parseChildFrame(JSON.stringify({ t: "meta", id: 1, op: "searchTools", query: "f", limit: 3 })))
      .toEqual({ t: "meta", id: 1, op: "searchTools", query: "f", limit: 3 });
    // A non-numeric limit is absent from the frame, not coerced.
    const parsed = parseChildFrame(JSON.stringify({ t: "meta", id: 1, op: "searchTools", query: "f", limit: "3" }));
    expect(Object.prototype.hasOwnProperty.call(parsed, "limit")).toBe(false);
  });

  it("accepts meta describeTool and rejects malformed meta", () => {
    expect(parseChildFrame(JSON.stringify({ t: "meta", id: 2, op: "describeTool", name: "bash" })))
      .toEqual({ t: "meta", id: 2, op: "describeTool", name: "bash" });
    expect(parseChildFrame(JSON.stringify({ t: "meta", id: 2, op: "describeTool", name: 7 }))).toBeNull();
    expect(parseChildFrame(JSON.stringify({ t: "meta", id: 2, op: "doTheThing", name: "x" }))).toBeNull();
    expect(parseChildFrame(JSON.stringify({ t: "meta", op: "describeTool", name: "x" }))).toBeNull();
  });

  it("accepts text out frames and rejects any other item shape", () => {
    expect(parseChildFrame(JSON.stringify({ t: "out", item: { kind: "text", text: "hi" } })))
      .toEqual({ t: "out", item: { kind: "text", text: "hi" } });
    expect(parseChildFrame(JSON.stringify({ t: "out" }))).toBeNull();
    expect(parseChildFrame(JSON.stringify({ t: "out", item: { kind: "image", text: "x" } }))).toBeNull();
    expect(parseChildFrame(JSON.stringify({ t: "out", item: { kind: "text", text: 3 } }))).toBeNull();
  });

  it("requires the store frame's value key to be present", () => {
    expect(parseChildFrame(JSON.stringify({ t: "store", id: 1, key: "k", value: null })))
      .toEqual({ t: "store", id: 1, key: "k", value: null });
    expect(parseChildFrame('{"t":"store","id":1,"key":"k"}')).toBeNull();
    expect(parseChildFrame(JSON.stringify({ t: "store", id: "1", key: "k", value: 1 }))).toBeNull();
    expect(parseChildFrame(JSON.stringify({ t: "store", id: 1, key: 2, value: 1 }))).toBeNull();
  });

  it("accepts load and rejects malformed load", () => {
    expect(parseChildFrame(JSON.stringify({ t: "load", id: 4, key: "k" }))).toEqual({ t: "load", id: 4, key: "k" });
    expect(parseChildFrame(JSON.stringify({ t: "load", id: 4 }))).toBeNull();
    expect(parseChildFrame(JSON.stringify({ t: "load", key: "k" }))).toBeNull();
  });

  it("accepts done ok with optional value; done err needs its error", () => {
    expect(parseChildFrame(JSON.stringify({ t: "done", ok: true, value: 42 })))
      .toEqual({ t: "done", ok: true, value: 42 });
    expect(parseChildFrame('{"t":"done","ok":true}')).toEqual({ t: "done", ok: true, value: undefined });
    expect(parseChildFrame(JSON.stringify({ t: "done", ok: false, error: "boom" })))
      .toEqual({ t: "done", ok: false, error: "boom" });
    expect(parseChildFrame('{"t":"done","ok":false}')).toBeNull();
    expect(parseChildFrame(JSON.stringify({ t: "done", ok: "yes" }))).toBeNull();
  });

  it("rejects an unknown frame type", () => {
    expect(parseChildFrame(JSON.stringify({ t: "banana" }))).toBeNull();
  });
});

describe("parseHostFrame", () => {
  it("rejects non-JSON and non-object payloads", () => {
    expect(parseHostFrame("{oops")).toBeNull();
    expect(parseHostFrame("[]")).toBeNull();
  });

  it("accepts a run frame, defaults calls to 0, and strips opts to the contract", () => {
    expect(parseHostFrame(JSON.stringify({
      t: "run", src: "code", opts: { timeout_ms: 1000, max_output_chars: 500, extra: 1 }, names: ["bash"],
    }))).toEqual({
      t: "run", src: "code", opts: { timeout_ms: 1000, max_output_chars: 500 }, calls: 0, names: ["bash"],
    });
    expect(parseHostFrame(JSON.stringify({
      t: "run", src: "x", opts: { timeout_ms: 1, max_output_chars: 1 }, calls: 5, names: [],
    }))).toMatchObject({ calls: 5 });
  });

  it("rejects run frames with malformed src, calls, opts, or names", () => {
    const base = { t: "run", opts: { timeout_ms: 1, max_output_chars: 1 }, names: [] };
    expect(parseHostFrame(JSON.stringify(base))).toBeNull(); // src missing
    expect(parseHostFrame(JSON.stringify({ ...base, src: 5 }))).toBeNull();
    expect(parseHostFrame(JSON.stringify({ ...base, src: "x", calls: "3" }))).toBeNull();
    expect(parseHostFrame(JSON.stringify({ ...base, src: "x", opts: null }))).toBeNull();
    expect(parseHostFrame(JSON.stringify({ ...base, src: "x", opts: { timeout_ms: "1", max_output_chars: 1 } }))).toBeNull();
    expect(parseHostFrame(JSON.stringify({ ...base, src: "x", opts: { timeout_ms: 1 } }))).toBeNull();
    expect(parseHostFrame(JSON.stringify({ t: "run", src: "x", opts: { timeout_ms: 1, max_output_chars: 1 }, names: ["ok", 2] }))).toBeNull();
    expect(parseHostFrame(JSON.stringify({ t: "run", src: "x", opts: { timeout_ms: 1, max_output_chars: 1 } }))).toBeNull(); // names missing
  });

  it("normalizes an ok res payload (hint/error default null, meta defaults [])", () => {
    expect(parseHostFrame(JSON.stringify({
      t: "res", id: 1, ok: true, payload: { output: "out", hint: "h", error: "e", meta: [1] },
    }))).toEqual({ t: "res", id: 1, ok: true, payload: { output: "out", hint: "h", error: "e", meta: [1] } });
    expect(parseHostFrame(JSON.stringify({ t: "res", id: 1, ok: true, payload: { output: "out" } })))
      .toEqual({ t: "res", id: 1, ok: true, payload: { output: "out", hint: null, error: null, meta: [] } });
    expect(parseHostFrame(JSON.stringify({ t: "res", id: 1, ok: true, payload: { output: "o", hint: 7, error: 8, meta: {} } })))
      .toEqual({ t: "res", id: 1, ok: true, payload: { output: "o", hint: null, error: null, meta: [] } });
  });

  it("rejects res frames missing id/ok, with a bad payload, or an err without error", () => {
    expect(parseHostFrame(JSON.stringify({ t: "res", ok: true, payload: { output: "o" } }))).toBeNull();
    expect(parseHostFrame(JSON.stringify({ t: "res", id: 1, payload: { output: "o" } }))).toBeNull();
    expect(parseHostFrame(JSON.stringify({ t: "res", id: 1, ok: true }))).toBeNull();
    expect(parseHostFrame(JSON.stringify({ t: "res", id: 1, ok: true, payload: { output: 7 } }))).toBeNull();
    expect(parseHostFrame(JSON.stringify({ t: "res", id: 1, ok: false }))).toBeNull();
    expect(parseHostFrame(JSON.stringify({ t: "res", id: 1, ok: false, error: 7 }))).toBeNull();
    expect(parseHostFrame(JSON.stringify({ t: "res", id: 1, ok: false, error: "boom" })))
      .toEqual({ t: "res", id: 1, ok: false, error: "boom" });
  });

  it("rejects an unknown frame type", () => {
    expect(parseHostFrame(JSON.stringify({ t: "banana" }))).toBeNull();
  });
});
