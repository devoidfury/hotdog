// renderer-pty-3c: scripted PTY test suite for the stage-3c renderer work.
//
// Host-only terminal-state test tooling, deliberately OUTSIDE the unit lane
// (AGENTS.md §11 bans PTYs from the unit suite; this is the pty-tests lane
// that owns exactly that real-terminal ground truth -- separate by design:
// the ~10s unit budget and the python3 pty host dep). Never invoked by bun
// test: bunfig.toml pathIgnorePatterns covers pty-tests/** and no file here
// matches the test pattern.
//
// One command:   bun run test:pty   (= bun pty-tests/pty-renderer-3c/run-pty-suite.ts [--loops N])
//
// For every scenario: an isolated HOME/config dir (HOTDOG_CONFIG_DIR seam,
// docs/config-reference.md) points at a local canned-OpenAI stub (bun.serve,
// deterministic, zero network); `bun bin/hotdog` runs under a REAL pty
// (pty_driver.py, python stdlib) driven by an expect-script; every master
// byte is captured raw and asserted byte-level (DEC mode accounting, stty
// orphan-proof, legacy-parity profiles). Results land under
// pty-tests/results/<lane>-<timestamp>/runs.jsonl + summary.json -- the
// naming convention is kept so pre-move sweeps under evals/results correlate.

import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resultsDirName } from "../../evals/lib/format.ts";

const SERIES = "pty-renderer-3c";
const HERE = import.meta.dir;
const REPO = join(HERE, "..", "..");
const DRIVER = join(HERE, "pty_driver.py");
const RENDERER = join(HERE, "render-trace.ts");
const BUN = process.execPath;

// ── stub OpenAI-compatible server (bun.serve, canned, deterministic) ────────

const STUB_ANSWER_NEEDLE = "STUB_ANSWER_7734";
const STUB_TOOL_MARKER = "ASKFRUIT";

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function stubBody(raw: string): string {
  let parsed: { messages?: Array<{ role?: string }> };
  try {
    parsed = JSON.parse(raw) as { messages?: Array<{ role?: string }> };
  } catch {
    return sse({ error: "stub: unparseable request" });
  }
  const messages = parsed.messages ?? [];
  // Branch off the request TAIL, not history-membership: after a cancelled
  // question the history permanently holds a tool result (and the ASKFRUIT
  // user row), so "some message is a tool result" would hijack every later
  // turn. What matters is what the NEXT reply is responding to.
  const last = messages[messages.length - 1];
  const lastIsTool = last?.role === "tool";
  const askedFruit = last?.role === "user" && JSON.stringify(last).includes(STUB_TOOL_MARKER);
  const out: string[] = [];
  if (!lastIsTool && askedFruit) {
    // The held-question trigger: a tool call the tool-context question flow
    // answers through runQuestions/collectAnswers. Free-text, optional: the
    // BLANK answer must resolve, not re-prompt.
    out.push(
      sse({
        id: "chatcmpl-stub",
        object: "chat.completion.chunk",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_stub_q1",
              type: "function",
              function: {
                name: "question",
                arguments: JSON.stringify({
                  questions: [{ key: "flavor", prompt: "Pick a flavor", required: false }],
                }),
              },
            }],
          },
          finish_reason: null,
        }],
      }),
      sse({
        id: "chatcmpl-stub",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }),
    );
  } else if (lastIsTool) {
    // The answer came back through the wire (request ends on the tool
    // result): echo its shape so the scrollback itself is the
    // round-trip evidence.
    const got = raw.includes("vanilla") ? "vanilla" : "blank";
    out.push(
      sse({
        id: "chatcmpl-stub",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: `STUB_FINAL ${got}` }, finish_reason: null }],
      }),
      sse({
        id: "chatcmpl-stub",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    );
  } else {
    out.push(
      sse({
        id: "chatcmpl-stub",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: `${STUB_ANSWER_NEEDLE}: hello ` }, finish_reason: null }],
      }),
      sse({
        id: "chatcmpl-stub",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "from the stub." }, finish_reason: null }],
      }),
      sse({
        id: "chatcombl-stub",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    );
  }
  out.push("data: [DONE]\n\n");
  return out.join("");
}

// ── scenario plumbing ───────────────────────────────────────────────────────

type Step =
  | { op: "expect"; needle: string; timeout?: number; capture_pid?: boolean }
  | { op: "send"; data: string; pre_pause?: number }
  | { op: "sleep"; secs: number }
  | { op: "signal"; sig: number; from_captured_pid?: boolean }
  | { op: "termios_probe" };

interface Scenario {
  id: string;
  kind: "gate" | "evidence";
  knob: "split" | "legacy";
  term: string;
  noColor: string;
  cols: number;
  rows: number;
  script: Step[];
  checks: Check[];
}

interface Check {
  name: string;
  run: (cap: Buffer, probes: Probe[]) => { pass: boolean; detail: string };
}

interface Probe {
  label: string;
  echo: boolean;
  icanon: boolean;
}

function count(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

function between(hay: string, start: string, end: string): string {
  const s = hay.indexOf(start);
  const e = hay.indexOf(end, s + 1);
  return s < 0 ? "" : hay.slice(s, e < 0 ? hay.length : e);
}

/** stty -a token check: exact token present, its "-" twin absent. */
function sttyFlag(seg: string, flag: string): { pass: boolean; detail: string } {
  const toks = seg.split(/[\s:;]+/).filter(Boolean);
  const on = toks.includes(flag);
  const off = toks.includes(`-${flag}`);
  return {
    pass: on && !off,
    detail: on && !off ? `${flag} ON (no -${flag})` : `${flag} on=${on} off=${off}`,
  };
}

function sttyRestored(seg: string): { pass: boolean; detail: string } {
  const canon = sttyFlag(seg, "icanon");
  const echo = sttyFlag(seg, "echo");
  return {
    pass: canon.pass && echo.pass,
    detail: `canonical=${canon.detail}; echo=${echo.detail}`,
  };
}

/** ?2026 begin/end: equal counts AND no prefix ever has more ends than begins. */
function syncBalanced(cap: string): { pass: boolean; detail: string } {
  let depth = 0;
  let minDepth = 0;
  let i = 0;
  while (i < cap.length) {
    const h = cap.indexOf("\x1b[?2026h", i);
    const l = cap.indexOf("\x1b[?2026l", i);
    if (h < 0 && l < 0) break;
    if (l >= 0 && (h < 0 || l < h)) {
      depth--;
      minDepth = Math.min(minDepth, depth);
      i = l + 8;
    } else {
      depth++;
      i = h + 8;
    }
  }
  const nH = count(cap, "\x1b[?2026h");
  const nL = count(cap, "\x1b[?2026l");
  return {
    pass: depth === 0 && minDepth === 0 && nH > 0,
    detail: `begins=${nH} ends=${nL} finalDepth=${depth} minPrefixDepth=${minDepth}`,
  };
}

/**
 * Multiset of every ESC sequence + bare control byte on the wire. Printable
 * text is excluded on purpose: session ids and pids differ per run, the
 * CONTROL plane must not.
 */
function escInventory(cap: Buffer): Map<string, number> {
  const re = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[=>78MH]|[\x08\x09\x0a\x0d\x7f]/g;
  const inv = new Map<string, number>();
  for (const m of cap.toString("latin1").matchAll(re)) {
    inv.set(m[0], (inv.get(m[0]) ?? 0) + 1);
  }
  return inv;
}

/**
 * Cross-scenario gate: knob=split + TERM=dumb on a real pty must produce
 * EXACTLY the legacy knob's wire (the §9 decline hands the session to the
 * legacy path, so the bytes must BE the legacy bytes -- "no cursor
 * addressing beyond what legacy emits", residual R2 in machine form: any
 * renderer mode byte or addressing escape that leaked past the gate shows up
 * as a multiset diff against the C2 baseline).
 */
function legacyParity(root: string, loops: number): { pass: boolean; detail: string } {
  const diffs: string[] = [];
  for (let i = 1; i <= loops; i++) {
    const aPath = join(root, `C-dumb-split-knob-loop${i}`, "capture.raw");
    const bPath = join(root, `C2-legacy-baseline-loop${i}`, "capture.raw");
    if (!existsSync(aPath) || !existsSync(bPath)) {
      diffs.push(`loop${i}: capture missing`);
      continue;
    }
    const a = escInventory(Buffer.from(readFileSync(aPath)));
    const b = escInventory(Buffer.from(readFileSync(bPath)));
    for (const k of new Set([...a.keys(), ...b.keys()])) {
      const na = a.get(k) ?? 0;
      const nb = b.get(k) ?? 0;
      if (na !== nb) diffs.push(`loop${i}: ${JSON.stringify(k)} split-knob=${na} legacy=${nb}`);
    }
  }
  return {
    pass: diffs.length === 0,
    detail: diffs.length === 0
      ? `split-knob+dumb wire == legacy wire in all ${loops} loops (ESC/control multisets identical)`
      : diffs.join("; "),
  };
}

function contains(needle: string, label = ""): Check {
  return {
    name: `bytes:${label || needle.slice(0, 24)}`,
    run: (cap) => ({
      pass: cap.toString("latin1").includes(needle),
      detail: cap.toString("latin1").includes(needle) ? "found" : "MISSING",
    }),
  };
}

function absent(needle: string, label: string): Check {
  return {
    name: `absent:${label}`,
    run: (cap) => {
      const n = count(cap.toString("latin1"), needle);
      return { pass: n === 0, detail: n === 0 ? "zero occurrences" : `${n} occurrences of ${JSON.stringify(needle)}` };
    },
  };
}

function decModePairOnce(): Check[] {
  return [
    {
      name: "modes:?2004h once",
      run: (c) => {
        const n = count(c.toString("latin1"), "\x1b[?2004h");
        return { pass: n === 1, detail: `?2004h count=${n}` };
      },
    },
    {
      name: "modes:?2004l once",
      run: (c) => {
        const n = count(c.toString("latin1"), "\x1b[?2004l");
        return { pass: n === 1, detail: `?2004l count=${n}` };
      },
    },
  ];
}

function cursorPairedTeardownShow(): Check {
  return {
    name: "modes:?25l/?25h paired (+teardown show)",
    run: (c) => {
      const cap = c.toString("latin1");
      const l = count(cap, "\x1b[?25l");
      const h = count(cap, "\x1b[?25h");
      const endsShown = cap.lastIndexOf("\x1b[?25h") > cap.lastIndexOf("\x1b[?25l");
      // §10 step 6 ends teardown with an UNCONDITIONAL showCursor: exactly one
      // more show than hide, final state visible. That +1 is by design.
      return { pass: h === l + 1 && endsShown, detail: `hide=${l} show=${h} endsShown=${endsShown}` };
    },
  };
}

const PROMPT = "(stub/stub-model)>";
const BANNER = "interactive mode";

function baseScript(answerStep: Step[]): Step[] {
  return [
    // The wrapper echoes hotdog's pid; capture it for the SIGTERM scenario.
    { op: "expect", needle: "@@HD_PID ", timeout: 20, capture_pid: true },
    { op: "expect", needle: BANNER, timeout: 45 },
    { op: "expect", needle: PROMPT, timeout: 30 },
    ...answerStep,
    { op: "expect", needle: "@@STTY_END@@", timeout: 15 },
  ];
}

function baseScriptShortBanner(answerStep: Step[]): Step[] {
  // 20-col PTY: "interactive mode" soft-wraps across rows; the version head
  // stays contiguous. Same script shape, banner needle wrap-proof.
  return [
    { op: "expect", needle: "@@HD_PID ", timeout: 20, capture_pid: true },
    { op: "expect", needle: "hotdog 0.13.0", timeout: 45 },
    { op: "expect", needle: PROMPT, timeout: 30 },
    ...answerStep,
    { op: "expect", needle: "@@STTY_END@@", timeout: 15 },
  ];
}

function scenarios(): Scenario[] {
  const splitEnv = { knob: "split" as const, term: "xterm-256color", noColor: "1" };
  return [
    {
      id: "A-happy-split",
      kind: "gate",
      ...splitEnv,
      cols: 80,
      rows: 24,
      script: baseScript([
        { op: "termios_probe" }, // raw mode physically ON mid-session (R1)
        { op: "send", data: "hello stub world\r" },
        { op: "expect", needle: STUB_ANSWER_NEEDLE, timeout: 30 },
        { op: "send", data: "/quit\r" },
        { op: "expect", needle: "@@HD_EXIT 0@@", timeout: 20 },
      ]),
      checks: [
        ...decModePairOnce(),
        { name: "modes:?2026 balanced", run: (c) => syncBalanced(c.toString("latin1")) },
        cursorPairedTeardownShow(),
        contains("hello stub world", "submitted echo row"),
        contains("Goodbye", "goodbye after teardown"),
        {
          name: "stty: raw OFF + echo ON after exit (orphan-proof, same pty)",
          run: (c) => sttyRestored(between(c.toString("latin1"), "@@STTY_DUMP@@", "@@STTY_END@@")),
        },
        {
          name: "termios: raw ON mid-session (bracketed-paste window physically taken over)",
          run: (_c, probes) => {
            const p = probes[0];
            return p
              ? { pass: !p.echo && !p.icanon, detail: `mid-session echo=${p.echo} icanon=${p.icanon}` }
              : { pass: false, detail: "no termios probe recorded" };
          },
        },
        {
          name: "order: Goodbye after the ?2004l disable",
          run: (c) => {
            const cap = c.toString("latin1");
            const ok = cap.lastIndexOf("\x1b[?2004l") < cap.indexOf("Goodbye");
            return { pass: ok, detail: ok ? "teardown precedes goodbye bytes" : "goodbye printed before/without the disable" };
          },
        },
      ],
    },
    {
      id: "B-sigterm-split",
      kind: "gate",
      ...splitEnv,
      cols: 80,
      rows: 24,
      script: baseScript([
        { op: "sleep", secs: 0.6 },
        { op: "signal", sig: 15, from_captured_pid: true },
        { op: "expect", needle: "@@HD_EXIT 143@@", timeout: 20 },
      ]),
      checks: [
        ...decModePairOnce(),
        { name: "modes:?2026 balanced", run: (c) => syncBalanced(c.toString("latin1")) },
        cursorPairedTeardownShow(),
        {
          name: "stty: raw OFF + echo ON after SIGTERM (orphan-proof, same pty)",
          run: (c) => sttyRestored(between(c.toString("latin1"), "@@STTY_DUMP@@", "@@STTY_END@@")),
        },
      ],
    },
    {
      id: "C-dumb-split-knob",
      kind: "gate",
      knob: "split",
      term: "dumb",
      noColor: "1",
      cols: 80,
      rows: 24,
      script: baseScript([
        { op: "send", data: "hello dumb tty\r" },
        { op: "expect", needle: STUB_ANSWER_NEEDLE, timeout: 30 },
        { op: "send", data: "/quit\r" },
        { op: "expect", needle: "@@HD_EXIT 0@@", timeout: 20 },
      ]),
      checks: [
        absent("\x1b[?2026", "synchronized output (renderer-only mode)"),
        absent("\x1b[?25l", "cursor hide (renderer-only in this CLI)"),
        {
          name: "modes:?2004 at most the legacy clipboard pair (no renderer enable)",
          run: (c) => {
            const cap = c.toString("latin1");
            const h = count(cap, "\x1b[?2004h");
            const l = count(cap, "\x1b[?2004l");
            return { pass: h <= 1 && l <= 1, detail: `?2004h=${h} ?2004l=${l} (legacy clipboard-paste may emit one pair)` };
          },
        },
        contains(STUB_ANSWER_NEEDLE, "legacy round-trip answer"),
        contains("hello dumb tty", "legacy echo"),
        {
          name: "stty: raw OFF + echo ON after quit on the legacy path",
          run: (c) => sttyRestored(between(c.toString("latin1"), "@@STTY_DUMP@@", "@@STTY_END@@")),
        },
      ],
    },
    {
      id: "C2-legacy-baseline",
      kind: "gate",
      knob: "legacy",
      term: "dumb",
      noColor: "1",
      cols: 80,
      rows: 24,
      script: scenarios0LegacyScript(),
      checks: [
        absent("\x1b[?2026", "synchronized output"),
        contains(STUB_ANSWER_NEEDLE, "legacy round-trip answer"),
      ],
    },
    {
      id: "D-narrow-nocolor-split",
      kind: "gate",
      ...splitEnv,
      cols: 20,
      rows: 12,
      script: baseScriptShortBanner([
        { op: "termios_probe" },
        // 36 chars over a 20-col terminal: soft-wrapped editor block ending
        // at the pending-wrap margin -- the P1b shape on a REAL terminal
        // (residual R3). Every emitted CHP must stay in range (the 3c clamp).
        { op: "send", data: "abcdefghijklmnopqrstuvwxyz0123456789\r" },
        { op: "expect", needle: STUB_ANSWER_NEEDLE, timeout: 30 },
        { op: "send", data: "/quit\r" },
        { op: "expect", needle: "@@HD_EXIT 0@@", timeout: 20 },
      ]),
      checks: [
        { name: "modes:?2004h once (NO_COLOR still mounts)", run: (c) => {
          const n = count(c.toString("latin1"), "\x1b[?2004h");
          return { pass: n === 1, detail: `?2004h count=${n}` };
        } },
        {
          name: "clamp: every ESC[nG lands within 20 cols",
          run: (c) => {
            const cap = c.toString("latin1");
            const bad: string[] = [];
            const re = /\x1b\[(\d+)G/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(cap)) !== null) {
              const n = Number(m[1]);
              if (n > 20) bad.push(`ESC[${m[1]}G`);
            }
            return { pass: bad.length === 0, detail: bad.length === 0 ? "all CHP <= 20" : `overshoot: ${bad.slice(0, 5).join(" ")}` };
          },
        },
        {
          name: "NO_COLOR: no SGR color-set bytes (teardown reset allowed)",
          run: (c) => {
            const cap = c.toString("latin1");
            const re = /\x1b\[[0-9;]*3[0-7]m/g;
            const bad = cap.match(re) ?? [];
            return { pass: bad.length === 0, detail: bad.length === 0 ? "zero color SGR sets" : `stray color SGR: ${bad.slice(0, 5).join(" ")}` };
          },
        },
        { name: "modes:?2026 balanced", run: (c) => syncBalanced(c.toString("latin1")) },
        {
          name: "stty: raw OFF + echo ON after exit",
          run: (c) => sttyRestored(between(c.toString("latin1"), "@@STTY_DUMP@@", "@@STTY_END@@")),
        },
      ],
    },
    // ── evidence runs (deliverable 2: question-echo renderings) ────────────
    ...questionEvidence(),
  ];
}

function scenarios0LegacyScript(): Step[] {
  return baseScript([
    { op: "send", data: "hello dumb tty\r" },
    { op: "expect", needle: STUB_ANSWER_NEEDLE, timeout: 30 },
    { op: "send", data: "/quit\r" },
    { op: "expect", needle: "@@HD_EXIT 0@@", timeout: 20 },
  ]);
}

function questionEvidence(): Scenario[] {
  const mk = (path: "legacy" | "split", shape: string, tail: Step[]): Scenario => ({
    id: `Q-${path}-${shape}`,
    kind: "evidence",
    knob: path,
    term: "xterm-256color",
    noColor: "1",
    cols: 80,
    rows: 24,
    script: baseScript([
      { op: "send", data: `please ${STUB_TOOL_MARKER} me\r` },
      { op: "expect", needle: "? Pick a flavor", timeout: 30 },
      ...tail,
      { op: "expect", needle: "@@HD_EXIT ", timeout: 20 },
    ]),
    checks: [
      contains("? Pick a flavor", "question prompt on the wire"),
      ...(shape === "cancel"
        ? [
            contains("Interrupted", "interrupt notice"),
            {
              name: "cancel: post-cancel line reaches the normal handler (Q-CANCEL-1 gate)",
              run: (c: Buffer) => {
                const cap = c.toString("latin1");
                const note = cap.indexOf("Interrupted");
                const round = cap.indexOf(STUB_ANSWER_NEEDLE, note >= 0 ? note : 0);
                return {
                  pass: note >= 0 && round >= 0,
                  detail:
                    note < 0
                      ? "no interrupt notice on the wire"
                      : round < 0
                        ? "post-cancel line swallowed by the dead question (Q-CANCEL-1 regression)"
                        : "post-cancel line reached the normal handler",
                };
              },
            },
          ]
        : [contains("STUB_FINAL", "answer round-tripped through the stub")]),
    ],
  });
  return [
    mk("legacy", "answer", [{ op: "send", data: "vanilla\r" }, { op: "expect", needle: "STUB_FINAL vanilla", timeout: 30 }, { op: "send", data: "/quit\r" }]),
    mk("legacy", "blank", [{ op: "send", data: "\r" }, { op: "expect", needle: "STUB_FINAL blank", timeout: 30 }, { op: "send", data: "/quit\r" }]),
    mk("legacy", "cancel", [
      // Half-typed answer, then the interrupt: what the reader sees of a
      // cancelled question is the interesting shape.
      { op: "send", data: "sw" },
      { op: "sleep", secs: 0.3 },
      { op: "send", data: "\x03" },
      { op: "expect", needle: "Interrupted", timeout: 30 },
      { op: "sleep", secs: 1.0 },
      // Release proof: a fresh ordinary message must round-trip through the
      // stub. If the dead question still owns the input it is swallowed as
      // an answer and no STUB_ANSWER ever comes (Q-CANCEL-1).
      { op: "send", data: "ping after cancel\r" },
      { op: "expect", needle: STUB_ANSWER_NEEDLE, timeout: 30 },
      { op: "send", data: "/quit\r" },
    ]),
    mk("split", "answer", [{ op: "send", data: "vanilla\r" }, { op: "expect", needle: "STUB_FINAL vanilla", timeout: 30 }, { op: "send", data: "/quit\r" }]),
    mk("split", "blank", [{ op: "send", data: "\r" }, { op: "expect", needle: "STUB_FINAL blank", timeout: 30 }, { op: "send", data: "/quit\r" }]),
    mk("split", "cancel", [
      // Half-typed answer, then the interrupt (legacy twin above).
      { op: "send", data: "sw" },
      { op: "sleep", secs: 0.3 },
      { op: "send", data: "\x03" },
      { op: "expect", needle: "Interrupted", timeout: 30 },
      { op: "sleep", secs: 1.0 },
      // Release proof (see the legacy twin above).
      { op: "send", data: "ping after cancel\r" },
      { op: "expect", needle: STUB_ANSWER_NEEDLE, timeout: 30 },
      { op: "send", data: "/quit\r" },
    ]),
  ];
}

// ── run loop ────────────────────────────────────────────────────────────────

interface RunRecord {
  run_id: string;
  series: string;
  scenario: string;
  kind: string;
  loop: number;
  pass: boolean;
  duration_ms: number;
  child_exit: number | null;
  checks: { name: string; pass: boolean; detail: string }[];
  raw_bytes: number;
  raw_file: string;
}

// The pty child wrapper: hotdog as a background job (its pid is echoed for
// the SIGTERM scenario), then -- once hotdog is gone -- stty -a runs in the
// SAME pty before anything else can touch it: the orphaned-terminal proof.
function wrapperScript(hotdogArgs: string[]): string {
  const quoted = hotdogArgs.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  return [
    `echo "@@WRAP_START@@"`,
    // < /dev/tty: with job control OFF bash redirects backgrounded commands'
    // stdin from /dev/null, and hotdog's interactive default needs a TTY.
    // The child shares bash's pgroup (the pty foreground), so tty reads are
    // SIGTTIN-free.
    `${quoted} < /dev/tty & HD=$!`,
    `echo "@@HD_PID $HD@@"`,
    `wait $HD`,
    `echo "@@HD_EXIT $?@@"`,
    `echo "@@STTY_DUMP@@"`,
    `stty -a 2>&1`,
    `echo "@@STTY_END@@"`,
  ].join("; ");
}

async function main(): Promise<void> {
  const loopsIdx = process.argv.indexOf("--loops");
  const loops = loopsIdx > 0 ? Number(process.argv[loopsIdx + 1]) : 3;
  if (!Number.isInteger(loops) || loops < 1) throw new Error("--loops must be an integer >= 1");

  const stamp = resultsDirName(SERIES, new Date());
  const root = join(REPO, "pty-tests", "results", stamp);
  mkdirSync(root, { recursive: true });
  const runsFile = join(root, "runs.jsonl");

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (!req.url.includes("/chat/completions")) {
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }
      const raw = await req.text();
      return new Response(stubBody(raw), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  console.log(`stub OpenAI server: ${baseUrl}  loops=${loops}`);

  const records: RunRecord[] = [];
  for (const sc of scenarios()) {
    for (let loop = 1; loop <= loops; loop++) {
      const runId = `${sc.id}-loop${loop}`;
      const dir = join(root, runId);
      const home = join(dir, "home");
      const cfg = join(dir, "config");
      const ws = join(dir, "workspace");
      for (const d of [home, cfg, ws, join(dir, "sessions"), join(dir, "data")]) mkdirSync(d, { recursive: true });
      writeFileSync(join(cfg, "defaults.json"), JSON.stringify({
        default_model: "stub/stub-model",
        providers: [{ name: "stub", url: baseUrl, apiKey: "stub-key", defaultModel: "stub-model" }],
        uiInteractiveCli: { renderer: sc.knob },
        log_target: "none",
      }, null, 2));

      const specPath = join(dir, "spec.json");
      writeFileSync(specPath, JSON.stringify({
        cmd: ["/bin/bash", "-c", wrapperScript([BUN, join(REPO, "bin", "hotdog")])],
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: home,
          TERM: sc.term,
          NO_COLOR: sc.noColor,
          HOTDOG_CONFIG_DIR: cfg,
          HOTDOG_SESSIONS_DIR: join(dir, "sessions"),
          HOTDOG_DATA_DIR: join(dir, "data"),
          HOTDOG_LOG_TARGET: "none",
          HOTDOG_LOG_LEVEL: "error",
        },
        cwd: ws,
        rows: sc.rows,
        cols: sc.cols,
        capture: join(dir, "capture.raw"),
        status: join(dir, "driver.status.json"),
        probes: join(dir, "termios.probes.jsonl"),
        total_timeout: 180,
        script: sc.script,
      }, null, 2));

      const t0 = Date.now();
      // ASYNC on purpose: the stub server runs on THIS event loop; a
      // spawnSync would deadlock the session's chat request.
      const proc = await Bun.spawn({
        cmd: ["python3", DRIVER, specPath],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PTY3C_QUIET: "1" },
      });
      const driverStderr = proc.stderr ? await new Response(proc.stderr).text() : "";
      await proc.exited;
      const dur = Date.now() - t0;
      const rawPath = join(dir, "capture.raw");
      const cap = existsSync(rawPath) ? Buffer.from(readFileSync(rawPath)) : Buffer.alloc(0);
      const status = existsSync(join(dir, "driver.status.json"))
        ? JSON.parse(readFileSync(join(dir, "driver.status.json"), "utf8")) as { ok: boolean; fail_reason: string | null; child_exit: number | null; ops_done: number; ops_total: number }
        : { ok: false, fail_reason: `driver produced no status (exit ${proc.exitCode}): ${driverStderr.slice(0, 300)}`, child_exit: null, ops_done: 0, ops_total: 0 };
      const probes: Probe[] = existsSync(join(dir, "termios.probes.jsonl"))
        ? readFileSync(join(dir, "termios.probes.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Probe)
        : [];

      const checks: RunRecord["checks"] = [];
      for (const chk of sc.checks) {
        try {
          const r = chk.run(cap, probes);
          checks.push({ name: chk.name, pass: r.pass, detail: r.detail });
        } catch (e) {
          checks.push({ name: chk.name, pass: false, detail: `check threw: ${String(e)}` });
        }
      }
      const pass = status.ok && status.ops_done === status.ops_total && checks.every((c) => c.pass);
      if (sc.kind === "evidence") {
        await Bun.spawn({ cmd: [BUN, RENDERER, rawPath, String(sc.rows), String(sc.cols), join(dir, "grid-replay.txt")] , stdout: "ignore", stderr: "ignore"}).exited;
      }
      const rec: RunRecord = {
        run_id: runId, series: SERIES, scenario: sc.id, kind: sc.kind, loop,
        pass, duration_ms: dur, child_exit: status.child_exit, checks,
        raw_bytes: cap.length, raw_file: join(runId, "capture.raw"),
      };
      records.push(rec);
      appendFileSync(runsFile, JSON.stringify(rec) + "\n");
      const why = checks.filter((c) => !c.pass).map((c) => `${c.name} (${c.detail})`);
      const drv = status.ok ? "" : ` DRIVER: ${status.fail_reason} ops ${status.ops_done}/${status.ops_total}`;
      console.log(`[${pass ? "PASS" : "FAIL"}] ${runId} (${(dur / 1000).toFixed(1)}s)${drv}${why.length ? " -> " + why.join("; ") : ""}`);
    }
  }
  server.stop();

  // The dumb-gate parity gate (see legacyParity): folds into the exit code.
  const parity = legacyParity(root, loops);
  console.log(`[${parity.pass ? "PASS" : "FAIL"}] C-vs-C2 wire parity (knob=split+TERM=dumb == legacy)`);
  console.log(`  ${parity.detail}`);

  const byScenario = new Map<string, RunRecord[]>();
  for (const r of records) byScenario.set(r.scenario, [...(byScenario.get(r.scenario) ?? []), r]);
  const table = [...byScenario.entries()].map(([id, rs]) => ({
    scenario: id,
    kind: rs[0]?.kind ?? "",
    passes: rs.map((r) => r.pass),
    flake: rs.some((r) => r.pass) && rs.some((r) => !r.pass),
    all_pass: rs.every((r) => r.pass),
  }));
  writeFileSync(join(root, "summary.json"), JSON.stringify({
    series: SERIES,
    created_at: new Date().toISOString(),
    loops,
    rows: records.length,
    passed: records.filter((r) => r.pass).length,
    flaky: table.filter((t) => t.flake).map((t) => t.scenario),
    legacy_parity: parity,
    table,
    records,
  }, null, 2));
  console.log(`\nsummary: ${join(root, "summary.json")}`);
  for (const t of table) console.log(`${t.all_pass ? "PASS" : t.flake ? "FLAKE" : "FAIL"} ${t.scenario} ${t.passes.map((p) => (p ? "." : "x")).join("")}`);
  process.exit(table.every((t) => t.all_pass) && parity.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(`pty-suite failed: ${String(e)}`);
  process.exit(2);
});
