// Gates + approvals end-to-end.
//
// Three harnesses, all real machinery: the shipped user-gate extension over
// the testing-kit double (whole-script gate + envelope-keyed memo), the real
// ToolExecutor + real user-gate behind the nested-call entry (inner-call
// prompts, parent attribution), and the real bridge running a real script
// whose denied inner call must surface as a rejected Promise. The
// held-question case runs the real question tool + real session-log
// extension against a real executor call.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestCore, fakeQuestionSeam } from "@read-receipt/hotdog/testing";
import { createToolExecutor } from "@core/tool-executor.ts";
import { HOOKS, type GateAction } from "@core/hooks.ts";
import type { CoreContext, HookPayloads } from "@core/extensions/types.ts";
import type { Agent } from "@core/agent.ts";
import type { Message } from "@core/context/message.ts";
import type { ToolDef } from "@core/extensions/tool-registry.ts";
import { Workspace } from "@utils/workspace.ts";
import { toolContentText } from "@utils/tool-content.ts";
import { create as createUserGate } from "@extensions/user-gate/index.ts";
import { create as createSessionLog } from "@extensions/session-log/index.ts";
import { drainWrites } from "@extensions/session-log/record-count.ts";
import { QuestionTool } from "@extensions/question-tool/index.ts";
import {
  LOG_SOURCE,
  readSessionEntries,
  replayEntriesIntoContext,
  sessionPath,
  type LogEntry,
} from "@core/session/session-log.ts";
import { CodemodeBridge } from "@experimental/codemode/bridge.ts";
import { MockTool } from "../helpers.ts";

// user-gate registers live-config hooks process-wide when enabled; drain them
// at file end through the same seam the extension uses.
const gated: Array<{ hooks?: Record<string, unknown> }> = [];
function gateInstance(core: CoreContext) {
  const inst = createUserGate(core);
  gated.push(inst as { hooks?: Record<string, unknown> });
  return inst;
}
afterAll(() => {
  for (const inst of gated.splice(0)) {
    const shutdown = inst.hooks?.[HOOKS.SHUTDOWN_CLEANUP] as (() => void) | undefined;
    shutdown?.();
  }
});

const ws = new Workspace("/ws");

/** fakeQuestionSeam's seam plus its `asked` log, mountable as one object. */
function newSeam(answer = "", opts?: Parameters<typeof fakeQuestionSeam>[1]) {
  const { seam, asked } = fakeQuestionSeam(answer, opts);
  return Object.assign(seam, { asked });
}

// ── 1. The whole script, at approve time (user-gate over the double) ────────

type ToolCallPayload = HookPayloads["tool:call"];

function cmPayload(
  args: Record<string, unknown>,
  seam: unknown,
  sessionId = "memo-session",
): ToolCallPayload {
  const store: Record<string, unknown> = { workspace: ws, input: seam };
  return {
    toolCallId: "call_cm",
    toolName: "codemode",
    input: JSON.stringify(args),
    agent: { sessionId },
    toolCtx: { get: (k: string) => store[k] },
  } as unknown as ToolCallPayload;
}

/** Boot an enabled user-gate over the testing-kit double, run one call,
 *  return the verdict the pipeline adopted (undefined == allowed). */
function makeGate(cfg: Record<string, unknown>) {
  const core = createTestCore({ config: { userGate: cfg } });
  const instance = gateInstance(core as unknown as CoreContext);
  for (const [name, handler] of Object.entries(instance.hooks ?? {})) {
    core.hooks.on(name, handler as never, "user-gate");
  }
  return async (p: ToolCallPayload): Promise<{ action?: string; result: string }> => {
    await core.hooks.runHookPipeline<GateAction | undefined, "tool:call">(HOOKS.TOOL_CALL, p, {
      failOnError: true,
    });
    return { action: p.action, result: String(p.result ?? "") };
  };
}

const SCRIPT = "return await tools.read({ path: 'README.md' });";

describe("whole-script gate (user-gate + codemode case)", () => {
  it("unseen script denied by an allow-rule-only config, without a prompt", async () => {
    const seam = newSeam("allow once");
    const gate = makeGate({ enabled: true, default: "deny", allow: ["codemode"] });
    const r = await gate(cmPayload({ code: SCRIPT }, seam));
    expect(r.action).toBe("block");
    expect(r.result).toContain('userGate.default is "deny"');
    expect(seam.asked).toHaveLength(0);
  });

  it("a tool-level codemode allow does NOT admit a script even under the permissive default", async () => {
    const seam = newSeam("deny");
    const gate = makeGate({ enabled: true, default: "allow", allow: ["codemode"] });
    const r = await gate(cmPayload({ code: SCRIPT }, seam));
    // It PROMPTED (the allow was not consent) and the human's deny decided.
    expect(seam.asked).toHaveLength(1);
    expect(r.action).toBe("block");
    expect(seam.asked[0]!.prompt).toContain("Approve this tool call? (codemode)");
  });

  it("allow-for-session is keyed to the EXACT envelope: near-identical script and longer timeout re-prompt", async () => {
    const seam = newSeam("allow for session");
    const gate = makeGate({ enabled: true, default: "ask" });
    const run = (args: Record<string, unknown>) => gate(cmPayload(args, seam));

    await run({ code: SCRIPT });
    expect(seam.asked).toHaveLength(1); // the first ask
    await run({ code: SCRIPT });
    expect(seam.asked).toHaveLength(1); // memo hit: silent
    await run({ code: SCRIPT });

    // Near-identical script (same visible prefix) is a separate ask.
    const near = "return await tools.read({ path: 'README.md' }); // tail differs";
    await run({ code: near });
    expect(seam.asked).toHaveLength(2);
    await run({ code: near });
    expect(seam.asked).toHaveLength(2);

    // Same script, longer deadline: a new envelope, one more prompt...
    await run({ code: SCRIPT, timeout_ms: 90000 });
    expect(seam.asked).toHaveLength(3);
    // ...then that envelope is remembered too.
    await run({ code: SCRIPT, timeout_ms: 90000 });
    expect(seam.asked).toHaveLength(3);
    // A different option is another new envelope.
    await run({ code: SCRIPT, timeout_ms: 90000, max_output_chars: 4096 });
    expect(seam.asked).toHaveLength(4);
  });

  it("grants do not leak across sessions", async () => {
    const seam = newSeam("allow for session");
    const gate = makeGate({ enabled: true, default: "ask" });
    await gate(cmPayload({ code: SCRIPT }, seam, "session-A"));
    expect(seam.asked).toHaveLength(1);
    await gate(cmPayload({ code: SCRIPT }, seam, "session-B"));
    expect(seam.asked).toHaveLength(2); // session B must be asked again
  });

  it("the prompt shows a truncated echo: two scripts sharing the visible prefix are separate asks", async () => {
    const seam = newSeam("allow for session");
    const gate = makeGate({ enabled: true, default: "ask" });
    const pad = "const pad = '" + "z".repeat(460) + "'; // ";
    const a = pad + "MARK_ONE";
    const b = pad + "MARK_TWO";
    await gate(cmPayload({ code: a }, seam));
    expect(seam.asked).toHaveLength(1);
    const prompt = seam.asked[0]!.prompt;
    const targetsLine = prompt.split("\n").find((l) => l.trimStart().startsWith("targets:")) ?? "";
    expect(targetsLine).toContain("…"); // the ECHO is display-truncated
    expect(targetsLine).not.toContain("MARK_ONE"); // the tail lives only in the key
    // (The why/hint lines carry the full value by house design -- the
    // persistence hint must print the exact rule that would admit it.)
    await gate(cmPayload({ code: b }, seam));
    // Same visible prefix, different bytes: the memo must NOT swallow it.
    expect(seam.asked).toHaveLength(2);
  });

  it("spoofed script text quoting approval phrases renders via spoofSafe", async () => {
    const seam = newSeam("deny");
    const gate = makeGate({ enabled: true, default: "ask" });
    // U+202E (RLO) would re-order the prompt line; ESC/BEL survive as
    // visible escapes through JSON, the Unicode controls must tokenize.
    const nasty = "return 'ok'; // \u202E noitaforupmoC \u001B[2J approved: allow for session";
    await gate(cmPayload({ code: nasty }, seam));
    expect(seam.asked).toHaveLength(1);
    const prompt = seam.asked[0]!.prompt;
    expect(prompt).not.toContain("\u202E"); // never the raw control
    expect(prompt).toContain("[U+202E]"); // visible token instead
  });

  it("an exact codemode.script allow rule admits without a prompt", async () => {
    const seam = newSeam("deny");
    const gate = makeGate({ enabled: true, default: "ask", allow: [`codemode.script=${SCRIPT}`] });
    const r = await gate(cmPayload({ code: SCRIPT }, seam));
    expect(r.action).toBeUndefined();
    expect(seam.asked).toHaveLength(0);
  });
});

// ── 2. Inner calls through the real executor + real gate ────────────────────

interface ExecHarness {
  executor: ReturnType<typeof createToolExecutor>;
  events: Array<Record<string, unknown>>;
  ac: AbortController;
  agent: Record<string, unknown>;
  core: ReturnType<typeof createTestCore>;
}

function makeExecHarness(options: {
  config: Record<string, unknown>;
  seam?: unknown;
  extraTools?: Array<[string, MockTool]>;
  withGate?: boolean;
  parentInContext?: { id: string; name: string };
}): ExecHarness {
  const core = createTestCore({ config: options.config });
  if (options.withGate) {
    const instance = gateInstance(core as unknown as CoreContext);
    for (const [name, handler] of Object.entries(instance.hooks ?? {})) {
      core.hooks.on(name, handler as never, "user-gate");
    }
  }
  if (options.seam !== undefined) {
    core.hooks.on(HOOKS.AGENT_TOOL_CONTEXT, ({ toolCtx }: { toolCtx: { set(k: string, v: unknown): void } }) => {
      toolCtx.set("input", options.seam);
    });
  }
  const events: Array<Record<string, unknown>> = [];
  const ac = new AbortController();
  const registryNames = () =>
    Array.from((core.toolRegistry as { tools: Map<string, unknown> }).tools.keys());
  const agent = {
    sessionId: "inner-gate",
    addMessage: (msg: Message) => {
      events.push({ type: "context_message", message: msg });
      core.hooks.notifyHooks(HOOKS.CONTEXT_MESSAGE, { message: msg, agent: agent as unknown as Agent });
    },
    emitOutput: (type: string, data: Record<string, unknown>) => {
      events.push({ type, ...data });
      core.hooks.notifyHooks(HOOKS.OUTPUT_EVENT, { type, data, agent: agent as unknown as Agent });
    },
    getToolDefs: async (): Promise<ToolDef[]> =>
      registryNames().map((name) => ({
        type: "function",
        function: { name, description: "", parameters: { type: "object", properties: {}, required: [] } },
      })),
    context: {
      getMessages: () =>
        options.parentInContext
          ? [
              {
                role: "assistant",
                toolCalls: [
                  { id: options.parentInContext.id, type: "function", function: { name: options.parentInContext.name, arguments: "{}" } },
                ],
              },
            ]
          : [],
    },
  };
  for (const [name, tool] of options.extraTools ?? []) core.toolRegistry.register(name, tool);
  const executor = createToolExecutor({
    toolRegistry: core.toolRegistry,
    hooks: core.hooks,
    emitOutput: (type, data) => {
      events.push({ type, ...data });
      core.hooks.notifyHooks(HOOKS.OUTPUT_EVENT, { type, data, agent: agent as unknown as Agent });
    },
    workspaceRoots: ["/ws"],
    workspaceDeny: null,
    maxRetries: 0,
    toolRetryDelay: 0,
    isRestoring: () => false,
    agent: agent as unknown as Agent,
    runSignal: () => ac.signal,
  });
  return { executor, events, ac, agent, core };
}

describe("inner calls under the gate", () => {
  it("a mutating inner call under an ask rule prompts with parent attribution", async () => {
    const seam = newSeam("allow once");
    const transfer = new MockTool({
      name: "transfer",
      metadata: { sideEffects: true, difficulty: 3 },
      execute: async () => "sent",
    });
    const h = makeExecHarness({
      config: { userGate: { enabled: true, default: "ask" } },
      seam,
      extraTools: [["transfer", transfer]],
      withGate: true,
      parentInContext: { id: "call_cm", name: "codemode" },
    });

    const res = await h.executor.executeToolCall(
      "transfer",
      { to: "treasury" },
      { parentToolCallId: "call_cm" },
    );

    expect(seam.asked).toHaveLength(1);
    const prompt = seam.asked[0]!.prompt;
    expect(prompt).toContain("Approve this tool call? (transfer)");
    // Parent attribution: the human sees the inner call rides the open
    // codemode row, not a model turn.
    expect(prompt).toContain("inner call from codemode <call_cm>");
    expect(res.ok).toBe(true);
    expect(transfer.executeCount).toBe(1);
  });

  it("attribution falls back to the id when the parent is not in context", async () => {
    const seam = newSeam("allow once");
    const h = makeExecHarness({
      config: { userGate: { enabled: true, default: "ask" } },
      seam,
      extraTools: [["transfer", new MockTool({ name: "transfer", metadata: { sideEffects: true, difficulty: 3 } })]],
      withGate: true,
    });
    const res = await h.executor.executeToolCall("transfer", {}, { parentToolCallId: "call_deep/7" });
    expect(seam.asked[0]!.prompt).toContain("inner call from parent call <call_deep/7>");
    expect(res.ok).toBe(true);
  });

  it("an inner bash call rides bash triage identically to a model-issued call (same rule table, same deny)", async () => {
    const bashStub = new MockTool({
      name: "bash",
      metadata: { sideEffects: true, difficulty: 3 },
      execute: async () => "rm ran",
    });
    const h = makeExecHarness({
      config: { userGate: { enabled: true, default: "allow", deny: ["bash.cmd=rm"] } },
      extraTools: [["bash", bashStub]],
      withGate: true,
    });

    // Model-issued path.
    const modelSide = await h.executor.execute([
      {
        id: "m-1",
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command: "rm -rf ./build" }) },
      },
    ]);
    const modelText = toolContentText(modelSide.toolResults[0]!.content);
    expect(modelText).toContain("matches the deny rule 'bash.cmd=rm'");
    expect(bashStub.executeCount).toBe(0);

    // Inner path, same args, same table.
    const inner = await h.executor.executeToolCall(
      "bash",
      { command: "rm -rf ./build" },
      { parentToolCallId: "call_cm" },
    );
    expect(inner.ok).toBe(false);
    expect(inner.error).toContain("matches the deny rule 'bash.cmd=rm'");
    expect(bashStub.executeCount).toBe(0);

    // Same rule table -> same denial sentence for both routes.
    expect(inner.error).toContain(modelText.split("\n")[0]!);
  });
});

// ── 3. Denial surfaces to the script as a rejected Promise (real bridge) ────

const savedDataDir = process.env.HOTDOG_DATA_DIR;
let dataRoot: string;

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "hotdog-codemode-gates-"));
  process.env.HOTDOG_DATA_DIR = dataRoot;
});

afterAll(() => {
  if (savedDataDir === undefined) delete process.env.HOTDOG_DATA_DIR;
  else process.env.HOTDOG_DATA_DIR = savedDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("script-visible denial (real bridge + real gate)", () => {
  it("a denied inner call rejects the script's Promise; the effect is absent and the digest says denied", async () => {
    const effects: string[] = [];
    const transfer = new MockTool({
      name: "transfer",
      metadata: { sideEffects: true, difficulty: 3 },
      execute: async (input) => {
        effects.push(String(input));
        return "sent";
      },
    });
    const seam = newSeam("deny");
    const h = makeExecHarness({
      config: { userGate: { enabled: true, default: "ask" } },
      seam,
      extraTools: [["transfer", transfer]],
      withGate: true,
      parentInContext: { id: "call_cm", name: "codemode" },
    });

    const bridge = new CodemodeBridge();
    const outcome = await bridge.run({
      code:
        "const r = await tools.transfer({ to: 'evil' }).then(" +
        "() => 'NOT-DENIED', (e) => 'REJECTED: ' + String((e && e.message) || e));\n" +
        "return r;",
      toolNames: ["transfer"],
      timeoutMs: 30000,
      roots: [dataRoot],
      callId: "call_cm",
      dispatch: (name, input, opts) => h.executor.executeToolCall(name, input, opts),
    });

    expect(outcome.ok).toBe(true); // the script handled its rejection
    const joined = [...outcome.items, JSON.stringify(outcome.value ?? "")].join("\n");
    expect(joined).toContain("REJECTED:");
    expect(joined).toContain("Tool call blocked");
    expect(joined).not.toContain("NOT-DENIED");
    expect(effects).toHaveLength(0); // the tool never ran
    expect(outcome.digest).toHaveLength(1);
    expect(outcome.digest[0]!.status).toBe("denied");
    // And the human was asked, once, with parent attribution.
    expect(seam.asked).toHaveLength(1);
    expect(seam.asked[0]!.prompt).toContain("inner call from codemode <call_cm>");
  });
});

// ── 4. A held inner question, aborted ────────────────────────────────────────

const savedSessionsDir = process.env.HOTDOG_SESSIONS_DIR;
let sessionsRoot: string;

describe("held inner question aborted (real question tool + real session log)", () => {
  beforeAll(() => {
    sessionsRoot = mkdtempSync(join(tmpdir(), "hotdog-gates-sessions-"));
    process.env.HOTDOG_SESSIONS_DIR = sessionsRoot;
  });

  afterAll(() => {
    if (savedSessionsDir === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
    else process.env.HOTDOG_SESSIONS_DIR = savedSessionsDir;
    try {
      rmSync(sessionsRoot, { recursive: true, force: true });
    } catch {}
  });

  it("the call is denied, no parented question_asked lands in the log, and replay surfaces no phantom", async () => {
    const sessionId = `held-q-${Date.now()}`;

    // A never-answering seam: only the abort releases the held prompt.
    const seam = newSeam("", { never: true });
    const relay = new MockTool({
      name: "codemode_host", // stands in for the parent call, as codemode does
      metadata: { sideEffects: true, difficulty: 4 },
      execute: async (_input, ctx) => {
        const dispatch = (ctx as { get(k: string): unknown }).get("executeToolCall") as (
          name: string,
          input: unknown,
        ) => Promise<{ ok: boolean; output: string; error?: string }>;
        const res = await dispatch("question", {
          questions: [{ key: "go", prompt: "Proceed with the transfer?" }],
        });
        return res.ok ? `ANSWERED:${res.output}` : `DENIED:${res.output || res.error}`;
      },
    });
    const h = makeExecHarness({
      config: {},
      seam,
      extraTools: [
        ["codemode_host", relay],
        ["question", new QuestionTool() as never],
      ],
    });
    // The REAL session-log extension, mounted on the harness's own hook
    // system, and a session id for the parent call.
    const ext = (await createSessionLog(h.core as unknown as CoreContext)) as unknown as {
      hooks: Record<string, (p: unknown) => Promise<unknown>>;
    };
    for (const [name, handler] of Object.entries(ext.hooks)) {
      h.core.hooks.on(name, handler as never, "session-log");
    }
    (h.agent as { sessionId: string }).sessionId = sessionId;

    // The model's assistant turn naming the parent call (so replay sees a
    // closed pair, and the audit trail is the real shape).
    await h.core.hooks.notifyHooks(HOOKS.CONTEXT_MESSAGE, {
      message: {
        role: "assistant",
        content: "running the script",
        toolCalls: [{ id: "cm-1", type: "function", function: { name: "codemode_host", arguments: "{}" } }],
      } as unknown as Message,
      agent: h.agent as unknown as Agent,
    });

    const run = h.executor.execute([
      {
        id: "cm-1",
        type: "function",
        function: { name: "codemode_host", arguments: "{}" },
      },
    ]);

    // Wait for the inner question to reach the human, then abort the run.
    const t0 = Date.now();
    while (!h.events.some((e) => e.type === "question") && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.events.some((e) => e.type === "question")).toBe(true);
    h.ac.abort();

    const done = await Promise.race([
      run,
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ]);
    expect(done).not.toBeNull(); // the held question was released, not dangling
    const parentText = toolContentText(done!.toolResults[0]!.content);
    expect(parentText).toContain("DENIED:");
    expect(parentText).toContain("cancelled");

    // The log: the inner answer is a nested_tool_result line; there is NO
    // parented question_asked anywhere (the phantom this skip exists to kill).
    const logPath = sessionPath(sessionId);
    await drainWrites(logPath);
    const entries = await readSessionEntries(sessionId);
    expect(entries.some((e: LogEntry) => e.source === LOG_SOURCE.QUESTION_ASKED)).toBe(false);
    const nested = entries.filter((e: LogEntry) => e.source === LOG_SOURCE.NESTED_TOOL_RESULT);
    expect(nested).toHaveLength(1);
    expect(nested[0]!.tool_call_id).toBe("cm-1/1");
    expect(nested[0]!.parent_tool_call_id).toBe("cm-1");
    expect(nested[0]!.tool_name).toBe("question");

    // Replay probe: nothing lives on that unanswered inner question.
    const replayed: Message[] = [];
    const result = replayEntriesIntoContext(
      {
        addMessage: (m: Message) => void replayed.push(m),
        emitOutput: () => {},
      } as never,
      entries,
    );
    expect(result.pendingQuestions).toHaveLength(0);
    expect(replayed.some((m) => m.toolCallId === "cm-1/1")).toBe(false);
  });
});
