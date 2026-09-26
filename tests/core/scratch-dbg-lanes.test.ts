import { it, expect } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageBus } from "@core/session/message-bus.ts";
import { createTurnLanes } from "@core/session/turn-lanes.ts";

it("session turn holds exactly one slot for its model lane", async () => {
  const lanesDir = await mkdtemp(join(tmpdir(), "lanes-dbg-"));
  const lanes = createTurnLanes({
    lanesDir,
    lanesPerProvider: 1,
    providerDefs: [{ name: "pA" }],
    lanesRetryMs: 25,
  });
  let gate!: () => void;
  const g = new Promise<void>((r) => (gate = r));
  const agent: any = {
    sessionId: "s1",
    model: "pA/m",
    hooks: { runHookPipeline: async (_n: string, d: unknown) => d },
    run: async () => { await g; return { type: "completion", content: "done" }; },
    resetCancel: () => {},
    cancel: () => {},
  };
  const bus = new MessageBus({
    sessionManager: { getAgent: () => agent },
    sink: { emit: () => {} },
    lanes,
  });
  void bus.run();
  bus.enqueue("hello");
  await new Promise((r) => setTimeout(r, 100));
  const during = await readdir(join(lanesDir, "pA")).catch(() => ["NO-DIR"]);
  gate();
  await new Promise((r) => setTimeout(r, 100));
  const after = await readdir(join(lanesDir, "pA")).catch(() => ["GONE"]);
  expect({ during, after }).toEqual({ during: ["slot-0"], after: [] });
  bus.cancel();
  await rm(lanesDir, { recursive: true, force: true });
});
