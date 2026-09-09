// Unit tests for repairToolCalls — the pure invariant: every assistant
// tool_call gets exactly one tool result before the next assistant message.

import { test, expect } from "bun:test";
import { Message } from "@core/context/message.ts";
import { repairToolCalls, INTERRUPTED_TOOL_RESULT } from "@core/context/repair.ts";

// ── Builders ─────────────────────────────────────────────────────────────────

function user(text: string) {
  return new Message({ role: "user", content: text, source: "user" });
}
function assistant(text: string) {
  return new Message({ role: "assistant", content: text, source: "model" });
}
function assistantWithCalls(calls: Array<{ id: string; name?: string }>, text = "") {
  return new Message({
    role: "assistant",
    content: text,
    toolCalls: calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name ?? "bash", arguments: "{}" },
    })),
    source: "model",
  });
}
function toolResult(id: string | null, content = "ok") {
  return new Message({ role: "tool", content, toolCallId: id, source: "tool" });
}

// ── Healthy logs are a no-op ─────────────────────────────────────────────────

test("healthy single call + result is a no-op", () => {
  const msgs = [user("hi"), assistantWithCalls([{ id: "a" }]), toolResult("a"), assistant("done")];
  const { messages, repaired, dropped } = repairToolCalls(msgs);
  expect(repaired).toEqual([]);
  expect(dropped).toEqual([]);
  expect(messages.length).toBe(4);
  // Same instances pass through untouched.
  expect(messages[0]).toBe(msgs[0]);
  expect(messages[1]).toBe(msgs[1]);
  expect(messages[2]).toBe(msgs[2]);
  expect(messages[3]).toBe(msgs[3]);
});

test("input array is never mutated", () => {
  const originalAssistant = assistantWithCalls([{ id: "a" }]);
  const msgs = [user("hi"), originalAssistant];
  repairToolCalls(msgs);
  expect(msgs).toHaveLength(2);
  expect(msgs[1]).toBe(originalAssistant); // identity preserved
});

test("no messages in, no messages out", () => {
  const { messages, repaired, dropped } = repairToolCalls([]);
  expect(messages).toEqual([]);
  expect(repaired).toEqual([]);
  expect(dropped).toEqual([]);
});

test("no assistant at all is a no-op", () => {
  const msgs = [user("hi"), assistant("hello")];
  const { messages, repaired } = repairToolCalls(msgs);
  expect(repaired).toEqual([]);
  expect(messages).toHaveLength(2);
});

// ── Dangling calls get synthesized results ───────────────────────────────────

test("crash fixture: assistant with 3 calls and 1 result -> 2 synthesized", () => {
  const msgs = [
    user("do three things"),
    assistantWithCalls([{ id: "a" }, { id: "b" }, { id: "c" }]),
    toolResult("a", "real"),
  ];
  const { messages, repaired, dropped } = repairToolCalls(msgs);
  expect(dropped).toEqual([]);
  expect(repaired).toEqual(["b", "c"]);

  // Real result keeps its position; synthesized results are appended after it.
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "tool"]);
  expect(messages[2]!.toolCallId).toBe("a");
  expect(messages[2]!.content).toBe("real");
  expect(messages[3]!.toolCallId).toBe("b");
  expect(messages[4]!.toolCallId).toBe("c");

  // Every synthesized result carries the pinned content + harness provenance.
  for (const m of [messages[3]!, messages[4]!]) {
    expect(m.content).toBe(INTERRUPTED_TOOL_RESULT);
    expect(m.source).toBe("harness");
  }
});

test("end-of-log assistant with calls synthesizes for every call", () => {
  const msgs = [user("go"), assistantWithCalls([{ id: "a" }, { id: "b" }])];
  const { messages, repaired } = repairToolCalls(msgs);
  expect(repaired).toEqual(["a", "b"]);
  expect(messages).toHaveLength(4);
});

test("partial execution: one result landed, the rest interrupted, then a later turn", () => {
  const msgs = [
    user("do two things"),
    assistantWithCalls([{ id: "a" }, { id: "b" }]),
    toolResult("a", "real"),
    // "b" was interrupted; the session continued on a later turn
    assistant("final answer"),
  ];
  const { messages, repaired } = repairToolCalls(msgs);
  expect(repaired).toEqual(["b"]);
  // Real result keeps its slot; the synthesized one is appended at the block
  // end, so both results sit before the next assistant.
  const roles = messages.map((m) => m.role);
  expect(roles).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
  expect(messages[2]!.toolCallId).toBe("a");
  expect(messages[3]!.toolCallId).toBe("b");
  expect(messages[3]!.content).toBe(INTERRUPTED_TOOL_RESULT);
});

test("repair is idempotent (re-repairing a repaired log changes nothing)", () => {
  const once = repairToolCalls([user("go"), assistantWithCalls([{ id: "a" }])]);
  const twice = repairToolCalls(once.messages);
  expect(twice.repaired).toEqual([]);
  expect(twice.dropped).toEqual([]);
  expect(twice.messages).toHaveLength(once.messages.length);
  // The previously synthesized result is a satisfied call now; not touched.
  expect(twice.messages[2]).toBe(once.messages[2]);
});

// ── Orphan + duplicate results are dropped ───────────────────────────────────

test("orphan result with a matching-looking id but no call is dropped", () => {
  const u = user("hi");
  const msgs = [u, toolResult("ghost", "orphan")];
  const { messages, dropped } = repairToolCalls(msgs);
  expect(dropped).toEqual(["ghost"]);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toBe(u);
});

test("result whose id matches a call two blocks back is dropped", () => {
  const msgs = [
    user("one"),
    assistantWithCalls([{ id: "a" }]),
    toolResult("a"),
    assistant("between"),
    toolResult("a", "too late"),
    assistant("after"),
  ];
  const { messages, dropped } = repairToolCalls(msgs);
  expect(dropped).toEqual(["a"]);
  // The valid first result survives; the late one is gone.
  expect(messages.map((m) => m.toolCallId).filter((id) => id)).toEqual(["a"]);
});

test("duplicate result for the same call keeps exactly one", () => {
  const msgs = [
    user("hi"),
    assistantWithCalls([{ id: "a" }]),
    toolResult("a", "first"),
    toolResult("a", "second"),
  ];
  const { messages, dropped } = repairToolCalls(msgs);
  expect(dropped).toEqual(["a"]);
  expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);
  expect(messages.find((m) => m.role === "tool")!.content).toBe("first");
});

test("result with a null tool_call_id is dropped (missing-id label)", () => {
  const msgs = [user("hi"), assistantWithCalls([{ id: "a" }]), toolResult(null), toolResult("a")];
  const { dropped, repaired } = repairToolCalls(msgs);
  expect(dropped).toEqual(["(missing id)"]);
  expect(repaired).toEqual([]);
});

// ── Edge shapes ──────────────────────────────────────────────────────────────

test("assistant with an empty toolCalls array is treated as a plain response", () => {
  const msgs = [user("hi"), new Message({ role: "assistant", content: "x", toolCalls: [], source: "model" })];
  const { repaired } = repairToolCalls(msgs);
  expect(repaired).toEqual([]);
});

test("non-tool messages inside a block are preserved in place", () => {
  const msgs = [
    user("hi"),
    assistantWithCalls([{ id: "a" }]),
    new Message({ role: "harness", content: "note", source: "harness" }),
    toolResult("a"),
  ];
  const { messages, repaired, dropped } = repairToolCalls(msgs);
  expect(repaired).toEqual([]);
  expect(dropped).toEqual([]);
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "harness", "tool"]);
});

test("mixed dangling + orphan in one log", () => {
  const msgs = [
    user("one"),
    assistantWithCalls([{ id: "a" }, { id: "b" }]),
    toolResult("a"),
    toolResult("zzz", "orphan"),
    assistant("next"),
    toolResult("orphan2", "no call at all"),
  ];
  const { messages, repaired, dropped } = repairToolCalls(msgs);
  expect(repaired).toEqual(["b"]);
  expect(dropped).toEqual(["zzz", "orphan2"]);
  // Wire-valid result: every assistant call has exactly one result.
  const toolIds = messages.filter((m) => m.role === "tool").map((m) => m.toolCallId);
  expect(toolIds.sort()).toEqual(["a", "b"]);
});

// ── The point: a repaired log serializes to a clean request ─────────────────

test("repaired output has no dangling call and no orphan result", () => {
  const msgs = [
    user("go"),
    assistantWithCalls([{ id: "a" }, { id: "b" }, { id: "c" }]),
    toolResult("c"),
  ];
  const { messages } = repairToolCalls(msgs);

  // Walk the wire shape: collect declared call ids and result ids.
  const declared = new Set<string>();
  const results = new Set<string>();
  let open: Set<string> | null = null;
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      open = new Set(m.toolCalls.map((tc) => tc.id));
      open.forEach((id) => declared.add(id));
    } else if (m.role === "tool") {
      expect(open, "tool result with no open calls").not.toBeNull();
      expect(open!.has(m.toolCallId ?? ""), "orphan result survived").toBe(true);
      results.add(m.toolCallId ?? "");
      open!.delete(m.toolCallId ?? "");
    } else if (m.role === "assistant" && !m.toolCalls) {
      expect([...(open ?? [])].length, "dangling call at assistant boundary").toBe(0);
      open = null;
    }
  }
  expect([...(open ?? [])].length, "dangling call at end-of-log").toBe(0);
  expect(declared.size).toBe(3);
  expect(results.size).toBe(3);
});
