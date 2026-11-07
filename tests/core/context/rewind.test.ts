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
    // The harness notice that sat between u2 and the dropped u3 trails the
    // last kept visible message, so the stray-free sweep takes it with the
    // turn (owner ruling): kept ends exactly at u2.
    expect(kept.map((m) => m.content)).toEqual([
      "sys prompt", "u1", "a1", "t1", "a2", "u2",
    ]);
  });

  it("drops N turns back to the Nth-from-last user message", () => {
    const { kept, droppedTurns } = trimTurns(convo(), 2);
    expect(droppedTurns).toBe(2);
    expect(kept.map((m) => m.content)).toEqual(["sys prompt", "u1", "a1", "t1", "a2"]);
  });

  it("sweeps trailing harness/system entries off the kept boundary", () => {
    // A notice injected between a1 and the dropped turn's user message, and
    // an orphan tool result nobody called for, must not dangle after a1.
    const msgs = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("harness", "system reminder"),
      new Message({ role: "tool", content: "orphan", toolCallId: "gone" }),
      msg("user", "u2"),
      msg("assistant", "a2"),
    ];
    const { kept, droppedTurns } = trimTurns(msgs, 1);
    expect(droppedTurns).toBe(1);
    expect(kept.map((m) => m.content)).toEqual(["u1", "a1"]);
  });

  it("swept strays include tool traffic; an answered block rides with its call", () => {
    const msgs = [
      msg("user", "u1"),
      new Message({ role: "assistant", content: "working", toolCalls: [call("c1")] }),
      new Message({ role: "tool", content: "r1", toolCallId: "c1" }), // answered: rides
      msg("harness", "loop-detect nudge"), //                            trails: swept
      msg("user", "u2"),
      msg("assistant", "a2"),
    ];
    const { kept } = trimTurns(msgs, 1);
    expect(kept.map((m) => m.content)).toEqual(["u1", "working", "r1"]);
    expect(kept[kept.length - 1]!.role).toBe("tool");
  });

  it("drops every turn when N >= totalTurns, keeping the pre-user prefix", () => {
    for (const n of [3, 4, 99]) {
      const { kept, droppedTurns, totalTurns } = trimTurns(convo(), n);
      expect(droppedTurns).toBe(totalTurns);
      // No visible message survives, so the pre-conversation prefix stands.
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

// ── resolveMessageCut: the shared /rewind + /fork resolver ──────────────────

import { MessageLog } from "@core/context/message-log.ts";
import { MessageCutError, resolveMessageCut } from "@core/context/rewind.ts";

const call = (id: string) => ({ id, type: "function", function: { name: "t", arguments: "{}" } });

describe("resolveMessageCut: index spec", () => {
  it("keeps through the addressed message and drops strictly after", () => {
    // Visible in convo(): u1#1 a1#2 a2#3 u2#4 u3#5 a3#6 (system/tool/harness skipped).
    const r = resolveMessageCut(convo(), { kind: "index", index: 2 });
    expect(r.kept.map((m) => m.content)).toEqual(["sys prompt", "u1", "a1"]);
    expect(r.after).toBe(2);
    expect(r.droppedVisible).toBe(4);
  });

  it("index at the newest keeps everything (a no-op cut)", () => {
    const r = resolveMessageCut(convo(), { kind: "index", index: 6 });
    expect(r.droppedVisible).toBe(0);
    expect(r.after).toBe(6);
    expect(r.kept).toHaveLength(9);
  });

  it("addressing a user message keeps it: the lineage ends waiting for a response", () => {
    const r = resolveMessageCut(convo(), { kind: "index", index: 4 }); // u2
    expect(r.kept.map((m) => m.content)).toEqual([
      "sys prompt", "u1", "a1", "t1", "a2", "u2",
    ]);
  });

  it("an addressed tool-call message keeps its answered tool results with it", () => {
    const msgs: Message[] = [
      msg("user", "u1"), //                                             #1
      new Message({ role: "assistant", content: "working", toolCalls: [call("c1"), call("c2")] }), // #2
      new Message({ role: "tool", content: "r1", toolCallId: "c1" }), // invisible
      new Message({ role: "tool", content: "r2", toolCallId: "c2" }), // invisible
      msg("assistant", "done"), //                                      #3
      msg("user", "u2"), //                                             #4
    ];
    const r = resolveMessageCut(msgs, { kind: "index", index: 2 });
    expect(r.kept.map((m) => m.content)).toEqual(["u1", "working", "r1", "r2"]);
    expect(r.droppedVisible).toBe(2);
  });

  it("an addressed message with an UNANSWERED call refuses the cut", () => {
    const msgs: Message[] = [
      msg("user", "u1"), // #1
      new Message({ role: "assistant", content: "calling", toolCalls: [call("c1")] }), // #2, no result
    ];
    expect(() => resolveMessageCut(msgs, { kind: "index", index: 2 })).toThrow(MessageCutError);
    expect(() => resolveMessageCut(msgs, { kind: "index", index: 2 })).toThrow(/unanswered tool call/);
  });
});

describe("resolveMessageCut: back spec", () => {
  it("drops the last N visible messages with the traffic that trails them", () => {
    const r = resolveMessageCut(convo(), { kind: "back", messages: 2 });
    // Drops a3 and u3; the harness summary trailing u2 belongs to the dropped tail.
    expect(r.kept.map((m) => m.content)).toEqual(["sys prompt", "u1", "a1", "t1", "a2", "u2"]);
    expect(r.after).toBe(4);
    expect(r.droppedVisible).toBe(2);
  });

  it("back by exactly the visible count cuts before the first message", () => {
    const r = resolveMessageCut(convo(), { kind: "back", messages: 6 });
    expect(r.kept.map((m) => m.content)).toEqual(["sys prompt"]);
    expect(r.after).toBeNull();
    expect(r.droppedVisible).toBe(6);
  });

  it("back past the start is an explicit error naming the range", () => {
    expect(() => resolveMessageCut(convo(), { kind: "back", messages: 7 })).toThrow(/#1-#6/);
    expect(() => resolveMessageCut(convo(), { kind: "back", messages: 0 })).toThrow(/at least 1/);
  });
});

describe("resolveMessageCut: stray-free boundary (owner ruling)", () => {
  // Loaded transcript: answered tool blocks, harness notices between turns,
  // and traffic after the newest visible message. Visible: u1#1 a1#2 a2#3 u2#4 a3#5.
  function strays(): Message[] {
    return [
      msg("system", "sys"),
      msg("user", "u1"),
      new Message({ role: "assistant", content: "a1", toolCalls: [call("c1")] }),
      new Message({ role: "tool", content: "t1", toolCallId: "c1" }),
      msg("harness", "nudge"),
      new Message({ role: "assistant", content: "a2", toolCalls: [call("c2")] }),
      new Message({ role: "tool", content: "t2", toolCallId: "c2" }),
      msg("harness", "loop-detect"),
      msg("user", "u2"),
      msg("assistant", "a3"),
      msg("harness", "trailing notice"),
    ];
  }

  it("an index cut keeps the answered block and drops every trailing entry of any role", () => {
    const r = resolveMessageCut(strays(), { kind: "index", index: 2 });
    expect(r.kept.map((m) => m.content)).toEqual(["sys", "u1", "a1", "t1"]);
    expect(r.kept.some((m) => m.role === "harness")).toBe(false);
  });

  it("a back cut ends exactly at the last kept visible message; trailing notices go", () => {
    const r = resolveMessageCut(strays(), { kind: "back", messages: 3 });
    expect(r.kept.map((m) => m.content)).toEqual(["sys", "u1", "a1", "t1"]);
  });

  it("a back cut keeps in-history entries and ends at its target; only trailing entries go", () => {
    const r = resolveMessageCut(strays(), { kind: "back", messages: 1 });
    const last = r.kept[r.kept.length - 1]!;
    expect(last.content).toBe("u2");
    expect(last.role).toBe("user");
  });

  it("cutting before the first visible message leaves only the pre-conversation prefix", () => {
    const r = resolveMessageCut(strays(), { kind: "back", messages: 5 });
    expect(r.kept.map((m) => m.content)).toEqual(["sys"]);
    expect(r.after).toBeNull();
  });
});

describe("resolveMessageCut: honest errors", () => {
  it("zero and past-the-end absolute targets error, naming the valid range", () => {
    expect(() => resolveMessageCut(convo(), { kind: "index", index: 0 })).toThrow(/#1-#6/);
    expect(() => resolveMessageCut(convo(), { kind: "index", index: 7 })).toThrow(/past the newest visible message \(#6\)/);
  });

  it("an empty context has nothing to address", () => {
    expect(() => resolveMessageCut([], { kind: "index", index: 1 })).toThrow(/no visible messages/);
  });

  it("an entry swallowed by compaction errors instead of readdressing", () => {
    // Real tracked context: five turns, then a summarize-style compaction
    // keeps only the recent tail under a summary.
    const log = new MessageLog();
    for (let i = 1; i <= 5; i++) {
      log.push(msg("user", `u${i}`));
      log.push(msg("assistant", `a${i}`));
    }
    const tail = log.getAll().slice(-4);
    log.replace([msg("system", "summary"), ...tail]);
    // Visible lineage now #7-#10; #3 is gone with the compacted history.
    expect(() => resolveMessageCut(log.getAll(), { kind: "index", index: 3 })).toThrow(
      /no longer in this lineage.*#7-#10/,
    );
    // In-range survivors cut honestly.
    const r = resolveMessageCut(log.getAll(), { kind: "index", index: 8 });
    expect(r.kept.map((m) => m.content)).toEqual(["summary", "u4", "a4"]);
  });

  it("a stale target from before a rewind errors instead of cutting at a neighbor", () => {
    const log = new MessageLog();
    log.push(msg("user", "u1")); // #1
    log.push(msg("assistant", "a1")); // #2
    log.push(msg("user", "u2")); // #3
    log.push(msg("assistant", "a2")); // #4
    log.replace(log.getAll().slice(0, 2)); // /rewind keeps through #2
    expect(() => resolveMessageCut(log.getAll(), { kind: "index", index: 4 })).toThrow(
      /past the newest visible message \(#2\)/,
    );
    expect(() => resolveMessageCut(log.getAll(), { kind: "back", messages: 3 })).toThrow(
      /deepest message cut is -2/i,
    );
  });
});
