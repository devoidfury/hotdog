// The visible-message index: what counts, how it numbers, and what survives
// cuts and compaction (src/core/context/message-index.ts).

import { describe, it, expect } from "bun:test";
import { Message } from "@core/context/message.ts";
import { MessageLog } from "@core/context/message-log.ts";
import {
  isVisibleMessage,
  latestVisibleIndex,
  visibleIndexSequence,
} from "@core/context/message-index.ts";

const user = (t: string) => new Message({ role: "user", content: t });
const asst = (t: string, toolCalls?: unknown[]) =>
  new Message({ role: "assistant", content: t, toolCalls: (toolCalls as never) ?? null });
const tool = (id: string) => new Message({ role: "tool", content: "result", toolCallId: id });
const harness = (t: string) => new Message({ role: "harness", content: t });
const tc = (id: string) => ({ id, type: "function", function: { name: "t", arguments: "{}" } });

describe("isVisibleMessage: the index definition", () => {
  it("user input and assistant responses count; tool/system/harness traffic does not", () => {
    expect(isVisibleMessage(user("hi"))).toBe(true);
    expect(isVisibleMessage(asst("done"))).toBe(true);
    expect(isVisibleMessage(tool("c1"))).toBe(false);
    expect(isVisibleMessage(new Message({ role: "system", content: "prompt" }))).toBe(false);
    expect(isVisibleMessage(harness("notice"))).toBe(false);
  });

  it("assistant messages are visible only with non-empty text", () => {
    // A tool-call-only assistant message is tool traffic, never a response.
    expect(isVisibleMessage(asst("", [tc("c1")]))).toBe(false);
    expect(isVisibleMessage(asst("   "))).toBe(false);
    // Narration shipped alongside a tool call IS visible text.
    expect(isVisibleMessage(asst("looking into it", [tc("c1")]))).toBe(true);
    // Whitespace-only text does not become a response.
    expect(isVisibleMessage(asst("\n \t"))).toBe(false);
  });

  it("content part arrays count by their rendered text", () => {
    expect(
      isVisibleMessage(new Message({ role: "assistant", content: [{ type: "text", text: "x" }] })),
    ).toBe(true);
    expect(isVisibleMessage(new Message({ role: "assistant", content: [] }))).toBe(false);
  });
});

describe("visibleIndexSequence: numbering across a tool-heavy turn", () => {
  it("numbers user input and responses 1-based; tool traffic never takes a number", () => {
    const log = new MessageLog([new Message({ role: "system", content: "sys" })]);
    log.push(user("q1")); //            #1
    log.push(asst("", [tc("c1")])); //  invisible: tool-call carrier
    log.push(tool("c1")); //            invisible
    log.push(asst("reading next", [tc("c2")])); // #2 (narration + call)
    log.push(tool("c2")); //            invisible
    log.push(harness("notice")); //     invisible
    log.push(asst("final answer")); //  #3
    log.push(user("q2")); //            #4

    const seq = visibleIndexSequence(log.getAll());
    expect(seq.map((e) => e.index)).toEqual([1, 2, 3, 4]);
    expect(seq.map((e) => e.position)).toEqual([1, 4, 7, 8]);
    expect(latestVisibleIndex(log.getAll())).toBe(4);
  });
});

describe("ordinals: stable across compaction and rewind", () => {
  it("compaction swallows the oldest; survivors keep their numbers and later messages continue above", () => {
    const log = new MessageLog();
    for (let i = 1; i <= 5; i++) {
      log.push(user(`q${i}`));
      log.push(asst(`a${i}`));
    }
    // Faithful summarize-style compaction: a system summary plus the recent
    // tail (same Message objects), replacing the whole array.
    const tail = log.getAll().slice(-4);
    log.replace([new Message({ role: "system", content: "summary" }), ...tail]);

    expect(visibleIndexSequence(log.getAll()).map((e) => e.index)).toEqual([7, 8, 9, 10]);
    log.push(user("q6"));
    expect(latestVisibleIndex(log.getAll())).toBe(11);
  });

  it("a tail cut (rewind) does not renumber; the next message continues above the gap", () => {
    const log = new MessageLog();
    log.push(user("q1")); // #1
    log.push(asst("a1")); // #2
    log.push(user("q2")); // #3
    log.push(asst("a2")); // #4
    log.replace(log.getAll().slice(0, 2)); // keep through #2

    expect(latestVisibleIndex(log.getAll())).toBe(2);
    log.push(user("q3"));
    // NOT #3 again: the rewound numbers stay spent, so a stale /rewind index
    // 3 errors instead of silently addressing the new message.
    expect(latestVisibleIndex(log.getAll())).toBe(5);
  });

  it("a fork's copies keep the source's numbers; the branch continues from what the user saw", () => {
    const source = new MessageLog();
    source.push(user("q1"));
    source.push(asst("a1"));
    source.push(user("q2"));
    const kept = source.getAll().slice(0, 2); // index-2 cut

    const fork = new MessageLog();
    for (const m of kept) fork.push(m); // same objects, as forkSession copies them
    expect(visibleIndexSequence(fork.getAll()).map((e) => e.index)).toEqual([1, 2]);
    fork.push(user("new branch"));
    expect(latestVisibleIndex(fork.getAll())).toBe(3);
    // The source is untouched by the branch's numbering (and keeps its own).
    source.push(asst("a2"));
    expect(latestVisibleIndex(source.getAll())).toBe(4);
  });

  it("a resumed context (fresh objects from the log) rebuilds the lineage at 1..k", () => {
    const replayed = [
      new Message({ role: "user", content: "q1" }),
      new Message({ role: "assistant", content: "a1" }),
    ];
    // Replay lands entries one per addMessage (see replayEntriesIntoContext):
    // fresh objects on a fresh log number 1..k in log order.
    const log = new MessageLog();
    for (const m of replayed) log.push(m);
    expect(visibleIndexSequence(log.getAll()).map((e) => e.index)).toEqual([1, 2]);
    log.push(user("q2"));
    expect(latestVisibleIndex(log.getAll())).toBe(3);
  });

  it("/clear restarts numbering at 1", () => {
    const log = new MessageLog();
    log.push(user("q1"));
    log.clear();
    log.push(user("fresh"));
    expect(latestVisibleIndex(log.getAll())).toBe(1);
  });

  it("handoff: replaying the popped tail re-uses the popped messages' numbers", () => {
    const log = new MessageLog();
    log.push(user("q1")); // #1
    log.push(asst("a1")); // #2
    log.push(user("q2")); // #3
    const popped = log.getAll().slice(2); // baton takes the tail
    log.replace([new Message({ role: "harness", content: "handoff notice" })]);
    log.replace([...log.getAll(), ...popped]); // fresh session replays it verbatim
    expect(visibleIndexSequence(log.getAll()).map((e) => e.index)).toEqual([3]);
    log.push(asst("continued"));
    expect(latestVisibleIndex(log.getAll())).toBe(4);
  });
});

describe("positional fallback (arrays no MessageLog tracked)", () => {
  it("numbers 1..n by position when nothing carries an ordinal", () => {
    const plain = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ] as unknown as Message[];
    expect(visibleIndexSequence(plain).map((e) => e.index)).toEqual([1, 2]);
    expect(latestVisibleIndex(plain)).toBe(2);
  });

  it("empty or invisible-only contexts have no latest index", () => {
    expect(latestVisibleIndex([])).toBeNull();
    expect(latestVisibleIndex([tool("c1"), harness("n")] as never)).toBeNull();
  });
});
