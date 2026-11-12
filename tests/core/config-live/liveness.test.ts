/**
 * Canonical liveness (design §9 test 1 SHAPE, §4.5-1): every B4 probe row
 * runs the REAL write transaction (applyConfigKeyEdit, injected fs deps,
 * temp config dir, real store) on ONE live boot host -- and the OBSERVABLE
 * answers the new value with no restart in sight. Includes the contract's
 * two named musts: websocket.sessionTimeoutMin changes eviction-age BEHAVIOR,
 * and the baseUrl row reaches the AGENT PLANE (an agent the factory builds
 * AFTER the write holds the same shared client object and reads the new
 * endpoint -- the §3.3 row is worthless without this probe).
 *
 * One env for the whole file on purpose: the rows each write their own key
 * exactly once, so every row's `before` control still holds across the run,
 * and no stale WsServer's hooks are left around firing into a later env's
 * transaction (the hook table is process-global and registration is per
 * create()).
 */
import { describe, it, expect, afterAll } from "bun:test";
import { applyConfigKeyEdit } from "@extensions/websocket/handlers-config.ts";
import { createAgentFactory } from "@core/agent-factory.ts";
import { PROBES, bootLive, fsDeps, withShadowEnvCleared, type LiveEnv } from "./probes.ts";

const env: LiveEnv = await bootLive();
afterAll(() => env.cleanup());

describe("config-live B4 canonical liveness (real transaction, no restart)", () => {
  for (const row of PROBES) {
    it(`${row.keyPath}: the observable moves through the transaction`, async () => {
      if (row.setup) await row.setup(env);

      // Control: before the write the observable answers the boot value.
      expect(row.observe(env)).toEqual(row.before);

      await withShadowEnvCleared(async () => {
        const res = await applyConfigKeyEdit(env.core, row.keyPath, row.input, { deps: fsDeps });
        expect(res.ok, `${row.keyPath} write must land: ${res.ok ? "" : res.error}`).toBe(true);
        if (res.ok) {
          // Every probe row is a migrated live-class key with its hook
          // registered on this host: the attestation must claim LIVE.
          // Rows carrying an attest() (B7: the one process-pollution-
          // sensitive row) pin their attestation exactly through it; every
          // other row -- the committed B4 set -- keeps the strict claim.
          if (row.attest) {
            expect(row.attest(res), `${row.keyPath} attestation violations`).toEqual([]);
          } else {
            expect(res.applied).toBe("live");
            expect(res.needsRestart).toBe(false); // the legacy shim DERIVES off applied
          }
        }
      });

      expect(row.observe(env)).toEqual(row.expect);

      // Optional write-back (B7): a value the shared host must not keep is
      // restored through a second real transaction, so the rows after this one
      // and the agent-plane test below run on boot semantics.
      if (row.restore) {
        await withShadowEnvCleared(async () => {
          const back = await applyConfigKeyEdit(env.core, row.keyPath, row.restore!, { deps: fsDeps });
          expect(back.ok, `${row.keyPath} restore write must land: ${back.ok ? "" : back.error}`).toBe(true);
        });
      }
      // A row that installed a global spy (the health-sweep re-arm) hands it
      // back here, whether or not the assertion path took it.
      (env as LiveEnv & { __b7Restore?: () => void }).__b7Restore?.();
    });
  }

  it("baseUrl reaches the AGENT PLANE: a factory-built agent after the write hits the new endpoint", async () => {
    const factory = createAgentFactory(env.core, { llmClient: env.ws.llmClient });

    await withShadowEnvCleared(async () => {
      const res = await applyConfigKeyEdit(
        env.core,
        "aiUrl",
        { value: "http://agent-plane.invalid/v1" },
        { deps: fsDeps },
      );
      expect(res.ok, res.ok ? "" : res.error).toBe(true);
      if (res.ok) expect(res.applied).toBe("live");
    });

    // The agent the factory builds AFTER the write takes options.llmClient --
    // the ONE shared object the hook reassigned in place (§3.3: all three
    // holders see it; a rebuilt reference could not).
    const agent = await factory({ model: "probe/model" });
    expect(agent.llmClient).toBe(env.ws.llmClient);
    expect(agent.llmClient.baseUrl).toBe("http://agent-plane.invalid/v1");

    // Request-level proof: the next request the client builds reads the
    // reassigned field (client.ts:236-245 doctrine). Spy fetch, ping, look
    // at where the request actually went.
    const original = globalThis.fetch;
    const seen: string[] = [];
    try {
      globalThis.fetch = (async (url: string | URL | Request) => {
        seen.push(String(url));
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      await agent.llmClient.ping();
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toEqual(["http://agent-plane.invalid/v1/health"]);
  });

  it("the modelRegistry is the carried-forward object across a publish (mutable identity #1)", async () => {
    const bootRegistry = env.core.resolved!.modelRegistry;
    // The sweep-piggyback doctrine: the registry object is upsert-mutated,
    // never replaced -- seed one entry, publish a write, the entry survives
    // on the SAME object.
    bootRegistry["boot/model"] = { name: "boot/model", temperature: null, contextLimit: 1000, tags: [] };
    const batchBefore = env.store.current().batchId;
    await withShadowEnvCleared(async () => {
      const res = await applyConfigKeyEdit(env.core, "maxRetries", { value: 3 }, { deps: fsDeps });
      expect(res.ok, res.ok ? "" : res.error).toBe(true);
    });
    expect(env.core.resolved!.modelRegistry).toBe(bootRegistry);
    expect(env.core.resolved!.modelRegistry["boot/model"]).toBeDefined();
    expect(env.store.current().batchId).toBe(batchBefore + 1); // one publish per write
  });
});
