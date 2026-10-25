// Fuzz suite for repairToolCalls (src/core/context/repair.ts).
//
// THE PROVIDER CONTRACT (transcribed, not derived from repair's internals):
//   - src/core/llm-client/serialize.ts: the repaired log is serialized
//     field-by-field into the OpenAI-compatible chat request body.
//     `tool_call_id` is emitted only when truthy (`if (msg.toolCallId)`),
//     `tool_calls` rides through structurally unvalidated, and neither
//     serializeMessages nor buildRequest adds validation, pairing, or
//     reordering: repair's output is exactly what the provider sees.
//   - repair.ts module header: the wire invariant is "every assistant
//     tool_call gets exactly one tool result before the next assistant
//     message (end-of-list counts)". Missing results and orphan results are
//     the two guaranteed-400 shapes on strict OpenAI-compatible backends
//     (llama.cpp enforces it too).
//
// auditWire below is written from that contract, independently of repair:
//   A1 every tool message carries a non-empty string toolCallId (a falsy id
//      serializes WITHOUT tool_call_id, a 400 shape).
//   A2 every tool message sits inside an open block: after the assistant
//      message declaring its id and before the next assistant message,
//      answering each declared id at most once. No orphan results; a result
//      whose id matches no open call is itself a 400.
//   A3 every declared call id is answered by the time the block closes (next
//      assistant message or end of list). Nothing dangling.
//   A4 every tool_use entry in the output is well-formed: a plain object with
//      a non-empty string id and an object `function`, unique within the
//      message. An entry failing this can never be answered legally (no
//      result can carry an empty id; two entries sharing one id cannot both
//      get "exactly one result"), so its presence in the output is a
//      violation the provider would bounce or leave unanswerable.
//   Block interior may hold non-tool messages in place; that is pinned
//   behavior (repair.test.ts "non-tool messages inside a block are preserved
//   in place"), so the checker does not require result adjacency. An empty
//   toolCalls array declares zero calls and is checked as such (serialize.ts
//   passes `tool_calls: []` through as-is; whether a provider accepts that is
//   outside repair's documented contract, noted in the run notes, not
//   asserted).
//
// PERMITTED DROPS / CHANGES (enumerated from repair.ts source, pinned here):
//   - Dropped messages, tool role ONLY: orphan results with no open block;
//     results whose id matches no call in the block; duplicate results for an
//     already-satisfied id; results with null/empty toolCallId.
//   - Removed ENTRIES (with a clone of the owning assistant message, content
//     untouched): tool_call entries that can never be answered; non-object
//     entries, missing/empty/non-string ids, missing function object, repeat
//     ids within one message. Product fix found by this suite; the message
//     itself, its content, and every other entry survive unchanged.
//   - Added: synthesized harness tool results at block end.
//   No user/assistant/system/harness message is ever dropped or reordered and
//   no message's content is rewritten: invariant 4 asserts the ordered
//   (role, content) fingerprint of every non-tool message survives verbatim.
//
// INVARIANTS asserted on EVERY generated log:
//   1. repairToolCalls never throws and returns within a wall budget.
//   2. auditWire(repair(x)) reports zero violations.
//   3. Idempotence: repair(repair(x)) deep-equals repair(x), and the second
//      pass is a no-op (no repairs, no drops, nothing held).
//   4. Content preservation: the ordered non-tool fingerprint is unchanged.
//   5. Determinism: two repairs of the same input deep-equal; the input array
//      itself is never mutated.
//
// holdUnresolved is deliberately NOT fuzzed: held calls stay pending BY
// DESIGN (session-log replays the user's answer alongside as the real
// result), which auditWire would (correctly) read as dangling until that
// answer lands. Fuzzing the default path is the provider-request guarantee.

import { describe, expect, it } from "bun:test";
import { Message, type ToolCall } from "@core/context/message.ts";
import {
  repairToolCalls,
  INTERRUPTED_TOOL_RESULT,
} from "@core/context/repair.ts";
import { makeRng, type Rng } from "../../fuzz/prng.ts";

const show = (v: unknown): string => JSON.stringify(v);

// ── Independent wire-contract checker (written from the contract above) ─────

function auditWire(messages: Message[]): string[] {
  const problems: string[] = [];
  let open: { declared: Set<string>; answered: Set<string>; at: number } | null =
    null;

  const closeBlock = (boundary: string): void => {
    if (!open) return;
    const block = open;
    for (const id of block.declared) {
      if (!block.answered.has(id)) {
        problems.push(
          `dangling tool_use ${show(id)} declared at ${block.at}, never answered before ${boundary}`,
        );
      }
    }
    open = null;
  };

  messages.forEach((m, i) => {
    if (m.role === "assistant") {
      closeBlock(`next assistant message at ${i}`);
      const tcs = m.toolCalls;
      if (Array.isArray(tcs) && tcs.length > 0) {
        const declared = new Set<string>();
        tcs.forEach((tc, k) => {
          if (!tc || typeof tc !== "object" || Array.isArray(tc)) {
            problems.push(`assistant at ${i}: tool_call entry #${k} is not an object (${show(tc)})`);
            return;
          }
          const id = (tc as { id?: unknown }).id;
          const fn = (tc as { function?: unknown }).function;
          if (typeof id !== "string" || id === "") {
            problems.push(`assistant at ${i}: tool_call #${k} has no usable id (${show(id)})`);
            return;
          }
          if (!fn || typeof fn !== "object" || Array.isArray(fn)) {
            problems.push(`assistant at ${i}: tool_call ${show(id)} has no function object`);
            return;
          }
          if (declared.has(id)) {
            problems.push(`assistant at ${i}: duplicate tool_use id ${show(id)}`);
            return;
          }
          declared.add(id);
        });
        if (declared.size > 0) open = { declared, answered: new Set<string>(), at: i };
      }
      return;
    }
    if (m.role === "tool") {
      const id = m.toolCallId;
      if (typeof id !== "string" || id === "") {
        problems.push(`tool message at ${i}: missing/empty tool_call_id (${show(id)})`);
        return;
      }
      const block = open;
      if (!block) {
        problems.push(`orphan tool result ${show(id)} at ${i}: no open tool_calls block`);
        return;
      }
      if (!block.declared.has(id)) {
        problems.push(`tool result ${show(id)} at ${i} matches no call in the block opened at ${block.at}`);
        return;
      }
      if (block.answered.has(id)) {
        problems.push(`duplicate tool result for ${show(id)} at ${i}`);
        return;
      }
      block.answered.add(id);
      return;
    }
    // user / system / harness / anything else: pass through, blocks untouched
  });
  closeBlock("end of list");
  return problems;
}

// Ordered fingerprint of every non-tool message: role + content JSON. Repair
// may only drop tool messages and (post-fix) clone assistants with stripped
// tool_call entries; content survives either way, byte for byte.
function nonToolFingerprint(messages: Message[]): string[] {
  return messages
    .filter((m) => m.role !== "tool")
    .map((m) => `${m.role}\u0000${JSON.stringify(m.content ?? null)}`);
}

const wireShape = (messages: Message[]): string[] =>
  messages.map((m) => `${m.role}:${m.toolCallId ?? (m.toolCalls?.length ? "calls" : "-")}`);

const json = (messages: Message[]): string => JSON.stringify(messages);

// ── Seeded hostile-log generator ────────────────────────────────────────────

const HOSTILE_IDS = [
  "call_1", "call_2", "", "\u0001", "\u0000x", "call\u007fid", "x\u0000y",
  "clued\u8bf7id", "\ud800", "\ufffd", "__proto__", "constructor",
  "a".repeat(200), "call with spaces", "\n\t", "0", "false",
] as const;

function contentGen(rng: Rng): string | Array<unknown> | null {
  const r = rng.int(10);
  if (r < 5) return `msg ${rng.int(1_000_000)}`;
  if (r === 5) return [];
  if (r === 6) return [{}, { type: "text" }, { type: "text", text: "" }];
  if (r === 7) return null;
  if (r === 8) return [{ type: "untrusted", text: "\u001b[31mtool-ish \u0000" }];
  return `plain ${rng.int(100)}`;
}

function toolResultMsg(rng: Rng, id: string | null): Message {
  const content = rng.bool(0.75)
    ? `ok ${rng.int(1000)}`
    : (rng.pick([[], [{}], null, "", [{ type: "text", text: "" }]]) as string | Array<unknown> | null);
  return new Message({ role: "tool", content, toolCallId: id, source: "tool" });
}

// A tool_call entry, well-formed or deliberately broken.
function genCall(rng: Rng, k: number): ToolCall {
  const base = {
    type: "function",
    function: { name: rng.pick(["bash", "read", "edit", "grep"]), arguments: "{}" },
  };
  const r = rng.int(10);
  if (r === 0) return { ...base, id: "" } as ToolCall;
  if (r === 1) return { ...base, id: rng.pick(HOSTILE_IDS) } as ToolCall;
  if (r === 2) return { id: `c${k}`, type: "function" } as unknown as ToolCall; // missing function
  if (r === 3) return "not-a-call" as unknown as ToolCall;
  if (r === 4) return null as unknown as ToolCall;
  if (r === 5) return { ...base, id: 42 as unknown as string }; // non-string id
  return { ...base, id: `c${k}` } as ToolCall;
}

function genLog(rng: Rng): Message[] {
  const out: Message[] = [];
  let counter = 0;
  const segs = 1 + rng.int(9);
  for (let s = 0; s < segs; s++) {
    const dice = rng.float();
    if (dice < 0.22) {
      out.push(new Message({ role: "user", content: contentGen(rng), source: "user" }));
    } else if (dice < 0.3) {
      out.push(
        new Message({
          role: rng.pick(["assistant", "system", "harness"]),
          content: contentGen(rng),
          source: rng.pick(["model", "system", "harness"]),
        }),
      );
    } else if (dice < 0.68) {
      // assistant with calls: valid, hostile, or broken entries; then a
      // random answer pattern (subset, reverse, duplicates, none).
      const n = 1 + rng.int(4) + (rng.bool(0.1) ? 3 : 0);
      const calls: ToolCall[] = [];
      for (let c = 0; c < n; c++) calls.push(genCall(rng, counter++));
      if (rng.bool(0.15) && calls.length > 0 && calls[0]) {
        calls.push({ ...calls[0]! }); // duplicate tool_use id within one message
      }
      out.push(
        new Message({
          role: "assistant",
          content: rng.bool(0.3) ? "" : `calling ${n}`,
          toolCalls: calls,
          source: "model",
        }),
      );
      const ids = calls.map((c) => (c && typeof c.id === "string" ? c.id : ""));
      const mode = rng.int(6);
      if (mode <= 2) {
        for (const id of ids) if (rng.bool(0.6)) out.push(toolResultMsg(rng, id));
      } else if (mode === 3) {
        const picked = ids.filter(() => rng.bool(0.5));
        for (const id of [...picked].reverse()) out.push(toolResultMsg(rng, id));
        if (picked.length > 0) out.push(toolResultMsg(rng, picked[0]!)); // duplicate
      } else if (mode === 4) {
        out.push(toolResultMsg(rng, `ghost${rng.int(4)}`)); // wrong id
        out.push(toolResultMsg(rng, rng.pick(["", null]))); // missing id
      } // mode 5: nothing answered, everything dangles
    } else if (dice < 0.78) {
      // result BEFORE its use, then the assistant declaring it, sometimes a
      // second in-position result.
      const id = `pre${counter++}`;
      out.push(toolResultMsg(rng, id));
      out.push(
        new Message({
          role: "assistant",
          content: "",
          toolCalls: [{ id, type: "function", function: { name: "bash", arguments: "{}" } }],
          source: "model",
        }),
      );
      if (rng.bool(0.5)) out.push(toolResultMsg(rng, id));
    } else {
      // stray tool messages: orphans before any use
      out.push(
        toolResultMsg(rng, rng.pick([`future${counter}`, `ghost${rng.int(3)}`, "", null])),
      );
    }
    if (rng.bool(0.1) && out.length > 0) out.push(out[out.length - 1]!); // adjacent identical (same instance)
  }
  return out;
}

// ── The sweep ───────────────────────────────────────────────────────────────

describe("repairToolCalls fuzz", () => {
  it("hostile logs: never throws, wire-clean, idempotent, preserving, deterministic", () => {
    const rng = makeRng(0x706c5201); // "plR\x01"
    const ITERATIONS = 900;
    const failures: { iter: number; log: string; problems: string[] }[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const log = genLog(rng);
      const inputBefore = json(log);
      const problems: string[] = [];
      let r: ReturnType<typeof repairToolCalls> | null = null;
      const t0 = performance.now();
      try {
        r = repairToolCalls(log);
      } catch (e) {
        problems.push(`threw: ${(e as Error).stack ?? String(e)}`);
      }
      if (performance.now() - t0 > 250) problems.push("single repair exceeded 250ms");
      if (r) {
        problems.push(...auditWire(r.messages).map((p) => `audit: ${p}`));

        const twice = repairToolCalls(r.messages);
        if (json(twice.messages) !== json(r.messages)) {
          problems.push(`idempotence: second pass differs (${JSON.stringify(wireShape(twice.messages))})`);
        }
        if (twice.repaired.length || twice.dropped.length || twice.held.length) {
          problems.push(`idempotence: second pass not a no-op (${show({ repaired: twice.repaired, dropped: twice.dropped, held: twice.held })})`);
        }

        const fpIn = nonToolFingerprint(log);
        const fpOut = nonToolFingerprint(r.messages);
        if (fpIn.length !== fpOut.length) {
          problems.push(`preservation: ${fpIn.length} non-tool messages in, ${fpOut.length} out`);
        } else {
          for (let k = 0; k < fpIn.length; k++) {
            if (fpIn[k] !== fpOut[k]) {
              problems.push(`preservation: fingerprint differs at ${k}: ${show(fpIn[k])} -> ${show(fpOut[k])}`);
              break;
            }
          }
        }

        const again = repairToolCalls(log);
        if (json(again.messages) !== json(r.messages)) problems.push("determinism: two runs differ");

        if (json(log) !== inputBefore) problems.push("input array mutated");
      }
      if (problems.length > 0) {
        failures.push({ iter: i, log: json(log), problems: problems.slice(0, 6) });
        if (failures.length >= 3) break;
      }
    }

    expect(failures).toEqual([]);
  });

  it("thousands of calls in one log: terminates fast, stays wire-clean and idempotent", () => {
    const rng = makeRng(0x706c5202);
    // One assistant message with 1500 calls, every third left unanswered,
    // results interleaved with duplicates and orphans.
    const calls: ToolCall[] = [];
    for (let i = 0; i < 1500; i++) {
      calls.push({ id: `big_${i}`, type: "function", function: { name: "bash", arguments: "{}" } });
    }
    const log: Message[] = [
      new Message({ role: "user", content: "go", source: "user" }),
      new Message({ role: "assistant", content: "", toolCalls: calls, source: "model" }),
    ];
    for (let i = 0; i < 1500; i++) {
      if (i % 3 === 0) continue; // left dangling
      log.push(toolResultMsg(rng, `big_${i}`));
      if (rng.bool(0.1)) log.push(toolResultMsg(rng, `big_${i}`)); // duplicate
      if (rng.bool(0.05)) log.push(toolResultMsg(rng, "ghost")); // orphan inside block
    }
    log.push(new Message({ role: "assistant", content: "done", source: "model" }));
    // ...then 1000 single-call blocks so block bookkeeping is exercised at scale
    for (let b = 0; b < 1000; b++) {
      log.push(
        new Message({
          role: "assistant",
          content: "",
          toolCalls: [{ id: `blk_${b}`, type: "function", function: { name: "grep", arguments: "{}" } }],
          source: "model",
        }),
      );
      if (b % 2 === 0) log.push(toolResultMsg(rng, `blk_${b}`));
    }

    const t0 = performance.now();
    const r = repairToolCalls(log);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(250);
    expect(auditWire(r.messages)).toEqual([]);
    const twice = repairToolCalls(r.messages);
    expect(json(twice.messages)).toBe(json(r.messages));
    expect(twice.repaired).toEqual([]);
    expect(twice.dropped).toEqual([]);
    // every dangling id got exactly one synthesized result
    expect(r.repaired.length).toBe(500 + 500); // big_i every 3rd + odd blk_*
    const synthCount = r.messages.filter(
      (m) => m.role === "tool" && m.source === "harness" && m.content === INTERRUPTED_TOOL_RESULT,
    ).length;
    expect(synthCount).toBe(1000);
  });

  it("synthesisFor changes content only, never structure", () => {
    const rng = makeRng(0x706c5203);
    const problems: string[] = [];
    for (let i = 0; i < 150; i++) {
      const log = genLog(rng);
      const custom = repairToolCalls(log, {
        synthesisFor: (tc) => (tc.id.endsWith("0") ? `synth:${tc.id}` : undefined),
      });
      const dflt = repairToolCalls(log);
      problems.push(...auditWire(custom.messages).map((p) => `audit: ${p}`));
      if (wireShape(custom.messages).join("|") !== wireShape(dflt.messages).join("|")) {
        problems.push("structure differs under synthesisFor");
        break;
      }
      for (const id of custom.repaired) {
        const content = custom.messages.find(
          (m) => m.role === "tool" && m.toolCallId === id && m.source === "harness",
        )?.content;
        const expected = id.endsWith("0") ? `synth:${id}` : INTERRUPTED_TOOL_RESULT;
        if (content !== expected) problems.push(`synthesis for ${show(id)}: ${show(content)}`);
      }
      if (problems.length >= 3) break;
    }
    expect(problems).toEqual([]);
  });

  // Pins for the product fix (see run notes): unanswerable tool_call entries
  // are stripped; the answerable rest of the message still gets results.
  it("pins: unanswerable tool_call entries are stripped, healthy siblings survive", () => {
    const msg = new Message({
      role: "assistant",
      content: "partial garbage",
      source: "model",
      toolCalls: [
        null as unknown as ToolCall,
        "not-a-call" as unknown as ToolCall,
        { id: "", type: "function", function: { name: "bash", arguments: "{}" } },
        { id: "ok1", type: "function" } as unknown as ToolCall,
        { id: 7 as unknown as string, type: "function", function: { name: "x", arguments: "{}" } },
        { id: "dup", type: "function", function: { name: "a", arguments: "{}" } },
        { id: "dup", type: "function", function: { name: "b", arguments: "{}" } },
      ],
    });
    const { messages } = repairToolCalls([msg]);
    expect(auditWire(messages)).toEqual([]);
    const out = messages[0]!;
    expect(out.content).toBe("partial garbage");
    expect(out.toolCalls).toEqual([
      { id: "dup", type: "function", function: { name: "a", arguments: "{}" } },
    ]);
    const results = messages.filter((m) => m.role === "tool");
    expect(results.length).toBe(1);
    expect(results[0]!.toolCallId).toBe("dup");
    // Healthy messages are untouched instances:
    const healthy = new Message({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "h", type: "function", function: { name: "bash", arguments: "{}" } }],
      source: "model",
    });
    const pass = repairToolCalls([healthy]);
    expect(pass.messages[0]).toBe(healthy);
  });
});
