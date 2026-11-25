// Tests for src/extensions/ui-rpc/protocol.ts — the JSONL machine protocol:
// record construction, OutputEvent name mapping, and inbound command
// validation. Server behavior lives in rpc-server.test.ts.

import { describe, it, expect } from "bun:test";
import {
  EVENT_NAME_MAP,
  OUTPUT_EVENT,
  type OutputEvent,
} from "@core/context/output.ts";
import {
  JsonlEventWriter,
  RPC_PROTOCOL,
  RPC_PROTOCOL_VERSION,
  askRecord,
  errorRecord,
  eventRecord,
  helloRecord,
  parseCommandLine,
  replyRecord,
  resultRecord,
} from "@extensions/ui-rpc/protocol.ts";

describe("eventRecord", () => {
  it("maps every OUTPUT_EVENT type to its EVENT_NAME_MAP name", () => {
    for (const [name, type] of Object.entries(EVENT_NAME_MAP)) {
      const rec = eventRecord({ type } as OutputEvent, 1, "s1");
      expect(rec.type).toBe("event");
      expect(rec.event).toBe(name);
      expect(rec.session).toBe("s1");
      expect(rec.seq).toBe(1);
      expect(rec.v).toBe(RPC_PROTOCOL_VERSION);
    }
  });

  it("strips the numeric type from data and keeps the remaining fields", () => {
    const event = {
      type: OUTPUT_EVENT.TOOL_CALL,
      toolName: "bash",
      input: '{"command":"ls"}',
      toolCallId: "tc1",
    } as unknown as OutputEvent;
    const rec = eventRecord(event, 7, "s1");
    expect(rec.data).toEqual({ toolName: "bash", input: '{"command":"ls"}', toolCallId: "tc1" });
    expect((rec.data as Record<string, unknown>).type).toBeUndefined();
  });

  it("names an unmapped type unknown and carries the number for triage", () => {
    const rec = eventRecord({ type: 999 } as unknown as OutputEvent, 2, null);
    expect(rec.event).toBe("unknown");
    expect(rec.t).toBe(999);
    expect(rec.session).toBeUndefined();
  });
});

describe("control records", () => {
  it("hello names protocol, version, and session", () => {
    const rec = helloRecord("s1", "provider/model");
    expect(rec).toEqual({
      v: 1,
      type: "hello",
      protocol: RPC_PROTOCOL,
      version: RPC_PROTOCOL_VERSION,
      session: "s1",
      model: "provider/model",
    });
  });

  it("reply echoes the correlation id and carries error/data", () => {
    expect(replyRecord(3, true)).toEqual({ v: 1, type: "reply", id: 3, ok: true });
    expect(replyRecord(null, false, { error: "nope" })).toEqual({
      v: 1,
      type: "reply",
      id: null,
      ok: false,
      error: "nope",
    });
  });

  it("error carries the message; ask carries questions; result carries exit code", () => {
    expect(errorRecord("bad line")).toEqual({ v: 1, type: "error", message: "bad line" });
    const ask = askRecord("a1", [{ key: "k", prompt: "p?" }], "s1");
    expect(ask.askId).toBe("a1");
    expect((ask.data as { questions: unknown[] }).questions).toHaveLength(1);
    expect(resultRecord("s1", 0)).toEqual({ v: 1, type: "result", session: "s1", ok: true, exitCode: 0 });
    expect(resultRecord(null, 2).ok).toBe(false);
  });
});

describe("parseCommandLine", () => {
  it("accepts a prompt with a correlation id", () => {
    const parsed = parseCommandLine('{"id":7,"cmd":"prompt","text":"hello"}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.command).toEqual({ id: 7, cmd: "prompt", text: "hello" });
    }
  });

  it("ignores unknown fields (forward compatibility)", () => {
    const parsed = parseCommandLine('{"cmd":"prompt","text":"hi","futureField":{"a":1}}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.command.text).toBe("hi");
  });

  it("rejects malformed JSON and non-object records with no id", () => {
    expect(parseCommandLine("{oops").ok).toBe(false);
    const arr = parseCommandLine("[1,2]");
    expect(!arr.ok && arr.id).toBe(null);
  });

  it("echoes the id on record-level rejections so clients can correlate", () => {
    const parsed = parseCommandLine('{"id":"c1","cmd":"teleport"}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.id).toBe("c1");
      expect(parsed.error).toContain("teleport");
    }
  });

  it("requires non-empty text on prompt but not on cancel/interrupt", () => {
    expect(parseCommandLine('{"cmd":"prompt","text":"  "}').ok).toBe(false);
    expect(parseCommandLine('{"cmd":"cancel"}').ok).toBe(true);
    expect(parseCommandLine('{"cmd":"interrupt","session":"s2"}').ok).toBe(true);
  });

  it("validates answer asks for askId and an answers object", () => {
    expect(parseCommandLine('{"cmd":"answer"}').ok).toBe(false);
    expect(parseCommandLine('{"cmd":"answer","askId":"a1"}').ok).toBe(false);
    const parsed = parseCommandLine('{"cmd":"answer","askId":"a1","answers":{"k":"v"}}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.command.answers).toEqual({ k: "v" });
  });

  it("rejects ids that are not string or number", () => {
    expect(parseCommandLine('{"id":{"a":1},"cmd":"status"}').ok).toBe(false);
  });

  it("rejects a non-string cmd with the id echoed for correlation", () => {
    const parsed = parseCommandLine('{"id":3,"cmd":5}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("cmd must be a string");
      expect(parsed.id).toBe(3);
    }
  });

  it("rejects non-string text and session fields", () => {
    const text = parseCommandLine('{"cmd":"status","text":5}');
    expect(text.ok).toBe(false);
    if (!text.ok) expect(text.error).toContain("text must be a string");
    const session = parseCommandLine('{"cmd":"cancel","session":true}');
    expect(session.ok).toBe(false);
    if (!session.ok) expect(session.error).toContain("session must be a string");
  });
});

describe("JsonlEventWriter", () => {
  it("writes newline-terminated records with a monotonic seq", () => {
    const lines: string[] = [];
    const writer = new JsonlEventWriter((line) => lines.push(line));
    writer.emit({ type: OUTPUT_EVENT.USER_MESSAGE, content: "hi" } as OutputEvent, "s1");
    writer.writeRecord(errorRecord("boom"));
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.endsWith("\n"))).toBe(true);
    const first = JSON.parse(lines[0]!);
    expect(first).toEqual({
      v: 1,
      type: "event",
      seq: 1,
      session: "s1",
      event: "user_message",
      data: { content: "hi" },
    });
    expect(JSON.parse(lines[1]!).seq).toBeUndefined();
    expect(writer.seq).toBe(1);
  });
});
