import { describe, it, expect } from "bun:test";
import { Message } from "@core/context/message.ts";
import { trimTurns } from "@core/context/rewind.ts";

function msg(role: string, content: string): Message {
  return new Message({ role, content });
}

function convo(): Message[] {
  return [
    msg("system", "sys prompt"),
    msg("user", "u1"),
    msg("assistant", "a1"),
    msg("tool", "t1"),
    msg("assistant", "a2"),
    msg("user", "u2"),
    msg("harness", "compaction summary"),
    msg("user", "u3"),
    msg("assistant", "a3"),
  ];
}

describe("trimTurns", () => {
  it("drops the last turn (user message plus everything after it)", () => {
    const { kept, droppedTurns, totalTurns } = trimTurns(convo(), 1);
    expect(droppedTurns).toBe(1);
    expect(totalTurns).toBe(3);
    expect(kept.map((m) => m.content)).toEqual([
      "sys prompt", "u1", "a1", "t1", "a2", "u2", "compaction summary",
    ]);
  });

  it("drops N turns back to the Nth-from-last user message", () => {
    const { kept, droppedTurns } = trimTurns(convo(), 2);
    expect(droppedTurns).toBe(2);
    expect(kept.map((m) => m.content)).toEqual(["sys prompt", "u1", "a1", "t1", "a2"]);
  });

  it("drops every turn when N >= totalTurns, keeping the pre-user prefix", () => {
    for (const n of [3, 4, 99]) {
      const { kept, droppedTurns, totalTurns } = trimTurns(convo(), n);
      expect(droppedTurns).toBe(totalTurns);
      expect(kept.map((m) => m.content)).toEqual(["sys prompt"]);
    }
  });

  it("keeps everything when there are no user turns", () => {
    const msgs = [msg("system", "s"), msg("assistant", "a")];
    const { kept, droppedTurns } = trimTurns(msgs, 1);
    expect(droppedTurns).toBe(0);
    expect(kept).toHaveLength(2);
  });

  it("turns <= 0 is a no-op copy", () => {
    const { kept, droppedTurns } = trimTurns(convo(), 0);
    expect(droppedTurns).toBe(0);
    expect(kept.map((m) => m.content)).toEqual(convo().map((m) => m.content));
  });

  it("a trailing dangling assistant(tool_calls) drops with its turn", () => {
    const msgs = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("user", "u2"),
      new Message({ role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }] }),
    ];
    const { kept } = trimTurns(msgs, 1);
    expect(kept.map((m) => m.content)).toEqual(["u1", "a1"]);
    // No dangling tool call left behind: kept ends with an assistant text msg.
    expect(kept[kept.length - 1]!.toolCalls).toBeNull();
  });

  it("does not mutate the input array", () => {
    const msgs = convo();
    const before = msgs.map((m) => m.content);
    trimTurns(msgs, 2);
    expect(msgs.map((m) => m.content)).toEqual(before);
  });
});
