/**
 * ConfigStore -- the single owner of the process's resolved config.
 *
 * The boot pipeline (buildConfig via main.ts) stays as-is; its output is
 * ADOPTED here, and `core.config` / `core.resolved` become accessors that
 * answer from whatever generation this store holds. B1 is behavior-neutral:
 * boot adopts (twice -- createCore's config bag, then main.ts's
 * resolved-adopt), nobody calls swap() yet, and current() answers exactly
 * what the plain core properties answered before. The notify-pass machinery
 * above the atom (live.ts's onConfigChange, the apply hooks, the write
 * transaction) arrives in later batches; this file ships the generation atom
 * and the publish mechanics only.
 */
import { reactiveState, type Atom } from "@utils/reactive-state.ts";
import type { CoreConfigWithExtensions } from "./schema-loader.ts";
import type { ResolvedConfig } from "../extensions/types.ts";

/** One complete view of the running config. Built wholesale by boot or by a
 *  re-resolve, then treated as read data (the two documented mutable
 *  identities -- resolved.modelRegistry and intentional live references --
 *  ride the bag, see design §1.5). */
export interface ConfigGeneration {
  /** Monotonic publish counter; doubles as the notify batch id.
   *  0 means "never published" (the boot generation). */
  batchId: number;
  /** The loaded+merged bag (today's core.config surface: schema defaults,
   *  file bytes, env-interpolated, extension-resolved blocks merged in). */
  config: CoreConfigWithExtensions;
  /** The resolution chain's output (today's core.resolved surface).
   *  Undefined only in the boot window between config-adopt and the
   *  main.ts resolved-adopt -- same as today's optional core.resolved. */
  resolved?: ResolvedConfig;
  /** Top-level keys whose canonical value differs from the previous
   *  generation (computed at swap time). */
  changed: string[];
  /** Durable degraded-apply reports attached at commit: a subsystem still
   *  honoring less than this generation says. Cleared by the next successful
   *  publish touching that prefix. The field ships typed in B1; the
   *  apply-hook producers are later batches. */
  degraded?: Array<{ keyPath: string; why: string }>;
}

export interface ConfigStore {
  /** The notify seam: one reactiveState atom of generations. Set only by a
   *  commit (one publish = one fire); its seed value is unreachable through
   *  current() and never observed at boot (no subscriber exists before the
   *  first live publish). */
  readonly generation: Atom<ConfigGeneration>;
  /** Property access at call time -- the stable read surface. */
  current(): ConfigGeneration;

  /** Boot adoption (createCore's config bag; main.ts's resolved-adopt goes
   *  through the core `resolved` setter's adopt). Boot adopts TWICE: an
   *  adopt REPLACES the pending generation WITHOUT firing the atom (boot
   *  fires nothing), and batchId is assigned on the first LIVE publish.
   *  THROWS once anything has published (§1.6): a mid-process adopt would
   *  replace a generation with no publish. */
  adopt(config: CoreConfigWithExtensions, resolved?: ResolvedConfig): void;

  /** Prefixes currently between swap and commit -- an apply-hooks pass is in
   *  flight. A snapshot row under an applying prefix renders "applying",
   *  never a bare live value (a rebind in progress is not yet listening). */
  applying(): readonly string[];

  /** The ONLY mutation step, called by the write transaction:
   *  makes the accessors read `next` immediately, computes `changed`
   *  (top-level canonical-JSON diff against the current generation) and
   *  records it as applying prefixes; returns the one-shot commit that clears
   *  applying (attaching the degraded list, §3.2 clearing rule included) and
   *  fires the atom exactly once after the apply hooks run. Throws if a
   *  commit is already pending: publishes serialize, a second publisher
   *  fails loudly instead of interleaving notify passes. */
  swap(next: {
    config: CoreConfigWithExtensions;
    resolved: ResolvedConfig;
  }): (degraded?: Array<{ keyPath: string; why: string }>) => ConfigGeneration;
}

/** Canonical JSON for the changed-diff: key-sorted stringify, so a
 *  re-resolve that rebuilds a subtree with a different key order compares
 *  equal and only real value differences land in `changed`. */
function canon(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "\u0000"; // stringify(undefined) -> undefined (unset vs unset reads equal)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortKeys(src[key]);
    return out;
  }
  return value;
}

function bagKey(bag: object | undefined, key: string): unknown {
  return bag === undefined ? undefined : (bag as Record<string, unknown>)[key];
}

/** Top-level keys whose canonical value differs across the two bags. The
 *  two surfaces share one prefix namespace (a hook on "providers" means the
 *  root in config AND resolved), so a differing root in either bag records
 *  the key once. Computed BEFORE the swap mutates anything: a throwing
 *  compare (e.g. a cyclic value) leaves the store on the previous
 *  generation.
 *
 *  Exported (B4): the write transaction needs the SAME diff BEFORE the swap
 *  to prefix-match prepare hooks (§2.4); swap() recomputes it verbatim, so
 *  the prepare-time and commit-time views cannot drift. */
export function diffChanged(
  prev: ConfigGeneration,
  next: { config: CoreConfigWithExtensions; resolved: ResolvedConfig },
): string[] {
  const keys = new Set([
    ...Object.keys(prev.config ?? {}),
    ...Object.keys(next.config ?? {}),
    ...Object.keys((prev.resolved as object | undefined) ?? {}),
    ...Object.keys(next.resolved as object),
  ]);
  const changed: string[] = [];
  for (const key of keys) {
    if (
      canon(bagKey(prev.config, key)) !== canon(bagKey(next.config, key)) ||
      canon(bagKey(prev.resolved, key)) !== canon(bagKey(next.resolved, key))
    ) {
      changed.push(key);
    }
  }
  return changed;
}

/** Is a degraded report's prefix touched by this publish? Reports key by
 *  path ("webui.port", or "" for a global report); `changed` lists top-level
 *  roots, so a report is touched when its root is in the diff (a global
 *  report is touched by every publish). */
function publishTouches(changed: readonly string[], reportKeyPath: string): boolean {
  return reportKeyPath === "" || changed.includes(reportKeyPath.split(".")[0]!);
}

export function createConfigStore(): ConfigStore {
  // The store's own current generation: adopt() writes it silently, swap()
  // moves it, commit() only notifies. Undefined until the first boot adopt
  // (createCore adopts before the core object is observable).
  let generationNow: ConfigGeneration | undefined;
  let published = 0;
  let applyingNow: readonly string[] = [];
  let pendingCommit = false;

  // reactiveState needs a seed at construction; adopt() never sets the atom,
  // so this placeholder is unreachable through current() (the documented read
  // surface) and unobservable at boot (effects fire only on sets).
  const generationAtom = reactiveState<ConfigGeneration>({
    batchId: 0,
    config: {} as CoreConfigWithExtensions,
    changed: [],
  });

  function current(): ConfigGeneration {
    if (!generationNow) {
      throw new Error("[config-store] current() before adopt() -- the boot pipeline must adopt the config bag first");
    }
    return generationNow;
  }

  return {
    generation: generationAtom,

    current,

    adopt(config, resolved) {
      // §1.6 assert (mirrors swap()'s pendingCommit guard): adopt is legal
      // ONLY in the boot window, before the first live publish. A mid-process
      // adopt would silently replace a published generation with batchId 0
      // and no notify pass -- every reader would move without a word.
      if (published > 0) {
        throw new Error("[config-store] adopt() after a publish -- boot adopts only; mid-process replacement belongs to the write transaction (swap -> commit)");
      }
      // Boot path: replace the pending generation. The atom is NEVER set
      // here -- no subscriber exists at boot, and boot fires nothing.
      // batchId 0 = never published (a post-live adopt is out of contract;
      // only the write transaction publishes after boot).
      generationNow = { batchId: 0, config, resolved, changed: [] };
    },

    applying() {
      return applyingNow;
    },

    swap(next) {
      if (pendingCommit) {
        throw new Error("[config-store] swap() while a commit is pending -- publishes must serialize");
      }
      const prev = current();
      const changed = diffChanged(prev, next);
      const gen: ConfigGeneration = {
        batchId: ++published,
        config: next.config,
        resolved: next.resolved,
        changed,
        // Carry the previous degraded reports; commit re-attaches per the
        // clearing rule (a publish touching a report's prefix decides it).
        degraded: prev.degraded,
      };
      generationNow = gen; // reads see the NEW generation immediately (torn-read posture)
      applyingNow = [...changed];
      pendingCommit = true;

      let done = false;
      return (degraded) => {
        if (done) {
          throw new Error("[config-store] commit() already ran for this swap -- one notify pass per publish");
        }
        done = true;
        pendingCommit = false;
        applyingNow = [];
        const kept = (gen.degraded ?? []).filter((d) => !publishTouches(changed, d.keyPath));
        const attached = degraded ? [...kept, ...degraded] : kept;
        gen.degraded = attached.length > 0 ? attached : undefined;
        generationAtom(gen); // object sets always fire: exactly one notify pass
        return gen;
      };
    },
  };
}
