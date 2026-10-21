# pty-renderer-3c -- scripted PTY test lane for the split renderer

Real-terminal ground truth for the split-renderer work: stage 3c (the §9
TERM=dumb gate, the console arbiter routing, the placeCursor col clamp) and
stage 4 (the status line and queue chip ride the same scenarios). The unit
lane (§11) bans PTYs from `bun test`; this lane owns exactly that evidence,
host-only, driven against a canned OpenAI-compatible stub so everything is
deterministic and free.

**It never runs under `bun run test`.** Deliberately a separate lane, not a
scheduling accident: the unit suite keeps its ~10s budget and this lane needs
a host dep (python3 pty). bunfig.toml `pathIgnorePatterns` covers
`pty-tests/**`, no file here matches the test-file pattern, and the runner is
a plain script with its own results convention.

## One command

```sh
bun run test:pty                       # default loops=3
bun pty-tests/pty-renderer-3c/run-pty-suite.ts --loops N
```

Exit 0 only when every scenario passed every loop. Each loop of each
scenario gets a directory under `pty-tests/results/pty-renderer-3c-<stamp>/`
with `capture.raw` (every PTY master byte), `driver.status.json`,
`termios.probes.jsonl`, the isolated `config/` + `home/` + `sessions/` +
`data/`, and (evidence runs) `grid-replay.txt`. `runs.jsonl` +
`summary.json` keep the evals-track naming convention -- the `series` field
and sweep timestamps are stable correlation keys, and every sweep predating
the move was carried into this results directory under its original name.

## How it works

- **Stub server** (`run-pty-suite.ts` in-process `bun.serve`): canned
  chat-completions SSE. Echoes a fixed answer; returns a `question` tool
  call when the prompt contains `ASKFRUIT`; echoes the answer shape back
  (`STUB_FINAL vanilla|blank`) once the request TAIL is the tool result.
  The branch is tail-relative on purpose: after a cancelled question the
  history permanently holds a tool result (and the ASKFRUIT row), so
  history-membership tests would hijack every later turn.
- **Isolation**: per-run `HOTDOG_CONFIG_DIR` (docs/config-reference.md
  priority 2) with `providers[0].url` at the stub port, plus
  `HOTDOG_SESSIONS_DIR` / `HOTDOG_DATA_DIR` / `HOME` inside the run dir.
  Nothing touches the user config or cache.
- **PTY**: `pty_driver.py` (python stdlib) forks the session onto a real
  pty with a declared winsize, runs the expect-script, and probes the line
  discipline from the master fd (it mirrors the slave state hotdog owns).
  The wrapper shell runs hotdog as a background job (so its pid can be
  signalled), then -- after hotdog is gone and before any other program can
  touch the tty -- runs `stty -a` in the SAME pty: the orphaned-terminal
  proof.

## Scenarios (gate)

| id | proves |
|----|--------|
| A-happy-split | mount: ?2004h once, ?2026 balanced (prefix property), ?25l/?25h paired + the by-design teardown show, submitted echo, stage-4 status row on the wire (`· working` painted, `#1` after the turn), `Goodbye` AFTER the ?2004l, mid-session termios probe shows raw physically ON, post-exit `stty` shows icanon+echo ON |
| B-sigterm-split | SIGTERM teardown: same mode accounting completes once, terminal restored (stty), exit 143 |
| C-dumb-split-knob | knob=split + TERM=dumb on a REAL tty: zero ?2026, zero ?25l, ?2004 at most the legacy clipboard-paste pair; the session still round-trips on the legacy path; stty restored |
| C2-legacy-baseline | knob=legacy TERM=dumb baseline: same round trip, zero ?2026 (parity control for C) |
| C-vs-C2 parity | the dumb decline's promise in machine form: the ESC/control multiset of every C capture is IDENTICAL to its C2 twin (no cursor addressing, mode byte, or control beyond what legacy itself emits; printable text differs only by session id/pid -- deliberately out of scope) |
| D-narrow-nocolor-split | 20x12 pty: NO_COLOR still mounts (R4), every emitted `ESC[nG` lands within 20 cols (the R3/pending-wrap clamp on real bytes), balanced ?2026, clean stty |

Console-arbiter routing (debug/info/trace) is NOT wire-checked here: no
scriptable in-session code path calls console.* during a mounted turn --
that routing is pinned in the unit lane by the real-process probes
(`tests/fixtures/split-mount-probe.ts`). The dumb-full-session parity (R2)
is covered by C + C2; raw-ioctl takeover (R1) by A's mid-session probe +
post-exit stty.

## Evidence runs (question-echo)

`Q-{legacy,split}-{answer,blank,cancel}` trigger a held question through
the stub's `question` tool call and capture the raw scrollback of
(i) a typed answer, (ii) a blank Enter, (iii) a Ctrl-C interrupt.
`render-trace.ts` replays a capture through the repo's Grid model
(`src/utils/cli/renderer/grid.ts` -- the documented test-double terminal
for exactly this sequence subset) to show the rows a reader saw; the raw
captures remain the primary evidence.

Shapes pinned by the fix-3 ruling (split path): answers commit
self-describing, `? Pick a flavor > vanilla`, and a blank Enter commits
`? Pick a flavor > (no answer)` -- never silent, never a bare row.

The cancel scenarios are the **Q-CANCEL-1 regression gate**. The bug (fixed
in src): both held-prompt tools read the per-iteration `runAbortController`
-- null while tools run -- so `collectAnswers` never got an abortable
signal and the dead question ate the next line after Ctrl-C. The seam is
now the run-lifetime `abortSignal` the executor wires onto the tool
context. Each cancel script proves release behaviorally: after the
`Interrupted` notice it sends a fresh ordinary message that MUST round-trip
the stub (`STUB_ANSWER_7734`); if a dead question still owns the input the
expect times out and the scenario fails with "swallowed by the dead
question". Negative control verified when the gate landed: reverting the
seam fails both cancel scenarios.

## Re-running

Same command, any N. Traces are kept per run; diff `capture.raw` across
runs to eyeball determinism.
