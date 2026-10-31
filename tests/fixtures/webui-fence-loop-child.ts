// Loop-close fixture (subprocess, VIRGIN module state): one webui-initiated
// toggle traced end to end.
//
//   C2S {type:"execFence", sessionId, policy:"off"} through the REAL
//   routeMessage handler -> SessionRegistry -> fenceCommand ->
//   setExecFencePolicy -> the SHARED broker's per-session override map ->
//   that session's NEXT planned fence changes (seam-fence spawn, the prior
//   batch's recordingPlanner pin) -> the scoped sessionState("toolExec") push
//   lands on the socket attached to the toggled session.
//
// It rides a subprocess because the shared broker is process-global: the
// in-process suites must never construct it with a seam planner (sequential
// `bun test` shares one process across files). The parent parses STEP: lines.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharedToolExecBroker, getExecFencePolicy } from "../../src/core/tool-exec-broker.ts";
import type { WireToolCtx, WireToolResult } from "../../src/core/tool-exec-protocol.ts";
import { routeMessage } from "../../src/extensions/websocket/message-routing.ts";
import { SessionRegistry } from "../../src/extensions/websocket/session-registry.ts";
import { recordingPlanner } from "./fence-seam-planner.ts";
import { createWsMockCore, createWsMockAgentFactory, createWsMockWs } from "../mocks/websocket.ts";

const step = (name: string, value: unknown): void => {
  process.stdout.write(`STEP:${JSON.stringify({ step: name, value })}\n`);
};

const TOOL_CONFIG = {
  bashTool: { bashTimeoutMs: 20000, maxToolOutputLines: 100, maxTimeoutMs: 20000 },
  coreTools: { readToolLimit: 500, maxImageSize: 10485760, grepMaxResults: 50, maxToolOutputLines: 600 },
  envScrubbing: true,
  envScrubExtra: [],
};

const tag = `${process.pid}`;
const loopSession = `webui-loop-${tag}`; // toggled OFF through the C2S handler
const sibSession = `webui-sib-${tag}`; // never toggled: boot "probe" survives
const roots = mkdtempSync(join(tmpdir(), "hotdog-webui-loop-"));

function ctx(session: string): WireToolCtx {
  return { session, workspace: { roots: [roots], deny: [".env*"] }, toolConfig: TOOL_CONFIG };
}
const text = (r: WireToolResult): string =>
  r.kind === "tool-result" ? r.output : String((r as { value?: unknown }).value);

// The seam-planned boot posture, consumed as the SHARED broker (what
// setExecFencePolicy writes to). gen 91 is unique to this process.
const planner = recordingPlanner(91);
const broker = sharedToolExecBroker({ fence: "probe", fencePlan: planner.plan });

// A real registry + the real routeMessage; only the transport is mocked (and
// the agent, the same mock every webui server test uses). The registry gets
// the same resolved bag the webui server wires from core.resolved.
const core = createWsMockCore();
Object.assign(core.resolved, { toolExec: "worker", execFence: "probe" });
const registry = new SessionRegistry({
  buildAgent: createWsMockAgentFactory(),
  toolExecResolved: core.resolved as Record<string, unknown>,
});
await registry.create({ sessionId: loopSession });
await registry.create({ sessionId: sibSession });

const bridge = { peek: () => null, cancel: () => {}, answer: () => false, clear: () => {} };

const ws = createWsMockWs();
ws.activeSessionId = loopSession; // as after a live attach
// The live attach registers the socket for scoped broadcasts (server.onUpgrade
// does this); without registration broadcastScoped has no one to reach.
registry.registerConnection(ws);

const spawnProbe = (session: string) => ({
  session,
  tool: "bash" as const,
  args: { command: "echo $PPID gen=[${FAKE_FENCE_GEN:-absent}]" },
  ctx: ctx(session),
});

// 1. Both sessions are born FENCED (boot probe through the seam).
const before = text(await broker.invoke(spawnProbe(loopSession)));
const sibBefore = text(await broker.invoke(spawnProbe(sibSession)));
step("before", { loop: before.trim(), sib: sibBefore.trim(), policy: getExecFencePolicy(loopSession) });

// 2. The webui's exact C2S frame for the toggled session.
await routeMessage(
  ws,
  { type: "execFence", sessionId: loopSession, policy: "off" } as never,
  registry,
  undefined,
  bridge as never,
  core as never,
);

const pushes = (ws as unknown as { messages: string[] }).messages
  .map((m) => JSON.parse(m) as Record<string, unknown>)
  .filter((m) => m.type === "sessionState" && m.key === "toolExec");
step("push", {
  pushes,
  policy: getExecFencePolicy(loopSession),
  sibPolicy: getExecFencePolicy(sibSession),
});

// 3. The toggled session's NEXT planned fence is GONE (entry replaced
//    unfenced); the sibling's next invoke is still fenced, same memo.
const after = text(await broker.invoke(spawnProbe(loopSession)));
const sibAfter = text(await broker.invoke(spawnProbe(sibSession)));
step("after", {
  loop: after.trim(),
  sib: sibAfter.trim(),
  loopPidChanged: after.split(/\s+/)[0] !== before.split(/\s+/)[0],
});

await broker.close();
rmSync(roots, { recursive: true, force: true });
process.exit(0);
