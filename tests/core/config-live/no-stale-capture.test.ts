/**
 * tests/core/config-live/no-stale-capture.test.ts -- design §4.5 item 2, the
 * stale-copy source lint. Plain `Bun.file` + regex, zero deps, same spirit as
 * the wire-shape pins: it reads the PINNED migrated-file list (every file the
 * B3->B7 train migrated to live reads) and fails on the create/build-scope
 * capture idioms §4.1 prohibits:
 *
 *   - `getExtensionConfig(...)` assigned to a const/let (the block capture --
 *     the exact idiom the migration deleted, whether in create() or anywhere
 *     else a line regex can see it);
 *   - `const { ... } = getExtensionConfig(` block destructure;
 *   - `{ ...core.config }` / `{ ...baseConfig }` whole-bag spreads (a copy
 *     with extra steps; sub-block reads like `baseConfig.bashTool` are NOT
 *     whole-bag spreads and stay unflagged);
 *   - a lazy `const x = () => getExtensionConfig(...)` reader closure --
 *     the SANCTIONED shape, but each instance is enumerated in the allow-list
 *     too: the lint's promise is that every place a migrated file touches
 *     getExtensionConfig through a binding is a REVIEWED place, so a new
 *     block() in a new file is as red as a new capture.
 *
 * Allow-list doctrine (§4.5: "the allow-list shrinks batch by batch and the
 * test forbids growing it without a reviewer comment"):
 *   - every hit must match an ALLOW entry (file + line-matching pattern);
 *   - every entry carries a `why` -- a reviewer comment naming its live
 *     class and why this occurrence is the migrated shape, not a stale copy.
 *     An entry with a blank/short why fails;
 *   - every entry must still match at least one hit -- when code drops a
 *     capture, its entry goes stale and the test goes red until the entry
 *     shrinks with the code. That is the ratchet.
 */
import { describe, it, expect } from "bun:test";

/** Every file the train migrated (B3 quick wins, B5 agent layer, B6a/B6b
 *  tool families, B7 skills/prompts/agents-md/workflows). A renamed or
 *  deleted file fails the existence test: the list is a pin, not a hint. */
const MIGRATED: string[] = [
  "src/core/agent-factory.ts", // B5 §4.2 overlay; B3 per-build profiles reader
  "src/core/session/task-manager.ts", // B3 modelGroups reader
  "src/extensions/websocket/session-registry.ts", // B3 question-armed reads
  "src/extensions/websocket/server.ts", // B3 toolExecResolved posture strip
  "src/extensions/compaction/index.ts", // B3 per-run runSettings
  "src/extensions/tool-call-repair/index.ts", // B3 per-turn maxRepairsPerTurn
  "src/extensions/core-tools/index.ts", // B6a block() reader
  "src/extensions/core-tools/read.ts", // B6a knob fields
  "src/extensions/core-tools/edit.ts",
  "src/extensions/core-tools/grep.ts",
  "src/extensions/core-tools/find.ts",
  "src/extensions/core-tools/project-info.ts",
  "src/extensions/bash-tool/index.ts", // B6a block() reader, spawn-time posture
  "src/extensions/fetch-tool/index.ts", // B6b block() reader, per-request posture
  "src/extensions/web-search/index.ts", // B6b block() reader, per-search reads
  "src/extensions/handoff-tool/index.ts", // B6b per-handoff bytes read
  "src/extensions/loop-detect/index.ts", // B6b per-turn thresholds + derived window
  "src/extensions/loop/index.ts", // B6b per-check maxLoops
  "src/extensions/skills/index.ts", // B7 lazy block() + path reader into the loader
  "src/extensions/skills/loader.ts", // B7 ConfigKnob path (no getExtensionConfig seam)
  "src/extensions/prompts/index.ts", // B7 displayPrompt reader; path create-pinned
  "src/extensions/prompts/loader.ts", // B7 display knob (no getExtensionConfig seam)
  "src/extensions/agents-md/index.ts", // B7 autoload read per SYSTEM_PROMPT_BUILD
  "src/extensions/workflows/index.ts", // B7 limits/dir/toggle/groups readers
  "src/extensions/workflows/engine.ts", // B7 per-run freeze of dispatch-time values
  "src/extensions/workflows/workflow-tools.ts", // B7 readKnob at use sites
];

const IDIOMS: Array<{ id: string; re: RegExp }> = [
  // The block capture: `const cfg = getExtensionConfig(...)`. The accessor
  // call itself per use (`if (!getExtensionConfig(...).enabled)`, `return
  // getExtensionConfig(...)`, fields handed into readers) is NOT an
  // assignment and stays clean -- §4.1's rule is about what SURVIVES the use
  // boundary in a binding.
  { id: "block-capture", re: /(?:const|let)\s+[\w$]+\s*=\s*getExtensionConfig\s*[<(]/ },
  // Block destructure -- forbidden outright (§4.5 names it verbatim).
  { id: "destructure", re: /(?:const|let)\s*\{[^}]*\}\s*=\s*getExtensionConfig\s*[<(]/ },
  // Whole-bag spread. The lookahead keeps sub-block reads (`baseConfig.bashTool`,
  // `core.configStore`) out: §4.5 forbids copying THE BAG, not reading a key.
  { id: "bag-spread", re: /\.\.\.\s*\(?\s*(?:core\.config|baseConfig|options\.config)\b(?!\s*[.\w])/ },
];

/** A lazy reader closure (sanctioned, but enumerated): `const x = () =>
 *  getExtensionConfig(...)`, single-line or with the call on the next line
 *  (bash/fetch format it multi-line with a generic). */
const CLOSURE_START = /(?:const|let)\s+[\w$]+\s*=\s*\(\s*\)\s*=>/;

interface AllowEntry {
  /** Repo-relative migrated file the entry lives in. */
  file: string;
  /** RegExp source matched against the offending (or closure-start) line. */
  pattern: string;
  /** Reviewer comment: the live class this occurrence IS, per §4.3/§4.5. */
  why: string;
}

const ALLOW: AllowEntry[] = [
  // ── the sanctioned lazy block() readers (§4.1 Pattern-A shape: the
  //    closure is invoked per use, so nothing crosses the use boundary) ────
  {
    file: "src/extensions/core-tools/index.ts",
    pattern: "const block = \\(\\) => getExtensionConfig",
    why: "Sanctioned lazy reader (B6a): every tool knob is `() => block().<field>`, resolved per execute; the closure holds `core`, never the block.",
  },
  {
    file: "src/extensions/bash-tool/index.ts",
    pattern: "const block = \\(\\) =>",
    why: "Sanctioned lazy reader (B6a, multi-line call): timeouts per execute, scrub posture per spawn; the only captured value is bashTool.env, deliberately, at its own line (§5.4).",
  },
  {
    file: "src/extensions/fetch-tool/index.ts",
    pattern: "const block = \\(\\) =>",
    why: "Sanctioned lazy reader (B6b, multi-line call): caps and the ruled-live posture pair read per request; env-layer resolution upstream of the block is inherited by construction.",
  },
  {
    file: "src/extensions/web-search/index.ts",
    pattern: "const block = \\(\\) => getExtensionConfig",
    why: "Sanctioned lazy reader (B6b): provider/caps/secrets per search; redaction doctrine lives at the audit lines, not in any capture.",
  },
  {
    file: "src/extensions/loop-detect/index.ts",
    pattern: "const block = \\(\\) => getExtensionConfig",
    why: "Sanctioned lazy reader (B6b): thresholds per turn, the history window DERIVED at use from the same read (no cached window).",
  },
  {
    file: "src/extensions/loop/index.ts",
    pattern: "const block = \\(\\) => getExtensionConfig",
    why: "Sanctioned lazy reader (B6b): maxLoops at each loop check; a running lap keeps the cap its count was scored on (P8, pinned in extensions tests).",
  },
  {
    file: "src/extensions/skills/index.ts",
    pattern: "const block = \\(\\) => getExtensionConfig",
    why: "Sanctioned lazy reader (B7): the loader holds `() => block().path ?? bootPath`; preloadSkills stays the honest create-time act the §4.3 skills row names (next-session).",
  },
  {
    file: "src/extensions/workflows/index.ts",
    pattern: "const block = \\(\\) => getExtensionConfig",
    why: "Sanctioned lazy reader (B7): limits/dir/toggle resolve per validate/dispatch and per lookup; the boot durability scan reads the boot value ONCE, as boot machinery.",
  },

  // ── per-use function bodies: the accessor is CALLED inside the function,
  //    so the const holds a fresh value (or field) per invocation ───────────
  {
    file: "src/extensions/compaction/index.ts",
    pattern: "const s = getExtensionConfig",
    why: "Inside runSettings(), a per-run function body (§4.3 compaction row): the per-run settings view is rebuilt every call -- exactly the shape that replaced the create-time capture and the deleted contextLimit boot mutator.",
  },
  {
    file: "src/extensions/tool-call-repair/index.ts",
    pattern: "const \\{ maxRepairsPerTurn \\} = getExtensionConfig",
    why: "Inside a per-turn handler body (§4.3 toolCallRepair row): destructure of a FRESH per-turn call -- the per-turn value is the live class; forbidden is destructuring create-scope, which this file no longer has.",
  },
  {
    file: "src/extensions/handoff-tool/index.ts",
    pattern: "const raw = getExtensionConfig",
    why: "Inside resolveAutoIncludeBytes(), called per file-carrying handoff (§4.3 handoff row): fail-loud read moved WITH the capture to the point of use; the retired boot throw is documented there.",
  },
  {
    file: "src/extensions/agents-md/index.ts",
    pattern: "const autoload = getExtensionConfig",
    why: "Inside the SYSTEM_PROMPT_BUILD handler (§4.3 agents-md row): the const holds the BOOLEAN from a fresh per-rebuild call, not the block; live both directions next rebuild, P8 for in-flight requests.",
  },

  // ── boot gates: create-scope reads whose ONLY consumer is the gate itself
  //    (X/P1: false-at-boot means the extension does not exist -- there is
  //    no live surface for the captured value to lie to) ────────────────────
  {
    file: "src/extensions/handoff-tool/index.ts",
    pattern: "const config = getExtensionConfig<\\{ enabled\\??: boolean \\}>",
    why: "Boot gate only (X/P1 §4.3): consumed by the `enabled === false` early return on the next statement; nothing else reads `config`, so nothing crosses the create boundary.",
  },
  {
    file: "src/extensions/loop-detect/index.ts",
    pattern: "const config = getExtensionConfig",
    why: "Boot gate only (X/P1 §4.3): the enabled early-return is its sole consumer; the live thresholds ride the block() reader entry above.",
  },
  {
    file: "src/extensions/loop/index.ts",
    pattern: "const config = getExtensionConfig",
    why: "Boot gate only (X/P1 §4.3): enabled early-return only; maxLoops rides the block() reader entry above.",
  },
  {
    file: "src/extensions/prompts/index.ts",
    pattern: "const boot = getExtensionConfig",
    why: "Create scope BY RULING of the §4.3 prompts row: only loader-lifecycle inputs (path + deprecated promptsPath compat, next-session fs-import machinery) are read here; the one live knob, displayPrompt, is handed to the loader as a reader below this line.",
  },

  // ── §4.2 overlay: the surviving bag copies are the PINNED-host branch the
  //    contract itself ruled to keep (agents-factory explicit options stay
  //    byte-identical by construction) ─────────────────────────────────────
  {
    file: "src/core/agent-factory.ts",
    pattern: "const baseConfig = \\{ \\.\\.\\.\\(options\\.config \\?\\? core\\.config\\)",
    why: "§4.2 ruled: the copy serves explicit options.config hosts (pinned by construction) and the per-build snapshot reads (toolExecConfig for the worker plane, X/E1); the DEFAULT store-backed path answers through the liveAgentConfig Proxy instead.",
  },
  {
    file: "src/core/agent-factory.ts",
    pattern: "^\\s*\\.\\.\\.baseConfig,\\s*$",
    why: "§4.2 ruled: the pinned-host / store-less branch of the agent-config view -- the byte-identical point-in-time copy is exactly the pinned semantics (live hosts take the Proxy branch above it).",
  },
];

interface Hit {
  file: string;
  line: number;
  id: string; // idiom id, or "lazy-reader-closure"
  text: string;
}

async function scanFile(rel: string): Promise<Hit[]> {
  const text = await Bun.file(new URL(`../../../${rel}`, import.meta.url)).text();
  const lines = text.split("\n");
  const hits: Hit[] = [];
  lines.forEach((line, i) => {
    for (const { id, re } of IDIOMS) {
      if (re.test(line)) hits.push({ file: rel, line: i + 1, id, text: line.trim() });
    }
    if (CLOSURE_START.test(line)) {
      // The call may ride the same line or (bash/fetch formatting) the next.
      const sameOrNext =
        /\)\s*=>\s*getExtensionConfig/.test(line) ||
        /^\s*getExtensionConfig\s*[<(]/.test(lines[i + 1] ?? "");
      if (sameOrNext) hits.push({ file: rel, line: i + 1, id: "lazy-reader-closure", text: line.trim() });
    }
  });
  return hits;
}

describe("no-stale-capture (§4.5 item 2): migrated files carry no un-reviewed config capture", () => {
  // Read the whole tree once; every other test works off this scan.
  const scanned: Promise<Hit[]> = Promise.all(MIGRATED.map(scanFile)).then((h) => h.flat());

  it("every migrated file exists and is readable (the pin list is not a hint)", async () => {
    for (const rel of MIGRATED) {
      const f = Bun.file(new URL(`../../../${rel}`, import.meta.url));
      expect(await f.exists()).toBe(true);
    }
  });

  it("no forbidden idiom or lazy reader closure survives outside the allow-list", async () => {
    const unreviewed: string[] = [];
    for (const hit of await scanned) {
      const covered = ALLOW.some(
        (e) => e.file === hit.file && new RegExp(e.pattern).test(hit.text),
      );
      if (!covered) unreviewed.push(`${hit.file}:${hit.line} [${hit.id}] ${hit.text.slice(0, 100)}`);
    }
    expect(unreviewed).toEqual([]);
  });

  it("every allow-list entry carries a reviewer comment (§4.5: growth without one is red)", () => {
    for (const e of ALLOW) {
      expect(e.why.trim().length, `allow-list entry ${e.file} :: ${e.pattern} lacks a reviewer comment`).toBeGreaterThanOrEqual(
        40,
      );
    }
  });

  it("the allow-list shrinks with the code: no entry matches nothing", async () => {
    const hits = await scanned;
    const stale: string[] = [];
    for (const e of ALLOW) {
      const re = new RegExp(e.pattern); // throws on a broken pattern -- loud is fine
      if (!hits.some((h) => h.file === e.file && re.test(h.text))) {
        stale.push(`${e.file} :: ${e.pattern}`);
      }
    }
    expect(stale).toEqual([]);
  });
});
