import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { LaneLedger } from "@core/session/lane-ledger.ts";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "lane-ledger-"));
}

/** Marker content shaped like the ledger's own, for fabricating holders. */
function marker(pid: number, host: string, token: string): string {
  return `${JSON.stringify({ pid, host, token, since: new Date().toISOString() })}\n`;
}

describe("LaneLedger", () => {
  it("acquire takes an exclusive slot file and release removes it", async () => {
    const dir = await freshDir();
    const led = new LaneLedger({ dir });
    const lease = await led.acquire("prov", 1);
    expect(lease).not.toBeNull();
    const slotPath = join(dir, "prov", "slot-0");
    expect(lease!.path).toBe(slotPath);
    const m = JSON.parse(await readFile(slotPath, "utf8"));
    expect(m.pid).toBe(process.pid);
    expect(m.token).toBe(lease!.token);
    await led.release(lease!);
    expect(await Bun.file(slotPath).exists()).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("cap 1: a live holder blocks, a release frees the slot", async () => {
    const dir = await freshDir();
    const led = new LaneLedger({ dir });
    const a = await led.acquire("prov", 1);
    expect(a).not.toBeNull();
    // A second ledger instance (another "TaskManager") must not fit.
    const led2 = new LaneLedger({ dir });
    expect(await led2.acquire("prov", 1)).toBeNull();
    await led.release(a!);
    expect(await led2.acquire("prov", 1)).not.toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("cap 2: two live owners fit, a third queues", async () => {
    const dir = await freshDir();
    const led = new LaneLedger({ dir });
    expect(await led.acquire("prov", 2)).not.toBeNull();
    expect(await led.acquire("prov", 2)).not.toBeNull();
    expect(await led.acquire("prov", 2)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  // Loop regression for the writeFile-wx window: open(O_CREAT|O_EXCL) and the
  // content write are separate syscalls, so a slot could exist-but-empty and be
  // judged corrupt, reclaimed off its live creator (measured 22/300 with cap 2
  // and 5 acquirers). Creation is now atomic (tmp + link), so winners are exact.
  it("concurrent acquirers race to exactly cap winners", async () => {
    for (let round = 0; round < 100; round++) {
      const dir = await freshDir();
      const led = new LaneLedger({ dir });
      const results = await Promise.all(
        Array.from({ length: 5 }, () => led.acquire("prov", 2)),
      );
      const winners = results.filter((r) => r !== null);
      expect(winners.length).toBe(2);
      // Winners must sit on distinct slots: duplicates would mean takeover.
      expect(winners.map((w) => w.path).sort()).toEqual([
        join(dir, "prov", "slot-0"),
        join(dir, "prov", "slot-1"),
      ]);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a dead same-host pid is reclaimed; a live one is respected", async () => {
    const dir = await freshDir();
    const ledDead = new LaneLedger({ dir, pid: 4242, pidAlive: () => false });
    const held = await ledDead.acquire("prov", 1);
    expect(held).not.toBeNull();
    // Our own liveness says 4242 is dead -> reclaim the slot.
    const led = new LaneLedger({ dir, pidAlive: (pid) => pid !== 4242 });
    const took = await led.acquire("prov", 1);
    expect(took).not.toBeNull();
    expect(took!.path).toBe(held!.path);
    await rm(dir, { recursive: true, force: true });
  });

  // C-M3 regression (T-3): the old reclaim renamed the stale marker aside,
  // leaving the slot path momentarily absent so a third acquirer could create
  // beside a still-live holder whose marker had just been moved. Reclaim must
  // go through an atomic rename-INTO-place, so while the slot is held or being
  // taken over the path is continuously occupied: a synchronous existence poll
  // (yielding between checks so the reclaim runs mid-poll) must never observe
  // absence. The probe against the old protocol saw the gap in 40/40 rounds.
  it("reclaim never lets an occupied slot appear free", async () => {
    const dir = await freshDir();
    const laneDir = join(dir, "prov");
    await mkdir(laneDir, { recursive: true });
    const slotPath = join(laneDir, "slot-0");
    // pid 4242 reads as dead, so every round takes the reclaim path.
    const led = new LaneLedger({ dir, pidAlive: (pid) => pid !== 4242 });
    let gapRounds = 0;
    const rounds = 40;
    for (let r = 0; r < rounds; r++) {
      await writeFile(slotPath, marker(4242, hostname(), `stale-${r}`));
      let done = false;
      let sawAbsence = false;
      const poll = (async () => {
        for (let i = 0; i < 20000 && !done && !sawAbsence; i++) {
          if (!existsSync(slotPath)) sawAbsence = true;
          else await new Promise((res) => setImmediate(res));
        }
      })();
      const lease = await led.acquire("prov", 1);
      done = true;
      await poll;
      expect(lease).not.toBeNull();
      // The winner's marker (not the stale one) is what stands on the slot.
      const m = JSON.parse(await readFile(slotPath, "utf8"));
      expect(m.token).toBe(lease!.token);
      // No `.stale-*` / `.claiming-*` litter survives a completed reclaim.
      expect(await readdir(laneDir)).toEqual(["slot-0"]);
      if (sawAbsence) gapRounds++;
      await led.release(lease!);
    }
    expect(gapRounds).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  // Companion to the gap test: a reclaim and a fresh claim racing for a slot
  // with a dead marker must converge to exactly one live marker on disk, and
  // every lease whose token is NOT on the slot must be inert (release cannot
  // evict the holder -- the token-checked contract that makes a stranded
  // phantom harmless).
  it("reclaim vs fresh claim converges to one live marker", async () => {
    const dir = await freshDir();
    const laneDir = join(dir, "prov");
    await mkdir(laneDir, { recursive: true });
    await writeFile(join(laneDir, "slot-0"), marker(4242, hostname(), "stale"));
    const led = new LaneLedger({ dir, pidAlive: (pid) => pid !== 4242 });
    const results = (await Promise.all([led.acquire("prov", 1), led.acquire("prov", 1)])).filter(
      (l): l is NonNullable<typeof l> => l !== null,
    );
    // The last renamer always reads back its own token, so someone wins.
    expect(results.length).toBeGreaterThanOrEqual(1);
    const finalToken = JSON.parse(await readFile(join(laneDir, "slot-0"), "utf8")).token;
    const holder = results.find((l) => l.token === finalToken);
    expect(holder).toBeDefined();
    // Adversarial release order: any superseded phantom goes first and must
    // not evict the standing marker; then the holder's release empties the lane.
    for (const phantom of results) {
      if (phantom === holder) continue;
      await led.release(phantom);
      expect(JSON.parse(await readFile(join(laneDir, "slot-0"), "utf8")).token).toBe(finalToken);
    }
    await led.release(holder!);
    expect(await readdir(laneDir)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it("a foreign-host marker blocks regardless of liveness", async () => {
    const dir = await freshDir();
    const laneDir = join(dir, "prov");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(laneDir, { recursive: true });
    await writeFile(join(laneDir, "slot-0"), marker(999999, "otherhost", "t"));
    const led = new LaneLedger({ dir, pidAlive: () => false }); // pid "dead" -- but host wins
    expect(await led.acquire("prov", 1)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("a corrupt marker is reclaimed, never truncated in place by the loser", async () => {
    const dir = await freshDir();
    const laneDir = join(dir, "prov");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(laneDir, { recursive: true });
    await writeFile(join(laneDir, "slot-0"), "not json at all");
    const led = new LaneLedger({ dir });
    const took = await led.acquire("prov", 1);
    expect(took).not.toBeNull();
    const m = JSON.parse(await readFile(join(laneDir, "slot-0"), "utf8"));
    expect(m.pid).toBe(process.pid);
    await rm(dir, { recursive: true, force: true });
  });

  it("release never deletes a slot another process retook (token mismatch)", async () => {
    const dir = await freshDir();
    const led = new LaneLedger({ dir });
    const lease = await led.acquire("prov", 1);
    // Simulate: someone else owns the file now (we were reclaimed as stale).
    await writeFile(lease!.path, marker(process.pid + 1, "localhost", "someone-else"));
    await led.release(lease!);
    expect(await Bun.file(lease!.path).exists()).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it("bare lane maps to '_'; provider names are percent-encoded", async () => {
    const dir = await freshDir();
    const led = new LaneLedger({ dir });
    expect(led.laneDir("")).toBe(join(dir, "_"));
    expect(led.laneDir("a/b")).toBe(join(dir, encodeURIComponent("a/b")));
    const bare = await led.acquire("", 1);
    expect(bare!.path).toBe(join(dir, "_", "slot-0"));
    await rm(dir, { recursive: true, force: true });
  });
});
