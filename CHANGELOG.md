# Changelog

## Unreleased

- **webui - streaming tool-call previews now ship increments instead of re-sending the whole partial.** While a tool call is still being written out, each preview frame carries just the new argument bytes instead of the entire partial again, so web traffic for tool streams drops proportionally (a 50-delta two-call stream: ~66.5 KB becomes ~16 KB unbatched); the committed tool-call frame still carries the complete args, and older clients keep the old frame shape untouched.

- **webui - stream batching cuts streaming frame traffic behind `webui.streamBatchMs` (default 100ms, 0 = off).** The first frame of a burst ships immediately; later text/reasoning chunks concatenate and tool-call partials collapse latest-wins within the window, so a 500-token answer costs a handful of frames instead of 500. Any other frame flushes the buffer before itself, so per-session ordering is strict and worst-case added latency is one window; the knob is read per frame, a settings edit applies with no restart.

- **compaction - the overflow rescue bills the provider's real number as a floor.** The prompt size the provider billed on the last accepted request (cached included) rides the live context as a watermark, so triggers, plausibility gates, and re-aim targets are measured against what the provider actually sees -- system prompt, tool schemas, tokenizer density, image billing -- instead of the local chars/4 estimate alone. Any shrink, rewrite, or non-prefix edit of the context drops the watermark back to the local estimate; with no anchor the behavior is unchanged.

- **compaction - compaction survives restarts.** Every successful reduction now checkpoints the durable session log (marker + the live post-compaction context, written atomically; summary-less rescues get an honest mechanical line), and resume replays from the last checkpoint instead of the whole log -- a restarted session no longer re-inflates history the live session had already compacted. Landing tip: existing logs carry no marker yet, so run `/compact` once in long sessions right after upgrading to stamp the first checkpoint.

- **webui - cold-log pages ship image stubs, fetched lazily, instead of inline base64.** History pages (browse, older pages, reconnect replay) attest each omitted image by type and size in a placeholder box, and the pixels come back one fetch per box when it scrolls into view; over-cap images answer with an honest note. Live frames and freshly streamed images stay inline, so a new image never pays a round trip.

- **compaction - the overflow rescue gets a hysteresis band, a fractional re-aim ladder, and an anti-hallucination placeholder.** Follow-up batch 2026-11-18 on yesterday's image-payload seam, adopting the two top survey findings (run adhoc-20261118-image-compaction-survey: opencode `model-request.ts` boundImages trigger/target hysteresis + `compaction.ts` SHRINK_STEPS + the "do not make claims from memory" placeholder idiom). (1) HYSTERESIS + CACHE STABILITY: the rescue's AIM now sits meaningfully below the trigger -- `REAIM_SHRINK_STEPS[0] = 0.85` of the billed budget (contextLimit - reserveTokens); a rescue landing at/below 85% cannot refire until real new weight crosses the trigger again (the band is the refire margin: ~37k tokens on the victim's 245,760 window), and the image downgrade is now MONOTONIC -- a message already carrying the placeholder is returned byte-identical by `downgradeOlderImages` (frozen), so cuts only ever advance forward through the transcript and every already-placeholdered message keeps its exact bytes across rescues: the provider's prompt-cache prefix survives instead of being busted at every stale payload on every rescue (the known ceiling this buys: a payload kept by an earlier partial downgrade of a multi-image message is never squeezed later -- cache stability wins). (2) FRACTIONAL RE-AIM: one retry-then-surface becomes an episode -- a WeakMap on the agent tracks the FIRST rejected request's size across rejections; when the provider STILL refuses what the rescue re-issued, the next attempts aim at `[0.85, 0.7, 0.5, 0.35]` of the first rejected size (initial rescue aims 0.85 x budget -- the band; re-aims aim the ladder fractions of what the provider demonstrably refused, since its acceptance ceiling is unknowable from here), hard cap 3 re-aims after the initial rescue, then an honest stop notice. The MONOTONICITY LAW: every aim is clamped strictly below the size just rejected and the retry gate now requires a strict WEIGHT reduction against it -- an identical (or heavier) re-issue never happens again (incident #2 of the day: identical retries 400-looped the session; `reduced` also tightens the old bare-length OR: FEWER messages only re-issue at NON-INCREASED measured weight -- increased weight never re-issues, the estimator-blind empty-message-drop stays issuable at parity by construction). A reduction attempt that cannot reach below the last rejected size reports honestly and stops -- and a strategy rewrite that is not actually a smaller request (the pre-batch shape: a one-message pop outweighed by the appended notice/guard) is now ROLLED BACK byte-for-byte with its baton stash dropped and a "the context was left unchanged" notice, instead of silently keeping a phantom compaction and mislabelling it "nothing eligible to compact". Mid-episode entries (rejections 2..N) face a DISCRIMINATOR, never the first-entry gate nor a blanket bypass: the ladder acts only on a context-class rejection signature (4xx status or the `context_length_exceeded` code) or a context our own image-aware estimate still puts over budget -- so a transient gateway 5xx merely QUOTING an overflow phrase (the morning-incident body) landing between two genuine rejections surfaces UNTOUCHED: zero context mutation, zero notices, zero rungs burned, and the episode stays alive for the next real 4xx. The gate re-arms when a request is accepted (provider:response clears the episode). Rungs are counted in RE-ISSUED sends: an entry that re-issues nothing burns nothing, so the cap is honestly "initial rescue + 3 re-aims" of actual traffic. If something outside the seam shrinks the context below what we last issued (manual /compact), the ladder restarts against the new size. The message chain (baton/trim/drop) runs against the AIM via the same reserveTokens knob the strategies already bill (`window - aim` as a runtime settings view -- zero new config keys). (3) PLACEHOLDER: `[image omitted by compaction]` becomes one anti-hallucination line -- removed, do not describe or make claims about contents from memory, re-attach the image or re-read its saved on-disk path IF THE TOOL RECORDED ONE (the hedge matters: inline pasted base64 never touches disk, and an unqualified path pointer would be the confabulation-bait the copy exists to kill; every stripped payload pays ~50 tokens in every later request, and the prevention is the point). Tests: new incident-free suite pins (a) a rescue lands <= target and the same context plus an append past the target but under the trigger does NOT refire; (b) growth past the trigger fires again and downgrades only images past the previous cut line; (c) already-placeholder messages byte-stable across rescues (identical serialization -- cache-prefix proof) + never double-noticed; the rejection loop converges through 4 strictly-smaller issues and stops at the cap with an honest notice; a no-eligible transcript stops after the first refusal; a quoting-overflow 5xx MID-episode surfaces untouched (byte-identical context, zero notices, episode survives for the next 4xx); a rewrite that is not a smaller request is rolled back byte-for-byte with an honest "left unchanged" notice; accepted response clears the episode and re-arms the gate; placeholder wording contract incl. the recorded-path hedge. One existing pin updated where the band legitimately deepened the pop (0.85 x 700-window keeps 5, was 7). Gates: `tsc --noEmit` clean; compaction+provider-error neighborhood 302 pass / 0 fail; full `bun test` 11,596 ran / 0 fail. Zero deps, zero wire, zero config, no core changes. Open: the 0.85/0.7/0.5/0.35 fractions are opencode's, adopted unchanged -- a provider with known headroom could use a shallower ladder later (not a knob today).

- **webui - one named view state, honest chrome, and the envelope's quiet retirement.** Owner batches 2026-11-18 (viewstate-polish + finish runs). (1) View state: attached/peeking/observing as the ONE session-view atom; search hits never attach (live hits peek read-only with an explicit Take over, exactly one attach per claim); the composer's capability is a pure function of the state (composerLocked deleted); paginate-to-match seeks with structural termination and an honest unreachable note. (2) Subagent honesty: a failed worker-row attach renders the fallback card (View log / Close), never a raw bubble or another session's transcript; additive authOk.version + a dismissible client/daemon build-skew banner. (3) META envelope: the raw "META:" line leaves every chat surface (live wire, replay, cold log view, manager handoff); the facts ride the frame structured and render as one muted curated strip under the block (exit code tinted, read window spoken once, honest omission) with the full envelope behind an aria-expanded disclosure; long user prompts fold at 4 lines with expand-on-hit. (4) Chrome: read-only chip controls are real focusable buttons with the house focus grammar; removed-key copy speaks plain user text on every surface; the secret row lays out as badge + one-unit REPLACE pair; RECENT LOGS gains Today/Yesterday/day sections with the pinned block grouped above; foot bars never wrap (container-query collapse tiers, Save always reachable), the composer band degrades by whole segments. Gates: tsc + check clean; full suite 11,584 pass / 0 fail parallel AND sequential; app.test.tsx x3 identical; zero deps, zero mock.module.

- **webui - the Subagents sidebar survives its own selection: the parent's list stays while a worker is viewed, and a cold subagent row gets the house selected mark.** Owner report 2026-11-18, two field defects surfacing with the view-state batch. (1) Selecting a LIVE subagent (its transcript attaching via B4's switchSession) made the parent card's collapsible Subagents list disappear entirely -- the attach burst ends with the socket's task-list snapshot scoped to the ATTACHED session (`agent-sessions.ts sendTaskSnapshot`), and every task row carries the MANAGER's id, so the worker attach ships an empty one and `chat.ts`'s wholesale taskList replace deleted the board: the very menu that hops between siblings, hidden the moment a child was picked. Fix: while the named view state says `workerView`, a taskList frame cannot re-attest the manager's board and is ignored (the board stands as last attested; every non-worker attach replaces exactly as before; attached/peeking/observing semantics untouched). Known ceiling (not fixed): a page-load whose reconnect identity IS a worker never saw the manager's board on this socket. (2) Selecting a COLD (settled/cold-log) subagent left next to no mark on its row -- the Subagents sections keyed their highlight on `activeSessionId` only, while an observed worker log names the pane through `activeLogId`. Sidebar now passes the pane's subject (`activeLogId ?? activeSessionId`) into both sections: the cold row carries the same `.active` + `aria-current="true"` treatment the live rows use (parity-pinned, no bespoke weaker idiom). Tests: app-level red->green (the worker attach's scoped `taskList []` keeps the section, its rows and the viewed row's mark; a plain attach still re-attests wholesale), chat-level (the guard rides `workerView` only), sidebar-level (live-view survival + cold/live selection parity); eight ordered suite fires resequenced to the daemon's honest frame order (a manager-scoped snapshot only ever ships while the manager owns the pane). Gates: `tsc --noEmit` clean; full `bun test` 11,565 pass / 0 fail; `bun test --parallel` three consecutive runs green. Zero wire, zero server, zero config changes.

- **compaction - the estimator, the rescue, and the ctx gauge finally see image payloads.** Owner report 2026-11-18 (webui, manager session 9acafaaf, ~12:20-13:35 local): EVERY message landed "Context overflow: compacted the conversation and retrying the request once." followed by `HTTP 400 ... prompt exceeds the 262144-token context ... context_length_exceeded` while the footer gauge read 67k/262k; a daemon restart made it worse. Durable-log ground truth (1,147 entries, 9.9 MB): ~7.9 MB is base64 images -- 26 agent_browser PNG payloads on tool-result messages + 2 user-pasted screenshots, sizes [257512..838348] chars each -- against ~550 KB of conversation text; the last usage record reads `promptTokens 136 + cachedTokens 66,433` (the 67k gauge: this provider's reported input EXCLUDES image billing). Root cause: `estimateContextTokens` (chars/4 over `contentToText`, which drops image parts) and the provider second opinion were both image-blind, so (1) the auto trigger never fired, (2) the morning's plausibility gate WRONGLY refused the real overflow on both sources, and where the chain did run (baton/trim/drop) it removed text-small messages whose bytes were nothing -- the notice fired, the retry re-400'd; resume replay re-inflates through persisted INPUT images (TOOL_RESULT images persist display-only and are deliberately never replayed) onto a regenerated ~404 KB system prompt, landing right back over the limit from the first resumed turn. Fix: (1) `@utils/token-estimate` weights image payloads -- `Message.images` and inline `data:` image_url parts bill `min(ceil(base64/4), 4096)` tokens/image: measured vision encoders charge ~10^3 tokens per image regardless of payload bytes (OpenAI <=1,105, Anthropic ~1,600, llama.cpp Qwen-VL grids ~1,500 for 1280x900), and the incident itself proves a ~850/image floor for this provider (text alone provably fit 262,144; ~28 images pushed it over); the chars/4 lens keeps byte-size scaling, the cap bounds gauge inflation, both biases err high; non-`data:` URLs keep the old weightless contract. Consumers follow automatically: `shouldCompact`, every strategy's window math, and the plausibility gate -- a real image overflow now passes the gate on the local estimate even though the provider number sits at 25%, while the morning's quoting-body shape (both sources genuinely under) still refuses. (2) The overflow rescue is aggressive on pixels: when the image-inclusive estimate is over budget it FIRST downgrades every image payload except the newest 2 (`downgradeOlderImages`, placeholder "[image omitted by compaction]" -- the tool-result text keeps the on-disk path so a still-needed screenshot is re-readable), messages and text intact; if the strip alone clears the budget no message-dropping runs, otherwise the baton/trim/drop chain finishes, and the reduction-honesty check now measures context WEIGHT (a byte reduction with the message count unchanged is a real reduction). (3) Resume honesty needs no code: the CONTEXT hook now sees the replayed INPUT images and compacts before the provider is ever asked (pinned). (4) Gauge: the token_usage emit/replay/log record gains `estimatedContextTokens` (image-aware estimate of the full outgoing context incl. system prompt); ctx displays bill `max(reported, estimated)` -- sidebar cache, CLI footer, cold-log footers (`ctxByIndex`), session rows (`deriveCtxFromLog`), and the index mirror. Mixed-source by design where the owner's staged webui batch must not be touched: the live webui frame builder `ctxFromUsage` (staged file) stays provider-based until the owner re-stages and adopts the same one-line max -- reconnect/cold-load sidebars and footers are honest today. Tests: incident reconstructed deterministically (real measured byte sizes, generated fake base64, the verbatim 400 body): (a) text-fits/images-overflow estimate delta pinned to 28x4096; (b) rescue converges <= budget, keeps exactly the 2 newest images, placeholders in place, retry carries the compacted context; strip-insufficient case still converges via the chain; (c) replayed victim-shaped log triggers compaction instead of sending the context; (d) the gate still refuses the quoting-body shape with images present. Zero log-format breakage (new record field omitted when unattested), zero wire changes, zero config. Open unknowns (not fixed): the provider-side image accounting is still a black box (usage may exclude image tokens entirely), and the estimator stays a budget floor, not a billing replica.

- **compaction - the overflow rescue stops lying, and stops firing where it cannot be true.** Owner report 2026-11-18 (webui, manager session 9acafaaf, ~09:22 local): at a 137k/262k footer gauge (~52%) a short owner message landed mid-turn with "Context overflow: compacted the conversation and retrying the request once." -- and nothing was compacted. Durable-log ground truth: the turn's only call recorded `promptTokens: 84` + `cachedTokens: 136,009` (`in = 136,093` = 52% of the 262,144 window, `durationMs 36,660` = failed attempt + rescue + retry), no compaction record anywhere in the log, and a ~full-window prefix-cache hit proving the retried request carried the unchanged context -- the notice claimed work that never happened, and the retry re-issued the identical request. Root cause (one path, two coupled defects): `isContextOverflowError` pattern-matches the whole `LlmError.Api` message, which embeds the response body (`HTTP 5xx (body: ...)`), so any transient 4xx/5xx whose body merely QUOTES an overflow phrase (gateway wraps, upstream echoes) routes into the compact-and-retry chain regardless of size; the chain's only anti-misclassification guards are fit checks that drop lacks (its gate is a message COUNT, so a 235-turn session at 52% sails through and gets cut to `keepRecent`), and any strategy reporting success with nothing removed (trim's orphan-safe boundary rewind can land at zero) emitted "compacted" unconditionally. Fix: (1) a plausibility gate before the chain -- when BOTH the local estimate and the provider's last reported input (`promptTokens + cachedTokens`, the same second opinion the auto trigger adopted in 7345b835) sit under `contextLimit - reserveTokens`, an overflow cannot be true: warn and surface the error untouched (unresolved window keeps the old loud-failure posture); (2) the notice now checks the chain actually reduced the context: a no-op reports "Context overflow: compaction found nothing eligible to compact; surfacing the error." and orders NO retry (re-issuing an unchanged context cannot heal a real overflow); only a real reduction gets the compacted-and-retry notice + `{retry:true}`. Tests (established PROVIDER_ERROR seam, deterministic, no network): the incident's exact error/usage shape (500 quoting "maximum context length", provider input 52%, estimate under budget) must not touch the context, mutate params, or emit any notice; a tool-heavy over-budget transcript where trim's rewind no-ops must get no retry, an intact context, and no notice claiming "compacted". Existing rescue pins unchanged (genuine 100%-of-budget still compacts and retries once). Gates: compaction/retry/agent-provider-error suites 309 pass; `tsc --noEmit` clean; full `bun test` 11,536 pass / 0 fail; replayed against the incident-reconstructed transcript (500 msgs, provider 84/136,009): pre-fix the chain shredded 500 -> 6 behind the notice, post-fix the error surfaces with the context intact. Zero log-format, zero wire, zero config changes. Follow-ups for the owner: provider errors are not persisted to the durable log (no `provider_error` source exists -- the exact 09:22 body can never be forensically confirmed); the notice renders through the existing `S2C.SYSTEM_MESSAGE` path, so no webui change was needed.

- **ci - green again: the stt fake-server poison, the silent coverage floor, two macOS refusal lines, and the sleep-timed flakes.** Fourteen red pushes (since the 1.4.3 pin) resolved at the roots, all test/CI-side, zero shipped-code changes. (1) **`bun test --coverage` exited 1 with "0 fail"**: the stt `bodyfail` case rejected a pull inside a `Bun.serve` response stream, and that server-side rejection surfaces as a process-level error -- deterministic exit 1 under `--coverage`, flaky red in the plain macOS runs. The dying-body case now rides a raw `node:net` listener (headers flushed, 12 of the announced 100 bytes, socket destroyed): same client-side `ECONNRESET`, zero server-side error. (2) **bun's per-file `coverageThreshold` is silent** (exit 1, no message, not even a failed test) -- the floor bit `src/experimental/desktop/launcher.ts` (53.82% lines) when the desktop batch landed after the 1.4.3 pin. New `desktop-launcher-runtime.test.ts` drives the machine-touching rungs with fake-toolchain executables written to disk: compileShim success (fake cc proves the assembled argv, the `-sectcreate` plist's existence AT compile time, the cold-dir `mkdir -p`, and the finally-unlink), compiler-failure and unspawnable-cc nulls, the no-codesign soft path, the shim rung end-to-end (the URL lands on stdin's FIRST line -- the security contract), the cached-binary spawn, the spawn-failure fall-through, `close()` ending a live child, and realProbe's which/exec closures (skipped honestly on hosts with a real browser). launcher.ts lands at 81/95. `lock.ts` follows: unreadable-lock steal/no-op pins and an unwritable-dir soft-fail pin (mode-bit-enforcement probe, same doctrine as the AS_ROOT skips). (3) **macOS `websocket-files` lockbox red**: the chmod-000 readdir refusal asserts a host property the GitHub macOS runner does not have; a same-process readdir probe now says honestly when the refusal cannot exist here (vacuous skip with a note), the honest line stays pinned where modes bite (Linux). (4) **the sleep-timed flakes**: the broker-construction sweep waited a fixed 50 ms for an unref'd janitor timer (red under CI instrumentation at `tool-exec-plane:926`) -- now polls up to 3 s; the fs-atomic rmdir-strike loop 10 -> 25 rounds (the window misses on loaded runners); the workflows-engine `settle` budget 3 s -> 6 s. (5) **the silent floor gets a voice**: the linux coverage step now tees its table, and a failure step annotates every file under the bunfig 0.80 with a real `::error file=` line -- the next threshold miss names itself instead of haunting the log. The macOS shim compile smoke also replays the clang invocation and prints the compiler's stderr when `compileShim` returns null (the logger is stubbed in tests; "Received: null" told CI nothing). Gates: `bun run check` clean; `bun test --parallel` 11477 pass / 0 fail; full `bun test --only-failures --coverage --parallel` prints "0 fail" with no process-level errors.

- **webui - Ctrl/Cmd+C actually reaches the clipboard: copy writes through the shared `copyText` seam.** Owner report 2026-11-16 (live app, real keys): the selection highlighted fine but Ctrl/Cmd+C put NOTHING on the clipboard. The borrowed-textarea stage was self-defeated -- the keydown staged `allSelText` into the hidden textarea and left the key UN-prevented for the browser's native copy, but our own `onCopy` handler called `clearInput` synchronously inside the copy event, BEFORE the default action read the selection, so real Blink copied nothing; the dom-helper pins could never see it because the fake DOM has no default action (they asserted the stage was set and then cleared). The fix rides the seam the cut already ships on: Ctrl/Cmd+C now `preventDefault()`s and calls `copyText(text)` (clipboard API, legacy execCommand fallback inside), the stage/setSelectionRange dance is gone, and `onCopy` stays as the residue cleaner it now actually is. The empty-selection inertness (no call, no preventDefault -- the shipped Ctrl+X doctrine) and the multi-range `\n` join (`allSelText`, contract unchanged) carry over unchanged; paste, cut and `copyText` untouched. Tests: the copy-staging pin re-pointed to the new contract (navigator.clipboard writeText capture via `Object.defineProperty`, restored in `finally` -- selection -> exact joined payload + keydown preventDefault'd + textarea never dirtied; empty selection -> no call, no preventDefault, buffer inert; a stray copy event over composition residue still clears). Mutation-checked (the revert turns the pin red); verified in real Chromium (CDP `Browser.grantPermissions` + `navigator.clipboard.readText`) and on the live app. Zero wire, zero config, zero deps.

- **webui - the editor's foot bar reads the caret and takes you anywhere: a `row:col` chip that turns into a jump box.** Owner request 2026-11-16. Immediately LEFT of the whitespace toggle sits the primary caret's position, 1-based both axes (`1:1` at the very start, line 10 col index 81 reads `10:82`), rendered straight from `sels[primary].head` so every caret move repaints it with no extra state -- mono tabular digits, a fixed-height chip so the 2px bar never jitters. Clicking swaps the chip for a small input (same seat, same face, seeded with the current position, focused). Grammar: **`N`** jumps to line N **keeping the current column**; **`N:M`** sets both (M is the 1-based column); line clamps to `[1, totalLines]`, column to `[0, line length]` through the buffer's own `clampPos` (surrogate-pair clamp included); a jump ALWAYS lands a single caret (the list collapses -- a goto out of a multi-caret state leaves exactly one). Enter submits, focus returns to the capture textarea so typing continues; an **invalid spec refuses honestly**: no jump, no close, the box stays open for the fix. **Escape** or a bare blur (walking away) cancels back to the readout, never jumping. Keystroke isolation is structural -- the editor's key handler rides the textarea, the box lives outside it (pinned: keys in the box never touch the buffer). One windowing wrinkle the jump exposed: keyboard moves never scroll the viewport, so the jump adjusts the viewport `scrollTop` to bottom/top-align the target row before committing, and the windowed slice repaints around the caret. State is ephemeral per-path view state (the `editorViews` pattern) -- no config key, no localStorage, zero wire, zero deps. Tests: eight app-wiring pins (readout 1:1 -> click -> typing advances; click seeds + focuses the input, seated left of the ws toggle; `10:5` lands caret (9,4) and collapses a seeded alt+click pair to ONE caret -- proven by one keystroke editing exactly one row; `7` keeps the column and clamps to a short line's end; `abc`/`0:5`/`1:x`/`1:2:3`/empty all refuse with the box open and the buffer clean; Escape AND blur cancel unmoved and refocus the editor; off-screen `50` on a 60-line file scrolls the slice (viewport scrollTop 600, caret row painted)); all mutation-checked (static readout, un-poked open, no-collapse jump, unclamped jump, closing refuse, submitting Escape, submitting blur, dropped scroll -- each revert red). Live smoke on :3001 (real mouse + real keys): open reads `1:1`, click seeds `1:1`, `3:5` Enter puts the caret at row 3 left=973 against Range ground truth 973, `2` Enter keeps the column (readout `2:5`, same x, one row up), zero dirty.

- **webui - the editor's selection highlight becomes VISIBLE: the painted rects were correct and zero pixels tall.** Owner dogfood 2026-11-16 (live app, marks ON, real mouse): "clicks move the caret, but the selection is always zero -- it will not highlight or select anything." Document-level capture-phase forensics over real CDP drags cleared the event suspects exactly: every held mousemove reached the viewport (`buttons:1`), the viewport node survived the reactive-atom re-render (no re-mount, zero mutations, `vpConnected` true), and the buffer selection DID extend (three `.editor-sel` rects mounted mid-drag with the `--accent-soft` background) -- the rects were `position:absolute` empties with NO vertical extent, so Blink painted each one ZERO pixels tall. The standalone rig missed it because its drag scenario counted `.editor-sel` nodes and trusted the background; no pin ever measured a painted HEIGHT. `.editor-sel` now carries the caret's own recipe (static position, `height: 20px` = EDIT_LINE_H; same cure on `.editor-match`, the identical latent zero-height abs child), and `selRects` now paints the ANCHOR row of a multi-row range from `xForCol(anchor.col)` instead of x=0 -- the over-paint was invisible while every rect was, and only became a defect the moment the height landed. Verified live after the fix: drag across `.gitconfig` rows paints h=20 rects growing 2->3->4 rows per move; shift+click extends (anchor rect starts at the pressed column); a wheel mid-drag survives and the drag keeps extending. Tests: three structural styles.css pins (rect height; the banned zero-extent shape) and a layout-injected marks-ON app pin driving press-right-of-tab -> cross-row drag -> anchor-rect offset + replace-with-one-keystroke; mutation-checked (the CSS revert and the `selRects` revert each turn the pins red). Chrome/CSS + overlay paint only -- zero wire, zero config, zero deps.

- **webui - the caret stops landing LEFT of the click on tab-indented files: the code element pins the probe's face over the UA default, and the whitespace marks become real-character overlays.** Owner dogfood 2026-11-16, marks ON on `/home/agent/.gitconfig`: the caret landed left of the clicked glyph, growing with the column. Measured root cause, real Blink: the UA stylesheet gives every `code` element a SPECIFIED monospace family, which beats the `--font-mono` inherited from `.editor` -- the rows rendered in the system mono while `.editor-measure` measured the house face (computed `.editor-code` family was literally `monospace`). Weight-400 advances happened to agree (8px), hiding it; the tokenizer's 600-weight runs (`.tk-key`, `.tk-section`, ...) then fell through per-glyph fallbacks at a DIFFERENT advance -- live row `"\thelper = !/usr/bin/gh auth git-credential"` measured `helper` at 7.33px/char against the model's 8.00 -- so every semibold glyph dragged subsequent cells left, cumulative from the line start, and the ws marks' arrow/dot rode the same fallback mercy (`→` measured 6px at weight 600). Two-part cure: (1) `.editor-code` AND the viewer's `.file-code` now declare `font-family: var(--font-mono)` (Reddit Mono measures 8.00 at 400 AND 600, incl. `→`/`·`); (2) `ws-render.tsx` stops betting on glyph metrics at all -- the REAL space/tab character stays in the text flow (the advance equals the unmarked row's BY CONSTRUCTION; CSS tab-size still expands the tab), and the mark is an absolutely positioned aria-hidden glyph inside the `position:relative` wrapper (dot centered, arrow at cell start, zero layout impact, honest DOM text). The sandbox rig had never run marks ON (and passed `lang=undefined`, so it never painted a semibold run either) -- both gaps now pinned in `tmp/editor-mouse/probes-ws.ts` (ws-mode face parity, per-node advance, marks-on click round-trip dx=0 across a tab+semibold row, on/off row-width parity 144==144, overlay DOM contract, drag rect heights), and the live app verifies after the fix: click round-trip on `.gitconfig` row 3 at cols 1/4/8/20/40/42 lands dx=0.0 against Range ground truth. Tests: the structural styles.css pins (face pin, glyph out of flow), the rewritten tab-mark DOM pin (wrapper carries the REAL tab/dot character + aria-hidden overlay), all mutation-checked (each revert red). Zero wire, zero config, zero deps.

- **webui - owner chrome batch: the file foot bar and the tree indent tighten, the footer icon buttons shrink.** Four dogfood rulings, CSS-only: `.file-view-bar` padding 4px 12px -> 2px 4px, gap 8px -> 6px, and a `border-bottom: 1px solid var(--border)` closing the bar below its existing top border (the bar shared by the read-only viewer and the editor), `.file-reload-btn` 32px -> 28px (the glyph-button idiom the footer's Reload, the whitespace toggle and the settings Refresh share -- the inner 16px SVG is untouched), and `.ft-children` padding-left 12px -> 8px (the file tree's per-level indent, which the nested container owns, not a style attr). Zero wire, zero config, zero JS; no test pinned any of these numbers.

- **webui - the resize seams stop eating the scrollbar tracks, and the highlight shrinks 6px -> 2px.** Owner dogfood 2026-11-16 in the four-pane row (session | chat | workspace | files): every vertical seam (`#sidebar-resize`, `#workbench-resize`, `#dock-resize`, `#tree-col-resize`) straddled the border it owns by +/-3px with a 14px `::after` hit pad -- and each of those borders has a scrollable pane's 6px webkit track just INSIDE it (the session list, the chat, the tree column all scroll on their right edge), so half the strip and most of the pad sat on the track: a thumb press landed on the handle. Each strip now STARTS at the border and rides the non-scrolling side (sidebar -> chat side `right:-6px`; workbench/dock -> their own side `left:0` / `calc(dockWidth - 6px)`; tree-col -> the file-viewer side `left: var(--tree-col-used)`), and every `::after` pad widens OUTWARD only (`left:0; right:-8px`) -- ~14px grab target, zero track coverage, drag math untouched (the pointer handlers never read the strip's box). The hover/drag highlight is no longer a full-strip `--accent-soft` slab (read as a layout edge); it paints a 2px accent line at the border edge via a pinned gradient (`left/2px 100%`), and `focus-visible` paints the SAME line at full `--accent` instead of an outline box around the now-invisible strip. Chrome-only CSS, zero wire, zero config, zero JS. Tests: `webui-resize-seam-css.test.ts` (track width as the sizing basis; per-seam start-at-border offsets + the -3px straddle banned from every seam rule; outward-only pads incl. the shared dock/tree `::after` pairing; the 6px + `col-resize` hit geometry survives; the 2px-line paint doctrine for hover/drag/focus) -- mutation-checked: seven reverts (each offset, a track-eating pad, the slab, the outline) each turn the suite red.

- **experimental/agent-browser - the user-gate probe reads the config per use; a live `userGate` flip reaches `evaluate` without a restart.** The evaluate fail-closed gate captured `getExtensionConfig(core, "userGate").enabled === true` ONCE inside `create()`, so a userGate enablement after boot left the tool answering "no approval prompt surface here (the user-gate extension is not enabled)" forever -- while `core.config` is itself a live store accessor (main.ts), the capture threw the liveness away. `AgentBrowserTool`'s `userGateEnabled` option becomes a `ConfigKnob<boolean>` (the B6a seam: pinned scalars stay for test doubles and non-config hosts; production passes a reader), and `#modelEvaluate` resolves it through `readKnob` at the point of use. Enablement itself is still loader-time -- a never-loaded extension registers no TOOL_CALL hook, so `userGate.enabled: true` needs a boot to make the prompt surface exist; this fix only stops the tool from pinning a stale answer about it. Tests: a liveness pin (boot without the block -> refuse; a store-generation swap adding `userGate.enabled` -> the next evaluate passes the gate and stops at the missing view), mutation-checked -- it fails when the knob is captured in the constructor. Gates: `bun x tsc --noEmit` clean; `tests/extensions/agent-browser{,-smoke}.test.ts` green. Zero config keys, zero wire changes.

- **webui - a user message's attachment boxes read their own ink: the hotdog theme's black-on-black closes.** The boxes live inside the user bubble, which carries `--text-inverse` -- dark in the hotdog palette by design (it serves the mustard fills), but the box repainted itself onto its own dark `--bg-secondary` surface while INHERITING that ink (ratio ~1.1:1); purple survived only because its inverse is white. `.attachment-box` now declares `color: var(--text-primary)` next to its own background (surface owns its ink), verified in real Blink across both palettes (hotdog ~14.3:1, purple unchanged ~14.5:1; the inner `.attachment-content` inherits). Chrome-only CSS, zero wire, zero config.

- **webui - the editor's mouse interaction survives real Chromium: drags ride the LIVE code origin, and the mount-time rects stop being zeros.** The j2 defect-1 follow-through, reproduced on a real layout engine this time (headless Chromium driving the actual `FileEditor` over the real styles.css + Reddit Mono: click/drag geometry read off `Range`-measured glyph positions, not faked rects). Two defects the dom-helper pins structurally could not see (no layout engine): (1) the viewport drag computed its column from `codeLeft` captured at press time -- 0 before the FIRST-ever row press and frozen against a horizontal wheel-turn after -- so a page's first gesture (drag from the empty sheet) landed a full gutter RIGHT of the pointer, and a wheel mid-drag shifted every column by scrollLeft/cw; the mousemove now re-reads the code origin from the first painted row's live rect on every move (all rows share one x origin; the horizontal scroll carries with it; zero-rect test DOM keeps the documented fallback). (2) The viewport `ref` fires BEFORE the node joins the tree (the house JSX create path), so vpTop/vpLeft/gutterPx were zeros until the first re-render -- the parked (pointer-transparent) textarea sat a gutter left of the caret for the IME; the same measurement re-runs in a mount microtask once insertion + layout exist. What the real-browser sweep PROVED already holds: probe advance == rendered glyph advance exactly (delta 0 with Reddit Mono settled), click->column->caret pixel-exact across a 46-cell row and on tab-indented lines, cross-row drag / shift-click / alt+click add-remove / double-click word / empty-area-buffer-end / scrollbar-press-inert / both-axis scroll round-trips. Tests: two layout-injected app pins reproducing the fresh-page empty-drag and the mid-drag wheel (mutation-checked: they fail when the live read is removed); the Chromium rig itself lives in `tmp/editor-mouse/` (gitignored). Zero deps, zero config keys, zero wire changes.

- **webui - the editor grows multi-caret and VS Code-style brace matching, and three review defects close (mouse selection, the inert unload veto, tab stops).** The selection model was already a range list with a primary; this extends it, never rewrites it. **Multi-caret (VSCode semantics, `editor-buffer.ts` + `editor.tsx`):** Alt+click adds a caret at the CLICK POINT (the shipped rule, documented -- not VS Code's selection-end remap), clicking an existing caret removes it, clicking inside a range replaces that range with a point caret, and the last caret can never die; the list stays sorted with duplicate/overlap collapse (`collapseSels` merges identical carets -- j3 fix #1: two zero-width carets at one point used to slip through its strict overlap gate and type twice -- while a caret merely touching a range's END stays distinct), the acted-on caret becomes primary. Alt+Shift+Arrow / Ctrl+Shift+Alt+Arrow adds a caret on the next/prev line at the same column (clamped to the line's length -- never pads; running off the buffer returns the buffer unchanged). Alt+Shift+drag is BOX selection: every line in the drag gets a range converted from the shared visual-column mapping, short lines CLAMP (no padding -- typing lands at each line's own end, exactly VS Code's rule); the box rebuilds from its anchor on every move. Regular drag still extends the PRIMARY through the multicaret plumbing (pinned across a line boundary with real rects). Plain arrows collapse to the primary; Escape collapses everything to the primary head. Typing, Backspace/Delete, Enter (auto-indent, and the empty-pair three-line expand), Tab/Shift+Tab and paste apply at EVERY caret, edits descending-offset through ONE `performTx` (one undo step per operation, all carets revert together); carets recorded above an applied edit are remapped through it (`shiftPastEdit` -- the offset-shift fix this batch forced: multi-line inserts used to leave higher carets stale). The overtype branch applies ONLY when EVERY caret overtypes (j3 fix #2: a plain caret or selection alongside an overtype caret used to have its keystroke swallowed; mixed lists now edit per-caret and the mixed caret list re-collapses through `collapseSels`). Multi-range copy joins with newlines (pinned). **Brace matching while typing, per caret (`braceTypeAt`):** `( [ {` auto-close when the char right is EOL/whitespace/any closer, never before a word char; quotes add the inside-word veto (typing `"` in `foo|bar` inserts one char) but the general right-char condition dominates (no pair before `word` even at line start); typing `) ] }` over its own closer walks over -- no text change, no undo step, no dirty -- and quotes overtype only with an ODD count of that quote left (the open pair we inserted); Backspace between an empty pair kills BOTH halves; Enter between `{|}` gives opener / caret at opener-indent-plus-one-stop / closer at opener's indent (tabs honored), quotes never expand, and Enter with content stays a plain auto-indent newline (no reindent engine -- stated ceiling). Matched-pair HIGHLIGHT: caret adjacent to a bracket -> `matchBracket` finds the mate with a naive generic-depth scan (skips quoted runs, reports crossed brackets honestly as no-match, capped at MATCH_SCAN_CELLS = 200k units so no keystroke hangs) and the render layer tints both cells (`--accent` theme vars). Auto-close pairs are ONE undo step; pair + immediate backspace leaves no orphan closer at any undo/redo stop (pinned). **j2 defects:** (1) the capture textarea is `pointer-events: none` (it sat one gutter LEFT of the caret in real browsers and swallowed every press -- the "unable to select text at all" repro), it parks at `caretX + gutterPx` measured into the code element's space, and the viewport's empty-area docEnd click now fires only on genuine background clicks (a real `currentTarget`, offsets inside the client box -- scrollbar presses pass through); drag coverage pinned with overridden rects. (2) The dirty-buffer unload veto moved from the shared `DRAFT_LEAVE_EVENT` (pagehide -- NOT cancelable, so the veto was inert in every modern browser) to `beforeunload` UNCONDITIONALLY; the draft flush keeps the house event, the registration is pinned per-event (beforeunload preventDefaults iff dirty; pagehide never). (3) `tab-size: 4` pinned on `.editor-code`, the `.editor-measure` probe, and the viewer's `.file-code` -- bound to the exported TAB_STOP in the structural test (the CSS default of 8 desynced every caret/click on tab-indented files with marks off). Zero deps, zero new config keys, ZERO wire changes, same module seams. Tests: `editor-multicaret.test.ts` (33 pure -- collapse rules, per-caret type/BS/Enter/paste at 3 carets incl. caret remapping, toggle add/remove, arrow/Escape collapse, one-undo-reverts-all + redo, box clamping and typing at clamped carets, the full auto-close matrix, overtype parity, pair-backspace, Enter indent math (spaces + tabs), the match-scan cap/crossed/multi-line, j3 pins for caret-onto-caret dedupe (walk-onto re-seats primary, type/BS once) and per-caret overtype not swallowing plain carets/selections), app-wiring pins (drag across a row boundary with real rects, alt+click DOM seam, tint appears/vanishes, beforeunload registration), layout-css pins (tab-size bound to TAB_STOP, textarea pointer-transparent). Gates: `bun x tsc --noEmit` clean; `bun run test --parallel` 11237 pass / 15 skip / 0 fail; sequential 2 pre-existing config-index fails only; no `mock.module`.

- **webui - four reload/state fixes from the 2026-11-15 dogfood: the viewed subagent, the composer caret, and the "Thinking" row all survive a refresh, and the reasoning chip re-derives the row live.** All client-side in the webui seams; zero wire changes (the existing frames carry the truth), zero config keys, zero deps. (1) **The selected subagent survives a reload** (`chat.ts`): the main-pane browse pointer persisted only in memory, so an in-tab reload re-attached to the manager and painted the parent's transcript. The pointer now rides a per-TAB sessionStorage key (`hotdog-viewed-task`, the workbench-tab idiom: resolved per call, every access swallowed), and on boot it becomes an in-memory CANDIDATE that re-plays EXACTLY ONCE through the SAME `viewSubagent` open the sidebar click uses -- so the settled/live authority rules (durable-log re-read, prompt seed, buffer doctrine) hold identically -- the moment the task hydrates into the feed (`taskList` snapshot, `taskUpdate` upsert, or a `taskActivity` delta; an attach's `sessionCreated` clear is a re-attach, not a navigation, so the candidate waits). An unknown/gone id in a full snapshot drops the key and the boot behaves exactly as before. Every navigation writes atom + key together (`setViewedTaskPointer`): opening another task, closing the view, switching sessions, creating one, or opening a cold log persists the NEW pointer, never a stale one, and `clearTasks` (logout) kills candidate and key alike. (2) **The composer's caret and focus survive too** (`draft.ts` + the mount seam): the draft already persisted its text; the caret (`selectionStart/End`) and a "composer had focus" marker now ride a sibling key (`hotdog-webui-draft-caret`, strict JSON decode -- garbage means no restore) written through the SAME debounced path as the text, one coalesced snapshot read at fire time so text and caret cannot disagree, blur demoting the marker without a keystroke, and emptying/sending taking the record with the draft. On hydrate the selection always lands (clamped into the value); focus lands ONLY when the marker says so AND nothing owns it -- an open settings dialog, search panel, context menu or completion popup owns focus deliberately (the a11y batch's handoffs), and so does any live `activeElement`. Same throwing-storage guards as the text (private-mode Safari costs the reload, never the app). (3) **The live "Thinking" row recovers from a mid-turn reload** (`message-list.ts`): the row answered the momentary events, so reloading while a turn ran lost it even though the session kept working. A fresh view's FIRST `working` report (the attach burst's re-attestation, attach.ts) no longer trusts the replay burst wholesale -- committed rows are EARLIER calls of the turn -- and instead re-derives the row from what THIS view holds UNCOMMITTED (the running call's flushed partial, a tool round awaiting its result, an open preview, a visible thinking block). Nothing in flight on screen -> the row appears; the running call already has bytes -> it stays down; attaching to an idle session (`working:false`) never fabricates it. (4) **Toggling reasoning visibility DURING a live reasoning phase re-derives the row**: the show decision had already fired when the reasoning began streaming, so hiding reasoning mid-call left the pane silent. The set-HIDE path now re-evaluates (2026-11-15 ruling: the row covers the reasoning phase while reasoning is hidden): call in flight with no PLAIN content streamed yet -> the row takes the gap back; content already streaming -> it stays down; toggling back ON -> the row retires as the reasoning blocks become visible. One evaluation function (`syncThinkingRow`), both callers -- symmetric with (3)'s state-derived driving; the old "hiding again must not bring it back" yo-yo rule is deliberately superseded by the ruling. Tests: `dom-helper/chat.test.ts` (pointer applied exactly once after hydration incl. the pre-manager snapshot beat, gone-id clears the key and keeps the parent transcript live, activity/update hydration, navigation persists the new pointer through every route, logout, plus the attach-recovery and chip-toggle-re-derives pins), `dom-helper/message-list.test.ts` (committed-only/tool-round/flushed-partial/hidden-partial attach matrix, honest idle absence, the full toggle show/retire matrix incl. the superseded yo-yo pin re-pointed with its ruling), `dom-helper/app.test.tsx` (boot caret hydrate no-steal, the debounced save carrying text+caret+marker as one snapshot, blur demotion, the exported seam's no-steal matrix against the real search/settings popups), `webui-draft.test.ts` (roundtrip, coalescing, flush, empty-takes-caret, strict-decode junk sweep, throwing storage). No `mock.module`; storage through the existing guarded/injectable accessors. Gates: `bun x tsc --noEmit` clean (modulo the concurrent editor batch's untracked probe file); `bun run test --parallel` green modulo that batch's in-flight files; the four touched suites sequential-green.

- **webui - the editor fills the pane top to bottom, the caret stops drifting, and three correctness holes close.** Owner dogfood (2026-11-15). **Full height:** a file tab (editor or read-only viewer) now owns the whole workbench pane -- the code sheet runs the full height, the foot bar pins the bottom on short AND long files, and the `--bg-base` sheet paints the empty area under the last line (the lighter `--bg-secondary` no longer shows between content and bar). Done as a pure flex chain, no magic pixels: `#workbench-body:has(.editor)`/`:has(.file-view)` become a non-scrolling `display:flex; flex-direction:column; overflow:hidden`, the tab body a `flex:1` column, `.editor`/`.file-view`/`.file-view-rows` `flex:1` -- so the sheet scrolls INTERNALLY (one scrollbar, never two) and the tree tab keeps riding `#workbench-body`'s own y-scroll unchanged. A click in the empty area below the content now places the caret at the buffer's END (the viewport owns that click; rows only cover `total x EDIT_LINE_H`, so no phantom row). **Caret-drift cure** (the reported bug: caret landed left of the click, more the further from column 0): the code spans inherited the UI **sans** face (proportional) while the probe measured mono -- so the fixed-cell model was wrong and the error grew linearly with the column. `.editor` now renders `--font-mono` with `font-variant-ligatures: none` and `letter-spacing: normal` (a ligature collapses two code units into one cell), the `.editor-measure` probe mirrors that chain verbatim, column<->x funnels through ONE shared mapping (`xForCol`/`colForX` -- the caret, the selection rects, and the click hit-test cannot diverge), and because the webfont finishes loading AFTER first paint the probe re-measures when `document.fonts` settles (`document.fonts.load` for the exact faces + `ready`) and repaints every open editor onto the new advance. Whitespace marks stay exactly one cell per code unit (arrow + padding fill the tab's cells). **Three correctness fixes (j2 review):** Ctrl+X with an EMPTY selection is now inert (a cut is copy-then-delete; it no longer eats the character left of the caret or joins lines -- Ctrl+C already no-oped); an in-flight save that loses a rename to the SAME file now has its pending record retargeted to the new path so the reply clears the `saving` gate (previously the moved session's gate stuck true forever and every later Ctrl+S was silently refused); and a dirty buffer now vetoes a browser refresh/close through the house leave event (`pagehide`/`beforeunload`, checked live -- no new state) instead of vanishing with zero prompt while the sessionStorage tab strip looked restored. A late editor commit for a closed tab can no longer resurrect its session. Also: the double-click punctuation run stops at whitespace (was `/^\W/`, which swallowed the spaces), the drag hit-test re-reads the viewport rect, and the `compositionend` empty-`data` contract (cancel, not fall back) is documented to match the code. Gates: `bun x tsc --noEmit` clean; `bun run test` 11159 pass / 15 skip / 0 fail. New pins: `editor-buffer.test.ts` (+ docEnd, three-way word classes, the shared column<->x round-trip at columns 1/100/400 incl. scroll), a new `webui-editor-layout-css.test.ts` (full-height chain + mono/ligature probe-parity structural pins), and `app.test.tsx` (empty cut inert + real cut works, empty-area click to buffer end, save-in-flight + rename retarget, dirty-buffer unload veto, tab-mark cell width, webfont-settle re-measure repaints the caret).

- **webui - the editor's foot bar carries the syntax chooser back.** Owner regression 2026-11-15: the 2026-11-14 paint override (detected language, click for the list, accent when an override is in force) lived only in the read-only `.file-view-bar`; editable files moved to the editor's bar and the affordance vanished. The same native select now rides `.editor-bar` -- same `fileViewLangChoices()` list, same Auto/`(auto)` grammar, same `setFileViewLang` store seam (one override per path drives BOTH shapes; the folded paint lang already re-rendered the layer, only the control was gone). `langLabel` exported from file-view.tsx for the shared title/label strings. Tests: `dom-helper/file-view.test.tsx` gains an editor section (Auto leads and is selected, tokens prove the lang, override rides the accent, choice-equal-guess does not flag, change routes to the seam and empty hands back the guess) -- the missing editor-side pin is exactly how this regressed.

- **compaction - pass-the-baton is notice-first: the agent narrates its handoff with its recent work STILL IN CONTEXT, then the baton passes.** Owner report 2026-11-15 (workflow worker session `356fd25b`): "the agent's context was cleared first, then it was given the instruction to summarize and handoff" -- the seam shows the last full call at 254,388/262,144 tokens, the stash popping 276 of 278 messages (everything past the task), and the next request arriving at ~8k whose reasoning reads "End of session has been declared... But I haven't done any work at all yet, have I?" Four defects, four fixes, in `src/extensions/compaction/**`. (R3, the complaint) The auto-trigger (CONTEXT hook) NO LONGER POPS FIRST: over budget appends the handoff notice with NOTHING popped -- the prompt stays the byte-prefix plus one appended system-notice (prefix caches keep hitting) and the model narrates with the full recent context visible; the trigger zone fires below the model limit, so the append still fits. The handoff paths (TURN_END: handoff tool / narrated completion) clear the context anyway, so the replay window is stashed BEFORE the clear (path B recomputes from the live context: last stash merged with everything appended after the notice, budget-capped, orphan-tool starts walked back to the parent, notice text filtered out; path A replays the last known stash -- the clear happens above that hook) so the plan text's "Its most recent turns are appended verbatim below" finally lands; the CONTEXT-hook replay delivers it after the plan. A model that ignores the notice and re-triggers over budget degrades THEN: the tail pops (stash merged ahead of the older window, deduped by message identity, re-capped; the sweep cannot lose the newest narrated work), the notice re-appends, and popping only the notice is refused as churn. The PROVIDER_ERROR overflow rescue keeps pop-immediately semantics -- the full-size request already failed, no room for notice-first -- via a runtime `batonPopNow` directive on the settings view (never a config key; manual `/compact` runs it too). (R1) The orphan popback had no floor: the old loop backed the cut off trailing tool turns ONE MESSAGE AT A TIME, so a tool-only transcript (every assistant turn `tool_calls`, no plain-text exchange anywhere -- exactly workflow workers) descended past everything and returned a 2-message keep (system + task) as success, popping ~100% (reproduced: 520 of 522). The cut now rewinds in ONE jump to the last clean exchange boundary tracked on the forward walk; no viable boundary (under two kept messages, or no assistant turn inside the keep) returns NULL so the rescue chain degrades onward to trim/drop. (R2) The keep budget used the wrong window: `runSettings` folded `core.resolved.contextLimit` (default 128000) while the trigger and provider used the effective MODEL window (262144 on the victim -- it kept to ~120k of a window it had room to keep). Absent an explicit `compaction.contextLimit`, strategy runs now resolve the budget through the SAME `resolveModelConfig` value `shouldCompact` bills (threaded per trigger; window-less views -- the manual keep path and its debug dump -- keep falling back to the core knob); no new config keys. (R4) The stale-notice lockout is dead: `hasBatonNotice` used to make `canCompact` false forever, so the victim ground for 10+ minutes regrowing from the 8k base with baton disabled and its next real overflow fell to cache-nuking front-cutting trim/drop. The notice's lifecycle is now: appended when over budget, consumed by the handoff clear, and its presence merely selects degrade-pop over append -- it never disables compaction. Doctrine comments rewritten to the new flow (the old header described the pop-first design); `contextLimit`'s extension.json description follows the truth. Tests: the baton suite rewritten around the new lifecycle (53 pins: tool-only notice-append with nothing popped and recent work byte-identical, degrade pop cutting on a clean exchange and staying stable, handoff clear + verbatim replay incl. the post-notice work and the no-pop snapshot path, tool-only null -> trim fallthrough, rescue pops immediately and shrinks the failed request, notice-present rescue degrades to a baton cut instead of trim, R2 budget pins on the 128000-core/262144-model fixture both directions, notice never locks future compaction). One pre-existing pin re-pointed deliberately: "no contextLimit resolves" now needs the model window unresolvable too (that IS the effective window now). Zero deps, no `mock.module`. Gates: `bun x tsc --noEmit` clean; `bun run test` 11137 pass / 15 skip / 0 fail (baseline 11125), plus one sequential compaction run (267 pass).

- **webui - the file-view tab becomes a real editor for capped files: custom hidden-textarea core, undo, Ctrl+S with the mtime conflict gate, and a per-browser whitespace toggle.** Zero dependencies -- no CodeMirror, no npm anything -- three new modules under `src/extensions/webui/ui/`: `editor-buffer.ts` (the PURE half: line-array buffer with a byte-exact `contentOf` round-trip, the selection-as-range-list model -- `sels` is always a list with a designated `primary`, today length 1, every op already iterating the list so the multicaret node only adds affordances; the generic undo seam `performTx` records one `{edit, inverse}` pair per applied edit and coalesces typing runs word/timeout-bounded (`COALESCE_MS`, whitespace/punctuation bounds, insert/delete polarity split) while Enter/Tab/paste/IME land as block steps; the save/dirty machine `applySaveResult`/`confirmDiscard`), `editor.tsx` (the CM5 trick: a visually hidden `<textarea>` holds focus/IME and owns ONLY the in-flight composition text -- every editing key is intercepted in keydown BEFORE default and applied to the buffer, the textarea's invariant is "empty"; `compositionend` is the only commit point, so textarea and buffer cannot desync across composition; the visible layer renders a WINDOWED slice of tokenizer lines with an absolutely-positioned caret + selection overlay, monospace metrics measured once from a probe span with a deterministic test fallback; typing, Backspace/Delete with line joins, Enter with auto-indent (copies the previous line's leading whitespace), Tab to the next multiple-of-4 column, Shift+Tab dedent to the previous stop (min 4-step, no config key), smart Home/End cycling, PageUp/Down, Ctrl+Home/End, click/drag/dblclick word-select, shift-extend, Ctrl+A, Escape collapse, clipboard through the textarea (Ctrl+C stages the selection text, the native copy event clears it; paste reads `clipboardData` and applies one block tx; Ctrl+X deletes through the undo seam), and a header glyph-button toggling visible whitespace -- middle-dot spaces, arrows to the tab stop, a subtle trailing-ws highlight -- persisted per browser via the theme-pref localStorage pattern INCLUDING its throwing-store guard; a view pref only, no server, no config key), and `ws-render.tsx` (the shared span renderer so the viewer and the editor decorate IDENTICALLY -- marks split INTO the token runs, syntax color survives). The read cap IS the edit cap: the app pages the existing `readFile` seam to `MAX_FILE_READ_CHARS` (256 KiB, client twin pinned to the server constants) and a read that comes back complete and within it opens editable; over-cap files (and binary, which `readFile` already refuses) STAY in the viewer with an honest "Over the 256 KiB edit cap" note and the pager stops auto-paging the moment the accumulation proves the verdict. Ctrl/Cmd+S is claimed by the editor (no app-shortcut collision) and sends `saveFile` with the recorded BASE mtime; success clears the workbench tab's dirty dot (additive `dirty` flag + `setDirty` on the tab store) and moves the base to the reply's NEW mtime; a conflict refusal opens the window.confirm precedent naming BOTH doors (OK = Overwrite = resend with the fresh mtime, zero reload; Cancel = reload from disk and DISCARDS -- said out loud), dirty-close/reload confirm through the same `confirmDiscard` gate. Cache-honesty rule: the viewer cache AND the recorded read-meta drop EXACTLY when the cached bytes can be stale -- a dirty discard and a SUCCESSFUL SAVE (the disk is ahead now; the reopen pays a fresh read instead of editing off stale text), a clean close keeps both so the zero-traffic reopen doctrine holds and lands EDITABLE off the survived mtime (activation is a cached ready view's open hook). Rename keeps a dirty tab's text and re-points its save at the NEW path (fs-ops doctrine, pinned end to end); a delete closes its tabs with the dirty confirm already taken before the op ships. Tests: `tests/dom-helper/editor-buffer.test.ts` (25 pure: byte round-trips, multi-range single-step undo, line joins, surrogate pairs clamped/deleted whole, coalescing bounds, auto-indent, tab stops, dedent semantics, the save/conflict machine, cap twins) and the app-wiring section in `app.test.tsx` (typing mutates buffer+layer and keeps the textarea empty, the dot + Ctrl+S fields + dirty-clear + base-chain, both conflict doors, dirty-close confirm + fresh reopen, zero-traffic clean reopen opening editable, IME commit-on-end only, paste/copy staging, the over-cap read-only note, the whitespace toggle persisting and repainting both bodies). Two core bugs fell out of the new pins: a single-line insert replacing a MULTI-LINE span stranded the tail lines (Ctrl+A-and-type, line-joining backspace), and a hit-tested caret could land INSIDE a surrogate pair (now clamped to the pair start, deletes eat pairs whole). Zero new config keys, additive-only wire (none added here at all -- the fs-ops seam serves it), no `mock.module`. Gates: `bun x tsc --noEmit` clean; `bun run test` 11125 pass / 15 skip / 0 fail.

- **webui - the sidebar's actions trigger gets bigger and never hides on the viewed row.** Owner UX pass 2026-11-15: the 12px hover-only kebab read as invisible. On the shared `.row-menu-btn` idiom (its only consumers: the live session cards, the cold log rows, the subagent rows): the glyph grows 12px -> 15px, the pseudo hit box widens to ~31px, and every row family's reveal rule gains its ACTIVE state (`.session-item.active`, `.log-item.active`, `.subagent-row.active`) -- the viewed row shows the button without hovering, the rest keep the hover/focus reveal. No markup, wire, or behavior change; the right-click/Menu-key routes are the same menu.

- **webui - the file tree grows real file ops: create, rename, delete, download, and the server-side save seam the editor codes against.** (1) Five additive C2S messages on the websocket (`createFile`, `createDir`, `renamePath`, `deletePath`, `saveFile`), every reply one `fileOpResult` envelope correlated by requestId (the id names the op), refusals honest one-liners on `error` with stacks server-side, the pre-auth gate inherited from the routing table. Every side of every op passes `Workspace.resolveSafe` BEFORE any fs call -- rename checks both paths, and EVERY create/write/move destination passes a landing-dir gate (`resolveSafe` on the parent: the real-spelling deny recheck inside `resolveSafe` fires only for EXISTING paths, and a not-yet-existing final component falls back to the lexical spelling, where an in-root link like `x -> .ssh` hides the denied directory behind it -- the j1 review planted files into `.ssh`/`.git` through exactly such links while the direct spelling of the same path refused), so a denylisted or escaping destination refuses the WHOLE move and the subtree never stirs. The gates: creates never clobber (wx/bare-mkdir are the exists-gates) and never invent parents (no mkdir -p); rename refuses a missing source, an existing target, and a workspace ROOT; delete refuses the root, recurses on directories (the UI confirms with honest recursive copy -- the server contract is stated in code), and UNLINKS symlinked entries without ever following them; saveFile (the write seam, unused by the UI until editor-core lands) refuses directories and symlinks at the path itself (O_NOFOLLOW posture), caps content at `MAX_FILE_WRITE_BYTES` (deliberately the read cap's own number measured in BYTES: UTF-8 can expand a char to 4x, so bytes gate tighter and one numeric ceiling serves the seam), writes atomically (per-op temp + rename in the same directory; the whole gate+write+rename section runs under a per-path promise-chain lock -- the j1 review caught two async same-path saves sharing a bare-pid temp, landing mixed bytes and answering ok for writes that did not land -- so racing same-path saves now answer EXACTLY one ok and one conflict, and racing renames onto one target answer one landing and one "target already exists"), and answers a STALE `baseMtimeMs` with `conflict: true` + the CURRENT mtime and zero bytes written -- the documented overwrite flow is resend-with-the-fresh-mtime, which lands (pinned). `readFile` answers an additive `mtimeMs` (the editor's BASE; absent on refusals). (2) `GET /download/<path>` beside `/export/*`: auth MIRRORED exactly (same token sources, same `validateToken`, the same 401 `{error:"Unauthorized"}` before any byte; parity pinned), containment is the same per-request `workspaceFor(...).resolveSafe`, directories are 400, and `Bun.file` STREAMS the body -- no whole-file base64, no frame-cap surface; the attachment filename is sanitized down to characters that cannot break the header. (3) The row menu, from a pure `fileTreeMenuPlan(kind)`: roots create+copy (config, not content), dirs create/rename/delete/copy, files rename/download/copy/delete; names via prompt with local validation (empty / separator / dot-walk refused, cached-listing overwrite check) and the server's "already exists" as the raced authority; delete confirm-gated with the recursive truth in the copy; success refreshes ONLY the affected subtree (one minted listDir per touched dir, never a whole-tree reopen), a rename retargets the open tab IN PLACE (identity follows the file, viewer entry moves with it), a delete closes the tabs it kills (no dirty concept exists yet -- the honest minimal rule, editor-core upgrades), and refusals ride the shared ephemeral toast VERBATIM. Rapid repeats survive: ops correlate through their own sequence + pending map, unknown ids drop. Zero deps, zero new config keys, existing message shapes byte-identical. Tests: `websocket-fs-ops.test.ts` (61: happy paths, the sentinel sweep across every op including both rename sides and the symlink chain, root guards, mtime-conflict refuse + fresh-mtime overwrite, byte-cap boundary incl. multibyte-under-chars, atomicity via an un-creatable temp (NAME_MAX), same-path save races (one ok + one conflict, never mixed bytes, over payloads and over the wire) and rename-target races, pre-auth parity); `webui-server.test.ts` download section (auth parity against the export refusal, traversal/deny/symlink 400s, directory 400, 404, 405, sanitized filename); `dom-helper/app.test.tsx` (grammar per row kind, confirm gating + recursive copy, subtree-only refresh frames, tab retarget/close, validation zero-wire, the download anchor); pure-op pins for `refreshTreeDir`/`expandListedDir`/`forgetTreePath`, `retargetTab` (incl. store notify), `retargetFileView`/`forgetFileViews`. `bun x tsc --noEmit` clean; `bun run test --parallel`: 11090 pass / 15 skip / 0 fail. No `mock.module`.

- **webui - a subagent transcript now opens on its delegated prompt and closes each response with the same footer the session view shows.** Owner ruling 2026-11-15 reversed two doctrine lines in `protocol.ts` ("token_usage renders nothing" / the composed task prompt is excluded); code and comments now agree. (1) The usage footer ("9:55 PM 62k/262k 13s Worked for 7m 37s"). One additive `TaskActivityWire` kind, `usage` -- numbers and flags only, no text lane: live it carries the forwarded TOKEN_USAGE attestation (gauge gated like ctxByIndex/ctxFromUsage, the measured call time beside it, no ts: the client clocks its own commits) and message-list holds it exactly like the session frame, so the tool-call boundary and the turn flip commit each call's row with gauge + call segments (the flip reads the turn's last live attestation off the buffer -- `lastUsageMeta` -- no second holder); settled, the fold derives everything SERVER-SIDE from the session cold-log primitives (`@utils/session-turns.ts` ctxByIndex / turnFinalDurationsByIndex / deriveCallDurationsByIndex / parseEntryTs) and stamps the item where the live sink would land it (after the response, before its calls), so a settled transcript's footer equals the session view of the SAME log -- pinned against the primitives run directly on the fixture, with a derived call time flagged `callDerived` (never presented as recorded, never entering the live hold). Absent fields are omitted, never invented: a log without an attested gauge gains no item and renders exactly as before. (2) The delegated task prompt, exactly once per task, both authorities: the fold's `user` lane now leads with the FIRST `input` entry -- whatever its origin, composed "model" prompts and legacy origin-less alike -- while every other non-user-origin INPUT stays excluded (harness fuel, later unknown rows) and the `origin === "user"` steering lane is unchanged; the live view cannot relay it (USER_MESSAGE carries no provenance -- the ruling leaves that untouched), so `viewSubagent` seeds one client-only `prompt` block from `TaskInfoWire.description` (the single-line display form of the prompt; a QUEUED task opens on it alone). No-double-render by construction: the seed guard is the block itself, only the live lane seeds (a settled fold leads with the log's own prompt row), the settle flip's WHOLESALE replace retires the seed as the fold's item lands, the unsettled merge re-heads the prompt above the server bytes, and degraded settled buffers keep their seed. `taskActivityFromEvent`/`taskActivityFromLogEntries` docs rewritten to the new doctrine (ruling dated, plan-phase narrative kept out). Wire additions stay capped (numbers, no new config, zero deps). Tests: fold pins for prompt-once (incl. legacy origin-less), injections still out, footer derivation equal to the session-side primitives on identical entries and literal expected values, absent/unattested usage = no item; relay pins for the `usage` frame gates; the settled-transcript engine fixture gained a post-reset input (epoch fold leads with it, the trimmed attempt's prompt stays out) and the RED fixture's leading user row re-pointed deliberately; `webui-chat` t9/t10 re-pointed for the seed block; `dom-helper/app.test.tsx` pins live usage finalizes at the boundary and at the flip, the settled replay lands the owner's exact footer string, the prompt opens once across open-fresh/settle-flip/re-view, and `streamReset` still retracts alongside the new kinds. `bun x tsc --noEmit` clean; `bun test --parallel` and one serial run: 11006 pass / 15 skip / 0 fail. No `mock.module`.

- **config - the `thinker` knob is retired.** The `{}` think-format template shipped broken, so the knob goes rather than limps on: thinking always prints in the built-in `[Thinking: ...]` shape and `hideThinking` remains the control. `--thinker`/`-t` are gone (unknown flags stay fatal, so a script passing them fails loudly, not quietly). A `thinker` or `thinkerFormat` key left in `defaults.json` is not fatal: the load warns once naming the tombstone and ignores the value, `hotdog rescue` reports the exact line with a caret, and the settings-panel write gate refuses to re-add the dead bytes.

- **webui - an idle or finished subagent now opens on its WHOLE transcript: the settled row's authority is the worker's durable log, and the client stops defending its stale cache.** The owner symptom (2026-11-15, workflow worker `think#1` of run 20261114-2155): a finished subagent showed only its last message. The server half of the seam was already right (`handleTaskActivityRequest` answers a settled id from `readSessionEntries` folded by `taskActivityFromLogEntries`); the defect was the CLIENT's cache authority -- `taskActivity` is a module-level Map that outlives every pane, `viewSubagent` requested only when `hasFedActivity` was false, and `seedTaskActivity` REFUSED a replay onto any buffer holding non-echo bytes (the reconnect-duplication guard). A watched worker therefore kept its relay tail (server ring 300 items, client 200 blocks) and served it forever: on that real log the fold is 402 items, so the cached tail was a fifth of the conversation. Fix, `src/extensions/webui/ui/chat.ts`: a module-level `settledTasks` ledger (cleared with the buffers in `clearTasks`) seeded from every `taskList` snapshot and kept in step by `taskUpdate` -- an id re-appearing live (an engine warm-retry re-uses its task id) leaves the ledger again, so the unsettled doctrine resumes byte-identically -- and `viewSubagent` now requests whenever the cache has nothing fed OR the row is settled (a settled row never paints from cache); the `taskUpdate` settle flip is the invalidation edge and re-reads when there is a stale view to make honest (this client holds a buffer for the id, or the pane is on it), which keeps a fan-out run from reading every worker's durable log for a browser that is not looking; `seedTaskActivity(taskId, history, force)` gains the settled `force` branch that REPLACES the buffer wholesale, un-trimmed by `MAX_ACTIVITY_BLOCKS` (that cap holds an unbounded live stream down; applying it to the durable fold would re-cut the head of the transcript the reply exists to fetch -- `MAX_TRACKED_TASKS` eviction still applies, block folding now shared through `appendActivityBlock`). Echo rule, decided and stated at the seam: client steering echoes need no rescue across a replace, because an echo exists only for a steer the server ACCEPTED (`taskControl ok`), an accepted follow-up is fed to the worker, and that write is the log's `input` record with origin `user` the fold returns as the `user` kind -- a refused steer was already taken out by `retractTaskEcho`; re-appending echoes would double the log's user lane and "keep echoes the log has not shown yet" needs a fuzzy text match that strands a phantom row forever, so wholesale replace is the only rule that is idempotent across socket replays (two identical replies, byte-identical buffer), and an EMPTY reply never paints over bytes we hold (the server's degradation for a missing/garbage/fold-to-nothing log). `handleTaskActivityRequest`'s degradation is now honest in code as well as doctrine: the read's RECORD count and the fold's ITEM count are different measures (the same real worker reads 537 records and folds 402 items), so "the epoch view holds records but no transcript lane" is logged as itself instead of hiding inside "no log", and the buffer's bytes stay. Server authority, wire shapes, the session log and the CLI are untouched; nothing new rides the socket. Tests: `dom-helper/app.test.tsx` gains live-tail cache + settle flip (exactly one request, the fold REPLACES the tail, the steering row exists once, a second terminal frame requests nothing more), settled-reopen refetches with a warm cache while a live reopen still asks for nothing (the byte-identical pin), the empty-reply and uncapped-205-item replace pins; `webui-chat.test.ts` pins the flip gate (cached-but-unviewed re-reads, unwatched settles cost zero, warm retry leaves the ledger) and the wholesale replace's idempotence; `websocket-finished-subagent-transcript.test.ts` pins the engine-task-shaped settled fold (agentSessionId present, a mid-log `reset` trims the dead attempt, first/last item + exact counts, and the reply equal to `taskActivityFromLogEntries(readSessionEntries(id))` -- parity with what the session cold view reads for that log) plus the honest fold-to-nothing / legitimately-tiny pair. No `mock.module`. `bun x tsc --noEmit` clean; `bun test --parallel` and one serial run: 10996 pass / 15 skip / 0 fail.

- **webui - the profile and model pills are searchable comboboxes: type to find an entry in a long list.** Both switchers leave the native `<select>` for ONE reusable component (`src/extensions/webui/ui/combobox.tsx`, zero deps, the custom JSX runtime): a borderless trigger chip wearing the pill's existing chip language (same height/hover/focus-within rules; the caret is a CSS chevron in `currentColor`, so hover's ink shift carries it and it adds nothing to the accessible name) opens a popup holding a text filter and a `role=listbox` option list, narrowed live by case-insensitive substring -- plain substring, no fuzzy, no virtualization, no config keys. While typing, the control keeps displaying the ACTUAL current value (a value the filter hides is still the value); Escape closes without changing it; ArrowUp/ArrowDown move a highlight (wrapping, the completion menu's grammar; the active row rides `aria-activedescendant` and scrolls nearest), Enter picks, an option mousedown picks (the completion-menu idiom: preventDefault before the filter can blur, and the options carry no click listener, so the trailing click cannot double-dispatch), mousedown outside closes clean, Tab dismisses and moves on. Keyboard end to end: ArrowDown/Enter/Space open, the popup hands the caret to the filter, focus returns to the trigger on close. The popup is ONE root-mounted overlay beside the session context menu and rides its stack exactly -- `position:fixed`, the 9999 tier, `clampMenuAnchor`, the outside-mousedown dismissal, the focus-return -- flipping above the trigger when the composer's viewport-bottom seat leaves no room below; no third stack. Semantics are the selects' own, byte for byte: a same-value pick dispatches NOTHING (the native change-event contract the old controls got for free; the current value even enters highlighted, so a bare Enter changes nothing), and a real change dispatches the EXACT handlers the selects' onchange called (`chat.switchProfile` / the `/model` slash command) -- no wire, server or config change. Consumers migrated 1:1: the `syncSelects` imperative value pin is gone because the trigger display is a plain atom render (server `profileSwitched` / `sessionState` pushes repaint it, pinned open and closed), the read-only dim rides unchanged, and the `selects-locked` subagent lock now lands `disabled` on the trigger BUTTON -- refuses mouse and keyboard open, closes a popup caught open when the lock engages, and gains the honest `:disabled` cursor handoff; the ids stay `#profile-select` / `#model-select` (now buttons; CSS and pins re-pointed deliberately). Removed CSS: the `#*-select option` paint (there are no options without a native list) and the id-level ellipsis pair (now `.combobox-value`); the stale "house precedent `#model-select`" native-select notes in the file viewer follow the truth. Tests: `dom-helper/app.test.tsx` grows a "profile / model comboboxes" section -- open (a11y flags, current row selected AND highlighted, caret in the filter, ArrowDown re-open), live case-insensitive filter with the value held, ArrowDown+Enter dispatching `switchProfile` exactly once with focus back and the display waiting on the server, highlight wrap + same-value Enter no-op, option mousedown riding `/model m2` exactly once with the trailing click inert, Escape lands on a NON-current highlight and never commits (mid-filter pinned with the highlight proven to be on the not-current option before the press), outside mousedown closes clean / inside does not, one popup app-wide, and the external-sync pins (its open-state Escape, zero wire after it, is the commit-guard's second face); the subagent section gains the locked-posture pin (refused open, a lock landing under an open popup closes it, wire silent); the old select pins re-pointed to trigger-button/display/popup shapes -- the retired empty-selection arm lands covered by the same-value no-op pin (the guard in the handler stays; an empty option is simply unpickable now). No mock.module. `bun x tsc --noEmit` clean; `bun test --parallel` and one serial run: 10988 pass / 15 skip / 0 fail.

- **webui - the live transcript says it is waiting, and shows a tool call while it is still streaming.** (1) One "Thinking" row at the foot of the chat log, above the composer: theme variables only, three dots on a staggered opacity cycle, `role=status` + `aria-live=polite` with the dots `aria-hidden` and the text written once, so a reader hears the word once per appearance and never per blink. It is a PER-MODEL-CALL tell, keyed off the existing per-session `working` state plus the composer's send click, and it retires the moment the call has anything visible on screen: streamed text, a committed response, a SHOWN reasoning block, or a tool call. With the per-browser hideThinking preference on, hidden reasoning renders nothing, so the row rides the whole reasoning phase; revealing it mid-call retires the row and hiding it again does not bring it back (one tell per call, no yo-yo on pref flips). It returns when a tool round closes and the next call has streamed nothing, follows the retry's `streamReset`, and dies on Stop, the error frame, `working:false` and any session switch or cold-log view -- browse mode swallows it through the existing `LOG_VIEW_SINK`, the subagent feed never arms it (that view gets no working edges), and a mid-turn attach trusts its replay burst instead of re-arming over already-visible bytes (the attach re-posts `working` after the burst). (2) Core's `tool_call_delta` finally rides the wire as one ADDITIVE frame-only S2C message, `streamingToolCall {sessionId, index, name, args}`. `args` is the ACCUMULATED partial, not an increment -- core already hands the whole partial to every delta, so the client REPLACES its preview and a redelivered frame is idempotent -- capped at `MAX_STREAMING_TOOL_CALL_ARGS_CHARS` (2000) with a `...[truncated]` tail, since an uncapped 200 KB write body would otherwise push tens of megabytes of preview. Its identity is `index`, the wire's tool-call slot, deliberately not the provider's tool-call id: mid-stream that id is often still empty, and where a provider never sends one core mints a UUID only after the response assembles, so an id could not pair preview to final frame. The `toolCall` frame thus claims the same-name preview first, then a still-nameless one (its name delta had not landed), and never a differently-named one -- the name-pairing doctrine the result pairing already follows. The preview wears the committed block's own posture plus the shared `.spinner` and a monospace args ceiling, then upgrades IN PLACE -- the same host node, emptied, posture classes dropped, `ToolBlockController` mounted -- so no duplicate block, no flicker-to-empty, and the existing id/name result pairing sees exactly what it saw before. Nothing persists or replays the new frame (old logs replay byte-identically), it appends nothing to the transcript so it never dirties the attach cursor, the CLI path is untouched, and the seam's protocol note in core (the `ToolCallDeltaEvent` docstring, which still said WebSocket drops the delta) is synced to match -- comment-only, no core behavior line moves. Tests: 25 new pins in `dom-helper/message-list.test.ts` (row lifecycle in both hideThinking directions, mid-turn attach, mid-run steer, retry-never-two-rows, Stop/error/working-false/clear/subagent-feed/cold-log; preview slots, replace-not-append, escaped bytes, in-place upgrade with pairing and footer order intact, same-name-then-nameless claiming, dead-preview death at round close), 4 in `dom-helper/chat.test.ts` (the send/Stop edges, frame routing, foreign-session drop, browse-mode sink), one cursor-stays-clean pin in `webui-chat.test.ts`, and the channel's frame-only pin rewritten (QUEUE_UPDATE still dropped, the delta now maps to the exact frame) beside a cap pin. Zero deps, zero new colors, zero config keys. `bun x tsc --noEmit` clean; `bun test --parallel` and one serial run: 10980 pass / 15 skip / 0 fail.

- **webui - the docked workspace tree resizes in chat mode too.** The border between the tree column and the file viewer now carries a drag handle in both layouts -- drag, arrow-key steps, double-click to reset, like the other seams. Its width is capped by the dock, so widening the tree can never squeeze the file viewer out of the pane, and the one stored width applies to both layouts.

- **webui - workbench: a docked, resizable, tabbed column beside the chat** holding a workspace file tree and a read-only file viewer. The tree reaches only your configured workspace roots, denylisted paths never even list, and the viewer is text-only and page-bounded, so large files resume exactly where the last page left off. Open tabs, the active tab, and expanded directories restore across reloads per browser tab; every pane border drags, and the sidebar and Recent Logs panels collapse and remember their sizes.

- **syntax - code is colored everywhere you read it.** The webui file viewer, chat tool blocks, and markdown fences now highlight about forty languages: JavaScript/TypeScript (incl. JSX/TSX), Python, Rust, Go, C/C++/C#/Java/Kotlin/Swift/Zig, Ruby, PHP, Dart, Elixir, Erlang, Groovy, shell, SQL, Make, Dockerfile, TOML/INI, YAML, JSON, XML/HTML/CSS/SCSS, GraphQL, Lua, Nix, HCL, Protobuf, CMake, Crystal, Diff, and env/gitignore files. The viewer's foot bar names the detected language and clicking it lets you override the guess; files open with the first 2,000 lines instead of 200. The interactive CLI colors assistant prose too -- headings, emphasis, inline code, and fenced blocks with shell/yaml sub-highlighting (`uiInteractiveCli.markdown: false` turns it off).

- **webui - editor mode layout.** One header control swaps the workspace between the chat layout and an editor layout where the file tree and viewer take the stage and the sessions rail moves into the right dock beside the chat. Flipping is instant and lossless -- transcript, composer draft, and open tabs ride through -- and the mode plus every pane width is remembered per browser. Desktop only. (File viewer is still read-only, the editor itself is coming later.)

- **webui - settings panel: read and edit every setting from the browser.** The header gear opens a live snapshot of the running config: each key's value, where it came from (file / env / cli), a differs-from-default marker, and per-file diagnostics with a pointer to `hotdog rescue fix`. Every setting is editable -- toggles, number steppers, enum dropdowns, long-text areas, provider cards you can add to and remove from -- and edits save immediately. Secrets (API keys, env secret slots) never travel to the browser, even on the way back in: they get replace-only boxes and the server never echoes any secret value. Saves are surgical text edits to your config file: comments, formatting, and every untouched key survive byte for byte. Keys still shown as read-only mean what they say and point you at the file.

- **config - most settings now apply without a restart.** A panel save re-resolves the configuration and re-arms the running process: the webui port rebinds (brief socket drop, announced first), the auth middleware rebuilds with issued sessions and lockout state carried over, tool-approval (`userGate`) rules recompile, the provider list and speech-to-text target re-point, and the exec-fence posture applies to sessions spawned after the write. Keys that genuinely need a restart say so in the save reply and in a restart-pending banner. Every change lands as a redacted audit line in the log and a system notice on live sessions, so a config edit never happens invisibly.

- **config - keys that were silently ignored now work; two dead ones retired.** `maxRetries`, `toolRetryDelay`, and `taskProfile` are finally read from `defaults.json` -- a file entry for them used to fall through to the schema default. `logLevel` and `logTarget` move from env-only to real config keys, so `"logTarget": "none"` silences stderr from the first boot line. `temperature` and `prompt` are removed: nothing ever read them (temperature lives in `providers[].temperature`), files carrying them now get a named verdict from `hotdog rescue` instead of an unknown-key guess, and the settings write gates refuse them.

- **rescue - `hotdog rescue fix` repairs invalid enum values.** A `"logLevel": "verbos"` typo used to hard-fail boot with no path out but manual editing. Rescue now reports the offending key with line/column, the shipped value, and the accepted set, and `fix` resets it to the schema default (or removes the key when it has no default) while preserving comments, formatting, and every other byte. The boot error names the repair command.

- **webui - subagents live in the sidebar.** Each manager card carries a collapsible Subagents list with status glyphs, step labels, and an elapsed clock. Clicking a row opens that subagent's full transcript in the main pane, rendered like any session -- read-file boxes, inline edit diffs, bash blocks -- and the composer steers the running subagent. The row menu handles cancel, copy task id, export, copy log file path, and reveal run directory. After a browser reload a finished subagent replays its whole transcript from its session log, not just the last message. (Retires the old task-panel overlay.)

- **webui - themes and honest icon chrome.** A header switcher moves between the new default "hotdog" palette (warm mustard) and classic purple; the choice applies before first paint, so reloads never flash the wrong theme. Header actions are clean SVG icons now -- and they actually render: a namespace bug had silently hidden every inline icon mounted through the JSX runtime. The sandbox chip reads at a glance: check-shield = confined, red = fence off, amber = probe failed, plain = degraded or unknown. The reasoning toggle is a thought bubble that fills with text lines when reasoning is shown.

- **webui - keyboard and screen-reader access.** Sidebar rows, their context menus, and the settings panel are operable without a mouse (arrows, Enter/Space, Menu key/Shift+F10, focus returned where it belongs), the composer is no longer a focus trap, and a polite live region announces the run: "Working", then "Reply complete" / "Run failed" / "Work stopped" / "Connection lost" -- never a streamed token.

- **webui - steering is always on and disconnection is visible.** The Steer checkbox is gone; every message ships steered. A Disconnected badge appears beside send only when the socket is actually down.

- **cli - you see what the agent is doing by default.** Tool calls and results print in fresh sessions (`hideTools` default flipped; `/tools` still toggles, `hideTools: true` or `--hide-tools` opts out). Edit/append/overwrite calls render a bounded colored diff, and the approval prompt shows that same diff before you answer, so you approve what you can read. Provider retries are visible on every surface too: one line before each backoff sleep (`Provider error, retrying in 3s (attempt 2/4): ...`) and a marker where a dead stream's bytes will be reprinted.

- **core - the status row's `#N` is now an address.** `/rewind` and `/fork` take a visible-message index: `/fork #5` cuts through message 5, `/rewind -2` goes back two, bare `/rewind` is `-1`. Nothing -- tool call, tool result, harness notice -- dangles past the cut, and an out-of-range target names the valid range instead of changing anything.

- **llm - `delta.reasoning` streams too.** Routers that echo `reasoning` instead of `reasoning_content` (the vLLM/Ollama family) produced invisible thinking; both spellings parse now, `reasoning_content` keeping precedence.

- **tasks - cancelled means cancelled, and results arrive as content.** Killing a workflow worker through its task (interrupt / cancel / session-delete) settles the node CANCELLED instead of logging a failure and respawning a fresh worker to burn tokens on work you just stopped. A subagent turn that ends on a stop tool (handoff and friends) delivers that tool's actual content to its manager instead of the bare word "return". The `wait` tool's result no longer duplicates itself in a `META:` line.

- **core - the sandboxed tool runner loads only what it's told to.** The pooled runner boots with zero extension code inside the fence; the supervisor ships tool descriptors to each broker and the runner imports exactly what a descriptor names, refusing any module outside the project root. Operator note: the pool's tool set is fixed at daemon start, so adding an extension needs a restart.

- **extensions - the published API is four doors: `@read-receipt/hotdog`, `/sdk`, `/utils/*`, `/testing`.** The package `exports` map pins the surface: the root hands embedders the host primitives, `/sdk` is the extension-authoring contract (import it by package name in a clone, via `bun link`, or from an installed project), `/utils/*` publishes the zero-dep utilities, and the new `/testing` kit -- a minimal core double, question-seam fakes, payload builders -- lets an external bundle boot its extension in `bun test` with zero deep imports. Everything else under `src/` is internal and moves freely between minors.

- **extensions - version ranges, a validator, two worked examples.** `extension.json` gained an optional `"sdk": ">=0.16"` claim: a mismatch warns at load, a malformed range fails only that extension. `hotdog extension validate <dir>` diagnoses one extension or a whole bundle -- manifest errors with line/column, the sdk-range verdict, entry point, config defaults, service contracts, and a dry-load that reports the tools it registers -- and it works even when your `defaults.json` is broken. An `extensionPaths` entry may now name a single extension directory, not just a bundle root. New examples: `extension-starter` (a minimal tool extension, booted in CI) and `extension-redactor` (a hook-only gate that asks the human before a secret reaches the model).

- **tools - domain tags.** Tools can declare domain tags (`files`, `network`, `system`, ...), and `/tools list` prints them.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.16.0...main

## [v0.16.0] - 2026-11-06

- **webui** - redesigned sidebar, expanded sesson list right click actions, server-persisted pinned sessions, tool call displays, diffs, added assistant message footers with metadata and other elements

- **core - session titles**, derived from user messages with no LLM call (can be overwritten by Renaming the session)

- webui - fixed /help

- **agent-browser (`@experimental`)** `agent_browser` tool over Bun.WebView that drives chrome/chromium/webkit instance for full browser use.

- **macOS now officially supported.** macOS gets an OS-enforced tool-exec fence (seatbelt). On darwin the fence is `sandbox-exec` with a deny-default profile: rw only on the session's realpath'd roots plus scratch.

- fence - runtime per-session policy toggle: `/fence` + webui header. `/fence on|off|status` changes the calling session's exec-fence posture without a restart. The override applies at plan time per session, every change is a logged transcript notice.

- **workflows - manager control tools: `workflow_followup` + `workflow_control`.** `workflow_followup` steers a RUNNING node's worker. `workflow_control` skips/resumes/cancels runs.

- **core - one char cap on every tool result: `maxToolResultChars`.** Replaces the `bashTool`/`coreTools` `maxToolOutputLines` knobs: one core-bound (default 1M chars, max 2M, 0 disables) enforced at the executor seam before metrics, the session log, context, and the wire ever see a result; over-cap text keeps a grapheme-safe prefix plus a `--- [output truncated, N chars elided] ---` marker.

- **edit tool - an ambiguous multi-match is refused instead of editing the first.** With `replace_all: false`, an `oldString` matching several places "succeeded" while silently editing only the first occurrence; it now fails with the exact match count and line numbers, file untouched.

- **loop-detect - a loop is now same call AND same output.** The signature gains a bounded result fingerprint, so legitimate progress, polling a command whose output changes or identical-args retries of a flaky test, no longer escalates to run-cancel. Identical args and identical output still walks the full nudge → nudge → cancel ladder; a genuinely stuck loop whose environment emits fresh output (`date`) is now indistinguishable from polling and no longer fires.

- **approvals: closed inline-code and wrapper bypasses in bash triage.** `node --print`/`-p`/`-pe` and perl/ruby bundled code flags (`perl -le`, `-ane`, `ruby -ne`, `--eval`) now parse as code, and wrappers (`nohup`, `time`, `command`, `exec`, `sudo`, `doas`, `nice`, `setsid`, `timeout`, `stdbuf`, `watch`, `parallel`) always bail -- previously `nohup perl -e 'system(q/id/)'` read as a clean `nohup`, so an allow that covered the wrapper admitted the payload inside it.

- **tool-exec - the frame wire is capped at 4 MB.** One newline-free line on runner stdout (the defined adversary's channel) used to grow the decoder until it OOMed the broker child; overflow now answers as executor death through the existing vocabulary: pool entry killed, every pending call gets the executor-died contract, the next call respawns fresh.

- **mcp-client - stuck servers get SIGKILL; `tools/list` pagination is bounded.** `destroy()` escalates SIGTERM to SIGKILL after a 2 s grace (a detached server that traps SIGTERM used to survive shutdown unreaped); a constant or oscillating `nextCursor` can no longer loop discovery forever (repeat-cursor set, 100-page cap, 1000-tool cap), and a failed init/discovery tears down the just-spawned transport instead of orphaning it.

- **llm-client - a gateway answering `stream: true` with a plain JSON body no longer yields empty turns.** The JSON fallback read only `choice.delta`, so content, reasoning, and tool calls were all dropped and the agent burned its full empty-retry budget misdiagnosing a protocol quirk as a model problem; the payload now falls back to `choice.message`.

- **core - three silent corruptions stopped (SSE poisoning, id divergence, lost rewinds).** A malformed `data:` line no longer poisons the SSE json buffer for the rest of the stream (it flushes-or-drops at the event boundary); a non-string or empty tool-call id is replaced with a fresh uuid at assembly, so a live-wire call can't become an unrepairable 400 on resume; and rewind checkpoints fsync the block's last record, so a power loss can no longer keep kept-history lines while losing the RESET (undone history resurrected).

- **core - the retry path honors cancellation; stream resets reach every sink.** Esc mid-attempt can no longer fire fresh HTTP on a `retry:true` provider-error verdict, and a mid-stream reset now clears the dead attempt's partial text everywhere (CLI, subagent activity panel, webui via a new `streamReset` frame), not just the internal assembly buffers.

- **session-log - restore replays no longer re-append usage history.** Every adoption (restart-resume, `loadLog`, reconnect) re-emitted the epoch's entire `token_usage` rows at EOF, doubling duplicates per restart -- which is why duplicated end-of-chat bubbles survived server restarts; the writer guard now early-returns before any write. Growth stops; damage already in old logs stays (history is append-only).

- **webui - the composer survives a reload, and attachments can be dropped or pasted.** Half-typed prompts persist to localStorage (debounced, flushed on unload, restored on mount without clobbering, never resurrecting a sent message); drag-and-dropped or clipboard-pasted files/images become attachments, and pending attachments persist alongside the draft (server re-validates on send regardless).

- **webui - browser sessions tell the model links are clickable.** When the webui is actually serving, a one-line system-prompt note states that responses render markdown to html; CLI prompts stay byte-identical.

- **webui-auth - `/login` gets a request-body cap and the throttle becomes a barrier** (concurrent attempts can no longer race through the same bucket).

- **extensions/rescue - custom `extensionPaths` load; documented config keys are accepted.** Bare relative extension specs resolved against the project root instead of ENOENTing out of `src/core/extensions/`, and `rescue` no longer false-flags `services`, `envScrub`, and `skillsPath` as UNKNOWN -- a new lint scans the config reference against rescue's verdict so the drift class dies, not just these instances.

- **tool-call-repair - length-truncated calls can no longer brick a session.** A `finish_reason=length` refusal now sanitizes any call whose truncated `arguments` fail `JSON.parse` to `"{}"` before the refusal round persists, so strict gateways that re-parse stored history accept the replay instead of answering every later request with `400 invalid_messages`; and the `provider:error` recovery matcher learned the gateway phrasing (`"tool arguments are not valid JSON"` / an unterminated-string JSON error naming a tool call), so already-bricked sessions strip the corrupt calls and retry instead of looping on the 400.

- **compaction - the trigger trusts provider usage, not just the local estimate.** The chars/4 heuristic UNDERcounts dense code (~3.2 real chars/token), so a session could sit at 100% of the window with the estimate still under the gate -- the window then died mid-tool-call with `finish_reason=length` before compaction ever fired. The CONTEXT trigger now also compacts when the provider's reported prompt size for the last call (net + cached) exceeds the budget, with the estimate kept as the pre-first-call signal.

- webui - sidebar now resizable

- **webui - `trustedProxy` knob for the login throttle.** Behind the recommended TLS reverse proxy the login rate limiter keyed on the proxy's IP, so every user shared one bucket and a single probing client could escalate the lockout ladder (up to the 24h cap) for everyone; an `x-forwarded-for` seen with no proxy configured now logs a one-time warning, and the non-loopback bind warning names the consequence. Set `webui.trustedProxy` to the proxy's IP or CIDR and the header is believed only from that peer, resolving the client by scanning right-to-left for the first untrusted hop; a header from any other peer is ignored (fails safe: coarse bucket, never spoof-driven bypass). Malformed values fail startup.

- **webui - reasoning visibility** a per-browser preference with a header toggle button.

- **session log - tool-result images persist as the TOOL_RESULT entry's images sidecar.** The executor stores a tool's images on `Message.images`, never in content parts, so the writer dropped them: an image shown live was gone on every rebuild path. `messageToLogEntry` now carries a non-empty `Message.images` onto the entry (gated to the TOOL_RESULT source), and all three rebuild paths -- replay slice, browsed-log mapping, in-memory history replay -- carry it through `wireImages`, the one egress cap (over-cap stored bytes come back as skipped+note, the frame survives). Imageless writes omit the key entirely (old logs byte-identical); display persistence only -- a stored image never rides a rebuilt provider-context message, and base64 stays out of the search corpus and the index mirror.

- **llm-client - model reasoning is mangled on replay like everything else.** A model-authored `reasoning_content` echoed back through the serialize gate carried real protected markers onto the wire on replay; it now goes through the same trust-resolved mangler as content and tool_calls.

- **prompts - directory scan sorted; name collisions resolve deterministically.** `readdir` order is filesystem-dependent, which made same-name prompt resolution a filesystem lottery between hosts; the scan now sorts by name, so the same prompt wins everywhere.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.15.1...v0.16.0

## [v0.15.1] - 2026-10-27

- interactive cli - foreground interactive programs called in shellMode handle input/output better, no longer eats half the keypresses and renders strangely.

- **provider:response - `refuseToolCalls` patch.** A handler can now make core refuse every tool call in a response: each call is paired with a tool result carrying the refusal's `reason` without executing, an optional `trailingNotice` persists after them as a harness system-notice, and the loop continues. The length-truncated refusal moved from the agent loop into `tool-call-repair`. With `toolCallRepair.enabled: false` a length-stopped call is no longer refused and fails schema validation generically.

- **config - schema `minimum` bounds** A schema property can declare `"minimum"`; the bound applies to every resolution layer, and a violating value is treated like a failed cast (fall through to the next layer, then the default). Config-file violations are a hard startup error via config validation; CLI/env values fall through silently, so one bad number can no longer override a sane default. Fields now bounded:

  - `uploadLimits.maxFileSize` / `maxImageSize` / `maxFiles` -- min `0` (0 = reject-all posture; negatives rejected every upload)
  - `maxIterations` -- min `1` (0 reads as "unlimited" but actually ended the run at the wrap-up call)
  - `maxToolCallsPerIteration` -- min `0` (0 = no tools)
  - `contextLimit` -- min `1` (0 poisons the compaction math)
  - `maxEmptyRetries` -- min `0` (0 = no retries)
  - `bashTool.bashTimeoutMs` -- min `1` (0 arms a ~1ms kill timer via the timeout clamp)
  - `bashTool.maxTimeoutMs` / `maxToolOutputLines` -- min `0` (falsy "cap disabled" / suppress-all stay legal)
  - `coreTools.readToolLimit` / `maxImageSize` / `findMaxResults` / `grepMaxResults` / `maxEditInputSize` / `maxToolOutputLines` -- min `0`

  `taskLanesPerProvider` is deliberately unbounded: below 1 means unlimited.

- **config - root `uploadLimits` key.** The upload size ceilings (`maxFileSize` / `maxImageSize` / `maxFiles`) moved from `fileAttachment.*` to a core root key, so the upload posture resolves with or without the `file-attachment` / `websocket` / `webui` extensions enabled and every consumer reads the same resolved numbers. The old `fileAttachment.*` keys keep working as deprecated aliases (root wins when both are set).

- **mcp-client - `elicitation/create` now asks instead of failing.** A stdio MCP server's mid-tool-call request (payment confirmations, credential prompts, out-of-band approvals) now uses the same path the question tool uses: a held elicitation re-presents after a restart exactly like a question-tool call and the answer lands as that call's real tool result. Interrupting answers `cancel`; nobody available to answer answers `decline`.

- **web-search - DDG captcha challenges are relayed to user.** When DuckDuckGo's anomaly detection fires, the challenge reaches a human: a tile-solve page mounted on the webui's existing port or inline tile URLs plus a `tiles="3,5,6"` argument in the text-only CLI; the next search relays the picks and retries. The pass is IP-bound, so the answer has to originate from the challenged host.

- **config - booting with a dead provider is faster and quieter.** `/v1/models` fetch failures surface as one clean typed error line instead of a stack dump per reason, `info` / `profiles` / `show-prompt` build config once per invocation instead of rebuilding (and re-probing) per subcommand, and the model registry probes providers in parallel -- one timeout burned, not N.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.15.0...v0.15.1

## [v0.15.0] - 2026-10-26

- [BRK] **config - `./config` auto-discovery removed (security).** The config resolution no longer reads the current working directory: a cloned repo shipping `config/defaults.json` silently owned the session -- repo-set `extensionPaths` load third-party code at startup, repo-set provider URLs redirect conversations and the API key. Chain is now CLI `--config-dir` > `HOTDOG_CONFIG_DIR` > `/etc/hotdog` > `~/.config/hotdog` > bundled example. Explicit opt-in is still available (`hotdog --config-dir config`, `HOTDOG_CONFIG_DIR=./config`), and unflagged resolution in a directory that has `config/` warns once, naming the skipped directory. Side effect: a stray `config/` directory can no longer shadow your global config either.

- **edit tool** - a miss now reports the nearest region and the first divergent line.

- bugfix - steering during the final response's streaming no longer drops the message.

- **websocket - loopback set widened.** now accepts the whole `127.0.0.0/8` range and every `*.localhost` name, not just `127.0.0.1`/`localhost`/`::1` -- browsing the webui at `http://app.localhost:PORT` or `127.0.0.2:PORT` was refused as cross-origin. Suffix-bounded, so `evil.localhost.attacker.tld` stays foreign. `LOOPBACK_HOSTS` became `isLoopbackHost()` in `websocket/origin.ts`.

- **interactive-cli** - explicit manual /redraw -- try re-drawing in case the output goes weird

- **skills** -  mid-run /skill activation steers instead of appending to context mid-await

- **tool-call-repair** - block and guide for hallucinated QFN proxy urls

- **rescue `--json` envelope.** Fatal-config guidance stays off stdout so the envelope stays parseable.

- **cli - usage errors exit 2**, and rejected argv echoes back spoof-safe.

- **tokens - context-window fill gauge** against the model's `contextLimit`.

- **sessions cleanup/delete - reclaim leaked baton mirrors** (paired plus age-gated orphans).

- **fuzz suites.** added fuzz suites covering SSE framing, stream-processor deltas, session-log and workflow-journal replay, MCP stdio framing, spoof neutralization, workspace path policy, gitignore, brace expansion, html-to-markdown, the tool-call repair grammar, the JSON-Schema validator, wire-format-xml, rescue/jsonc, output truncation, the fetch SSRF guard, renderer input parsing and widths, tool diffs, json-lines, and CLI arg parsing. The fixes below came out of this sweep.

- **fetch - SSRF guard tightened.** Private-address refusal now covers IPv4 multicast `224.0.0.0/4` (`239.255.255.250` and friends read as public before), the translator-local `::ffff:0:0/96` prefix (`http://[::ffff:0:127.0.0.1]/` serializes to `::ffff:0:7f00:1`, which walked past the old check), and the deprecated IPv4-compatible IPv6 form (`[::127.0.0.1]` serializes as `::7f00:1` and is now unwrapped and re-checked as v4).

- **gitignore** - a crafted `.gitignore` can no longer hang hotdog. patterns with several `*` runs (`*a*a*a*a*a*b`) backtracked exponentially -- seconds on a 200-char path, never for ten-plus stars. The rewrite also better aligns git: `/build` no longer matches a nested `build`, `a/**` matches work as expected, and malformed classes like `[z-a]` never match instead of throwing out of `new RegExp`.

- **context repair - unmatchable tool_calls are stripped.** A tool call with an empty id, a duplicate id, or a non-object entry can never legally receive a tool result; repair drops them before the pairing walk instead of leaving a dangling call that 400s the provider request.

- **workflows - garbage journals are tolerated.** Scalar and torn lines in `run.jsonl` are inert noise for resume and interruption scans instead of crashing them.

- **md-parser - adversarial nesting capped** and inline scans linearized, so pathological markdown from a fetched page or model output cannot stall the renderer.

- **session-index - quarantine gates on corruption codes** and self-heals mid-run instead of quarantining on anything unexpected.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.14.0...v0.15.0

## [v0.14.0] - 2026-10-22

- **interactive-cli - Enter steers mid-run.** A submitted line while the agent is running is injected as steering -- delivered before the model's next call instead of waiting for the turn to end -- and a still-undelivered submission shows a `↑ queued: ...` chip row in the frame. The frame's top row is now a status line: turn count with state (`#3 · working`, `#3 · waiting for lane`), plus a cost suffix only when `modelPricing` covers the session model. Esc/Ctrl-C interrupt, Ctrl-D on an empty buffer quits. On legacy, mid-run submissions still queue and no status/chip rows appear.

- **interactive-cli - split renderer is now the default.** The managed bottom-region renderer -- streaming text and in-flight tool calls painted live above the prompt, transcript rows committing into native scrollback so they stay and scroll -- now mounts by default in interactive sessions. The gates are unchanged: both stdin and stdout must be TTYs and `TERM` must not be `dumb`, so piped, redirected, and CI output is byte-identical to before regardless of the knob. `uiInteractiveCli.renderer: "legacy"` stays the kill-switch and rolls back exactly, with no globals touched.

- **split sessions run on a hand-rolled raw-mode editor.** `node:readline` is gone from the split path (legacy only). Partial escape sequences reassemble, so a fragmented arrow key can never masquerade as an Esc interrupt; history, kill-line, and the completion popup live in the frame; an interrupted input parks in a draft slot instead of vanishing. A crash now runs the full teardown -- terminal restored, error reported, non-zero exit -- instead of leaving the shell in raw mode.

- **tool-call lines no longer print raw JSON.** Calls render human-readable summaries everywhere: single-key args bare the value, multi-key args read `key: value · ...`, multi-line values collapse to `N lines, M chars`, and unparseable model input passes through so you see what it sent. MCP passthrough calls summarize the same way. Tools can declare per-parameter display policy (`argDisplay`: first-line preview with size stub, shell-syntax highlighting) instead of sinks hardcoding tool names -- bash's command preview and coloring are its declaration now.

- **Tool-call colors live in the palette.** `arg_key`, `shell_command`, `shell_operator`, and `arg_separator` resolve through `ColorPalette` like every other knob -- tunable from a theme file or the `colors` config, and `monochrome` no longer leaks hues. Dark defaults retuned (light-cyan commands, dim operators); light themes get a blue accent. Glued operators arm the next command too (`echo hi; ls` highlights `ls`), and only the command value gets the shell pass -- summary labels and size stubs stay plain.

- **Tab completes unique matches in place.** When Tab resolves to exactly one candidate -- the full list, the prefix-filtered matches, or a deferred provider reply -- it writes straight into the buffer instead of popping a one-row popup you Enter away. Multi-candidate behavior is unchanged (popup, Tab/Shift-Tab/Up/Down cycle, Enter accepts), and `data` / `data/` from different completers count as one directory candidate.

- **Session logs record the system prompt.** The built prompt is appended as an audit row at the first turn, and re-recorded whenever it actually changes mid-session (a `/model` switch, a prompt rebuild). Replay still regenerates it dynamically, so resume behavior is unchanged, and `hotdog review <session>` now prints its `[SYSTEM]` section.

- **webui tool-call headers reuse the terminal's arg summary.** The wire carries the same ANSI-free `argsSummary` the CLI prints, live and in log replay, so a multi-line bash call shows `git status… (2 lines, 431 chars)` instead of a raw wall of text.

- **Restart durability for workflows and tasks.** A process kill used to orphan in-flight work silently. Workflow runs whose journal has no terminal event are now marked interrupted on disk and listed by `workflow_status` with a re-dispatch hint (`workflow list` names them too); `plan_status` and `task_status` answer "interrupted by restart" for delegated tasks that never ended. Nothing auto-resumes -- resuming stays a human decision.

- **Workflow runtime timeouts are opt-in (`workflows.enableRuntimeTimeouts`, default off).** The runtime-cap kill was taking down near-complete workers, and the kill is terminal: it fails the node immediately and skips the rest of its retry ladder. `workflow_validate` still validates `maxRuntimeMins`, so graphs stay portable for when the toggle is on.

- webui - security - spoof-safe markdown render


**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.13.0...v0.14.0

## [v0.13.0] - 2026-10-20

- `$HOTDOG_DATA_DIR` (`<data>`) can be set to change where sessions/workflows/temp data is saved. defaults to ~/.cache/hotdog/

- [BRK] workflows directory moved to `<data>/workflows`
- [BRK] task-lanes directory moved to `<data>/task-lanes`
- **Auto-migration at startup.** The first run after upgrading moves a `workflows/` / `task-lanes/` dir found at the old sessions-dir location into the data dir (copy+delete across filesystems, e.g. `HOTDOG_SESSIONS_DIR` on tmpfs). If BOTH the old and new location exist, nothing is merged or deleted -- a warn names both paths and the new location wins, so a pre-upgrade process (webui daemon) is never cut out from under. Set `workflows.path` / `taskLanesDir` explicitly to keep data wherever it is.

- **split renderer kill-switch (`uiInteractiveCli.renderer`).** New `legacy` | `split` knob (default `legacy`, byte-identical to today) gates the stage-2 split-region terminal renderer in the interactive CLI: under `split`, transcript rows commit into native scrollback, readline paints into a managed frame, and diagnostics/stderr writes are arbitrated instead of fragmenting the frame. The renderer only mounts when stdin *and* stdout are TTYs; piped or redirected sessions always take the legacy path. Set `{"uiInteractiveCli": {"renderer": "split"}}` to try it; `legacy` rolls back with no residual global patches.
- **opt-in cost display (`modelPricing`).** A local model-name -> per-million-token rate table (`input` / `cachedInput` / `output`, `cachedInput` defaulting to 0 like the tracker's free-cache house model) adds a `cost:` line to `/tokens`, for the session and the last call. Display-only: no session-log records, no network fetch. Unset key = byte-identical display; a configured table with no entry for the session model says the model is unpriced instead of guessing.
- **model setter is a no-op on the same value.** `agent.model = <current model>` no longer fires `MODEL_CHANGE` or rebuilds caches, so every resume stopped writing a redundant model-change record into its own log. Real switches behave exactly as before.

- **baton stash is per-session.** The popped tail mirrored by `pass-the-baton` now lands in `<sessionsDir>/<session-id>.baton.json` instead of a shared `baton-popped.json`, so two sessions popping at once can no longer clobber each other's stash.
- **baton stash cleanup and id guard.** Abandoned batons (cancelled/errored turn, context rewritten, missing continuation seam, failed handoff) now unlink their `<session-id>.baton.json` mirror instead of leaving it behind; the mirror is only written when the session id passes the same traversal guard as the session logs (`isSafeSessionId` in `session-log.ts`), and an unsafe id degrades to the in-process stash only.

- **Tool exec plane ships on again.** `toolExec` default returns to `worker`. The crash behind the v0.12.1 rollback was the executor mount plan mishandling a `/`-mounted scenario; fixed in `exec-plan.ts` with regression tests.

- [BRK] dropped the dead `webui.maxAgeSecs` config key (no consumers since the run-3 housekeeping work); a config that still sets it now fails startup validation ("additional property not allowed") -- delete the key.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.12.1...v0.13.0

## [v0.12.1] - 2026-10-18

- set tool exec plane default to prior behavior, "inline", due to discovered tool crash that will be fixed in next release.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.12.0...v0.12.1

## [v0.12.0] - 2026-10-18

- [BRK] dropped support for bun older than 1.4.2.

- [BRK] the task-lanes ledger moved to `<sessionsDir>/task-lanes` (was `<configDir>/task-lanes`). The slot files are ephemeral, so the old dir can just go; only matters if you shared the ledger across machines via a mounted config dir -- share the sessions dir instead. An explicit `taskLanesDir` still wins.

- **speech-to-text input.** Dictation in the webui (mic button) and the interactive CLI, against any OpenAI-compatible audio transcriptions endpoint -- `sttUrl`/`sttModel` or an auto-picked audio model.

- **compaction: `pass-the-baton` is the new default -- no more summarization call.** The summarization request was the biggest a session makes (re-ships the entire conversation) and its output invalidated the prefix cache for the next one; on local runners compactions took ten minutes or timed out. Now the newest messages pop off, the model is told to wrap up and hand off, and the session continues on its own handoff summary with the popped tail re-appended verbatim. Kept context stays byte-identical, so the prompt cache keeps serving. Context-overflow errors from llama.cpp/Ollama/LM Studio/vLLM rescue through the same path. Keep the old behavior with `/compact summarize` or `compaction.strategy`.

- **session durability: crash, restart, continue.** The session log (protocol v2) now fsyncs records around every tool call, question, and turn: on resume, an interrupted tool call reads as *started* (outcome unknown -- verify before retrying, never blind-retried) or *never-started* (safe to retry); a pending question re-presents in the CLI and the webui; a turn that was mid-flight auto-resumes as a continuation turn. Five consecutive auto-resumes with no progress park the session -- only a manual resume brings it back, so a crash loop can't thrash. A disposable `sessions.sqlite` index (rebuilt from the logs by a directory sweep) backs the sidebar state. The webui re-attaches to *your* session with a replay cursor -- delta when it's safe, full replay when not, never a duplicate or a gap -- and the server drains in-flight turns to their commit point on SIGTERM. v1 logs still load, but their tails never auto-resume.

- **tool exec plane: out-of-process executors with a bubblewrap fence.** Tagged tools (`bash`, `read`, `grep`) run on a worker plane inside a bwrap jail when the platform provides one: fresh tmpfs, read-only system dirs, writable only the session's workspace roots plus a private scratch -- no `$HOME`, no hotdog config, no sibling sessions; the harness checkout rides the jail read-only (its `.git` is readable, writable only in a repo-rooted session). `execFence` defaults to `probe`; `hotdog info` reports the posture. Cancelling a run now kills the whole process group, a dead executor reports `[tool-exec crashed]` and re-fills, a broker respawns up to a cap and then shows degraded in `hotdog info` and the webui header, idle entries reap after 5 minutes, and the `envScrubbing` opt-out finally reaches the plane.

- **tool calls carry their semantic header everywhere.** The CLI prints each tool's display line instead of raw args JSON, and webui tool blocks render the header with the args behind a collapsed pretty/raw toggle -- edit calls render as a diff. `bun run preview` renders the real components into a standalone page for design review.

- **webui subagents, overhauled.** Chips show a one-line step label with a status glyph instead of a wrapped id plus badge, bounded at two rows with the rest behind a "+N" chip; steering is wired up; panels mount as their own render subtree with one flush per animation frame, so streamed tokens no longer re-render the whole page; the feed is session-scoped with buffered replay on reconnect, and reasoning deltas get their own dimmed lane. Elapsed clocks count active turn time, not wall time.

- **session resume restores profile and model.** Interactive, one-shot, and webui replay on the profile the session ended on -- a cold resume no longer rebuilds on `default`, and switching profile doesn't clear it.

- webui session turns now queue on the provider lane -- two live sessions wait their turn instead of hammering one backend.

- fix bash approval bypasses: inline-code flags now bail when bundled or glued (`bash -lc '...'`, `python -c'...'`), and path *deny* rules match bare filenames (`rm secrets.env`) resolved against the segment's `cd`-tracked base.

- fix forgeable file-watch notices (experimental, opt-in): file names could spell a wire tag in the harness-trust `system-notice`. Interpolated paths now go through a shared `sanitizeNoticeText`.

- fix mid-run `/model` switch leaving the rest of the turn without a system prompt.

- an explicit `--config-dir` / `HOTDOG_CONFIG_DIR` that does not exist now fails at startup instead of silently falling through to built-in defaults.

- fix subagent hangs around the `question` tool: the provider lane is released while waiting; interrupts and `task_followup` while a worker sits in a question now settle; stale pending questions outliving their task get cancelled.

- webui misc: activity panel rebind no longer orphans its previous mount; numbered loose lists and cold-session-view rendering fixed.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.11.3...v0.12.0

## [v0.11.3] - 2026-10-07

- **question tool - a pending question survives a tab refresh.** A `question` blocked when the webui reconnects now re-renders its card after history instead of hanging with no UI to answer. Replay moved from the SessionManager's QUESTION-event buffer to the question bridge itself: on attach or session switch the server peeks the live pending question.

- **webui - `wss://` on https pages.** The chat socket URL hardcoded `ws://`, which browsers block as mixed content on an https page.

- webui - dropped the pulsing glow on the connection indicator

- **evals** - added independent evals runner and a first easy series `kielbasa-1`

- **webui - attachments render inside the user bubble.** @-ref uploads echoed as an extra `SYSTEM_MESSAGE` per file while the bubble itself showed the file-include part's raw JSON. The user-message event now carries the text plus a `files[]` view, rendered as collapsible boxes in the bubble -- live, session replay, and cold log replay. `SystemMessageEvent` loses its `files` field.

- **Removed `--no-stream` / `stream` config (breaking).** The flag only gated display -- the request path always streamed -- so `--no-stream` runs silently dropped the answer. Output is now always streamed; `--no-stream` fails fast as an unknown flag and `"stream"` in `defaults.json` surfaces as an unknown key in `hotdog rescue`.

- **fetch tool returns images.** A fetched PNG/JPEG/WebP/GIF now attaches to the tool result as a base64 `image_url`, exactly like `read` -- a vision model can look at a chart or screenshot straight from a URL. Gated by `modelAcceptsImages` before any bytes are read (fail-closed on text-only models), capped at the shared 10MB image limit with a streaming byte cap so endless streams get cancelled, not buffered. Other `image/*` types (e.g. svg) keep the text path; `HEAD` still returns headers only.

- **@-ref image attachments get their own size budget.** `fileAttachment.maxFileSize` (100KB) gated text and images alike, so screenshots over 100KB were silently dropped from @-refs even on a vision model -- while `read` saw them fine under its 10MB cap. New `fileAttachment.maxImageSize` (default 10MB, matching `read`) applies to images; text budget unchanged. The webui Attach button shares the split: `image/*` uploads over the websocket are sized against `maxImageSize`.

- **llama.cpp model-modality detection.** `fetchModels` now understands plain llama.cpp's `/v1/models` shape, not just llama-swap: context from `data[].meta.n_ctx`, vision from the ollama-style `capabilities` list, `aliases` expand. When the payload has no modality data it falls back to `/props`. Vision models on bare llama.cpp now report `inputModalities: ["text","image"]` without hand-editing provider config; non-llama.cpp providers see no extra requests.

- **`--disable-env-scrubbing`** CLI flag: turns off env scrubbing for agent-spawned subprocesses (bash tool, MCP stdio); children inherit the full environment. Default stays scrubbed.

- **provider health tracking.** A dead provider looks idle -- the preferred placement target -- until a task locks onto it and burns its retries on connection-refused. Placement now consults reachability verdicts: a sweep every `providerHealthCheckIntervalSecs` (default 30, `0` disables the timer) probes each provider with a resolvable url -- `/v1/models` for `fetchModels: true` providers, which doubles as a live catalog refresh upserted into the running registry, `/health` otherwise -- and connection-level task failures (refused/DNS/reset) demote a provider immediately, active even at `0`. Reachability is status-agnostic: a 500 or a stalled generation still proves the socket answers. Recovery clears through a successful probe or any task completing a turn, so demotion is never process-permanent. A down provider is skipped during multi-candidate placement unless every candidate is down (fail-open); pins are never rerouted. `hotdog info` shows the per-provider `up`/`down` verdict.

- **fix tool-result blindness on strict chat templates.** Since the tool-result part refactor, `role: "tool"` messages rode the wire as part arrays; llama.cpp/Ollama templates interpolate tool content as a raw string and choke, so some models effectively never saw tool results. Text-only tool content now collapses back to a plain `\n`-joined string on the wire; arrays with non-text parts (images) stay arrays.

- **show-me now uses the OpenAI Images API** (`POST {provider-url}/v1/images/generations`, `response_format=b64_json`). Diffusion backends don't mount image models on chat completions -- they 404 there.

- **marker-mangler - chatML tokens are escaped too.** ChatML control tokens (`<|im_start|>`) in untrusted text are rewritten to a safe form and reversed on output -- chatML markers survive enough model templates to be common breakage.

- added `SECURITY.md` (security policy / reporting)

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.11.2...v0.11.3

## [v0.11.2] - 2026-09-29

- **Workflows: validate-is-save, file dispatch, and graph params.** Manager tool `workflow_save` is gone. `workflow_validate` now saves a valid design on the spot (as `<name>.workflow.yaml`, returning the path) and also accepts `file` to re-validate an existing graph. `workflow_dispatch` takes `file` (path or bare name resolved against the workflows dir) instead of pasted `yaml`, closing the loop so validation is a required step and designs avoid round-trip through the transcript. Graphs can declare a top-level `params` block (id -> default, empty = required) and reference values as `{{params.x}}` in any string; `workflow_dispatch(args={...})` and the CLI's repeatable `--param key=value` fill them, making saved graphs reusable templates. Substitution runs on the parsed YAML tree, so values can't inject graph structure.

- fix regression in startup `--profile` tool filtering, causing tools to be loaded based on the default profile regardless

- task-lanes - fix address issue causing cap+1 lanes on providers

- fix frontmatter-only (empty body) task agent profile

- updates to example profiles (meta updates, new manager)

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.11.1...v0.11.2

## [v0.11.1] - 2026-09-28

Small but important fix to solve an issue causing hangs when using task-lanes (lanesRetryTimer storm)

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.11.0...v0.11.1

## [v0.11.0] - 2026-09-27

This one's a footlong! Biggest new features: optimizations for local models, local infra subagent fan-out, /profile switch, session rewind/forking, tab completions in the webui.

- **Profile-bound model groups.** A worker profile can bind fanout itself: add a `group` field (frontmatter or in-config) naming a `modelGroups` pool, and every `delegate_task` / workflow node routed to that profile places across the group without the manager naming a group -- same precedence as everywhere (`pin` > `worker_model` in any form > profile `group` > profile `model` > default). `group` is mutually exclusive with `model` (group wins, warned at spawn), and a profile `model` spelled `group:<name>` now fails loud at spawn with a pointed error instead of launching with the literal string as the model. Groups remain worker-only: `applyProfile` skips a group profile's model with a warning, keeping the session's current model. `delegate_task`'s tool description now lists the declared groups so the manager can see what exists.

- **Workflows: multi-agent DAG orchestration.** A workflow is a YAML graph of worker nodes -- saved as `config/workflows/<name>.workflow.yaml` or designed by a manager -- where each node declares a profile, a model pin/requirements, inputs from upstream nodes, and a machine-checked accept gate: its declared output files must exist fresh inside the run dir plus a `<node>.verdict` file whose first line is `pass|fail|reject`. CLI: `hotdog workflow validate|render <file>`, `run <file> [--id <run-id>]` (foreground with live node lines, Ctrl-C cancels gracefully; one dir per run with an append-only `run.jsonl` state log; `--id` resumes a previous run, reusing only completed nodes that still verify on the filesystem, which `reconcile` reports on), plus `list`, `status`, `reconcile`, `cancel`. Manager tools `workflow_validate` / `workflow_save` / `workflow_dispatch` / `workflow_status` let an orchestrator profile design, persist, and dispatch graphs without polling -- completion posts to the delegating session on the task-completion path -- and `/workflow` / `/followup <node> <message>` list, inspect, cancel, and steer runs. Config `workflows`: `path` (default `<configDir>/workflows`), `maxNodes` (soft cap 8, hard ceiling 32), `maxRuntimeMins` (30).

- **Cross-provider placement fanout (`modelGroups`, provider `noSpread`).** Spawn model resolution now produces an ordered *placement plan* instead of a single pick, and TaskManager admits it lane-aware: the first candidate whose provider lane has capacity wins, locked for the task's lifetime. Two `delegate_task` calls with no model given now run in parallel across the providers carrying the default model's copies (warm llama-swap nodes preferred among those with room; the `/running` peek re-ranks queued tasks at placement time) instead of serializing behind one lane. `modelGroups` declares interchangeable pools (`mid-level: [qwen3.8-flash-next, llama-3.3-70b]`), referenced as `worker_model: "group:<name>"` or the workflow node `group` key -- placement degrades to the next free member instead of queueing, while bare-name copies never degrade. Strict pins and provider-qualified explicit values never fan out; `noSpread: true` on a provider keeps it off implicit fanout (explicit members and pins still land there). A multi-candidate task can return while still `queued` unplaced (`task_status` shows the intent, provider null, until a lane is granted), and a first worker on a cold copy pays one model swap by design. `spawnTask` now refuses an id already held by a queued/running task instead of silently orphaning the live one.

- **Empty-response-after-tools nudge.** When a completion arrives with no text and no tool calls while the context tail is a tool result (a common local-model stall that silently abandoned the task), the harness persists a `system-notice` asking the model to continue and advances the loop instead of stopping.

- **Loop detector** (`src/extensions/loop-detect/`, on by default). Hashes each tool call as (name, canonicalized arguments) and watches the tail for two spin patterns: k consecutive identical calls (default 3) and strict A/B/A/B ping-pong (default 4). Escalation follows the streak: a `system-notice` nudge injected before the next request, a stronger nudge at 2x, then `agent.cancel()` with a user-visible message at 3x. Every escalation fires the `loop:detected` hook (`{ agent, toolName, kind, streak, level }`). Per-session state, dropped on context replacement (compaction/rewind/`/clear`) and session end; tune via the `loopDetect` config block.

- **`/undo`, `/rewind [N]`, `/fork [N] [prompt]` -- turn-level time travel.** A turn is a user message plus everything after it until the next user message (tool chains never split). `/undo` drops the last turn; `/rewind [N]` drops N (default 1). Rewinds persist: the session-log extension checkpoints the log with a `reset` entry followed by the surviving messages (append-only, undone history kept above the marker for audit) -- the previously dead `reset` replay support in core finally has a writer, which also fixes resumed sessions replaying history that `/clear` removed. `/fork [N] [prompt]` branches a new session from N turns back (default 0 = full copy) and switches to it (interactive CLI re-attaches the channel; the source stays attached for `/switch` back); an optional prompt is enqueued by the UI only after its channel/socket is re-targeted onto the fork (interactive CLI and webui alike) -- core's `forkSession` never touches the prompt, so the fork's first output can never fire before anyone is listening. Session-mutating commands (`clear`/`undo`/`rewind`/`fork`) are rejected while a run is active -- replacing context mid-turn corrupted both histories. The webui handles `/fork` consistently with the interactive CLI: the ws layer registers the forked session's UI metadata, re-targets the requesting tab (sessionCreated + history replay), then enqueues the optional prompt there; `forkSession` itself also refuses to fork a running session (direct-call guard) and mirrors `create()`'s current-session ordering around `SESSION_CREATE`. New core pieces: `trimTurns` (`src/core/context/rewind.ts`), `context:rewound` hook, `Agent.rewindContext()`, `SessionManager.forkSession()` injected into agents as the `forkSession` seam (same pattern as `enqueueCallback`).

- tool-call-repair - handle a second kind of problem, when the JSON can end up malformed - interrupting a hung stream could leave an assistant message with truncated tool-call arguments (invalid JSON) in history; a llama.cpp-style backend then throws error 500 every subsequent request ("Failed to parse tool call arguments as JSON ..."), bricking the session. Now removes broken tool calls and retries.

- **`--json-schema` structured output for one-shot mode.** can be a file path or inline JSON object.

- **`/profile` command added** (list + switch). New extension `src/extensions/profile-switch/` adds: `/profile` lists profiles marking current; `/profile <name>` and `/profile:<name>` to switch.

- **rescue subcommand - config diagnostics that survive a broken config** -- a syntax error in defaults.json (the most common breakage: JSONC comments, trailing commas) would throw inside the early so every subcommand died with a one-line parse error and there was no way in. New core subcommand `hotdog rescue [fix]`: prints the config-dir resolution chain, diagnoses defaults.json along the chain (explicit `-f` overrides), and for broken files shows the parse error with an engine-independent line/column caret locator, repairs BOM/line-and-block-comments/trailing-commas, and with `fix` rewrites the file keeping a `.bak` (never clobbers an existing backup); non-fixable breakage gets the marked position. When JSON parses it also warns on unknown top-level keys ("did you mean" via shared `suggestCandidates`), silently-won duplicates, and core+extension schema violations (`validateConfig` against raw normalized file + registry schemas), plus system_prompt.md/profiles-dir presence.

- [BRK?] **bash-tool brace expansion fix** -- `BashTool.execute` was previously spawned with `shell: true`, which uses `/bin/sh` (dash on Debian-ish systems, where was run); dash has no brace expansion, so `mkdir -p x/{mcp,openai,sse}` created one literal `{mcp,openai,sse}` directory. Now uses 'bash' explicitly. Slight chance of breakage if you were using this in a slim container with `sh` but without `bash`.

- **`hotdog info`** added an `Extensions` section: every extension discovered in the scan paths, shows `(disabled)` if `enabled: false` in config (incl. schema defaults like user-gate's off-by-default), `(not loaded)` if enabled but excluded (autoload off, list selection, or `create()` returning null -- e.g. subagents on non-manager profiles).

- **`$VAR` interpolation in config files.** a string that is *exactly* `$VAR` or `${VAR}` resolves from `process.env`. Whole-string only -- `"http://$HOST"` / `"cost $5"` untouched.

- **webui - tab completion in chat input** -- Tab opens the popup, Tab/Shift+Tab/arrows cycle, Enter accepts (Escape first to submit raw), Esc/blur/edit dismiss, mousedown accepts without caret loss, invalidation token so a late reply can't reopen a dismissed menu.

- **tab completion for bare filepaths** -- file-attachment completion matcher/handler now also trigger on bare path-looking words (`./x`, `/x`, anything containing `/`) in addition to `@`-prefixed attachments; values are returned without the `@` in that case (prefix preserved, e.g. `./te` -> `./test.txt`). Plain prose like `test.txt` won't trigger (no `/`, no leading `.`); slash-containing prose like `and/or` does trip the matcher but the handler yields no matches and thus an empty list (readdir of the nonexistent `and` dir hits the catch-all), so it should be harmless in practice. 

- security
  - env scrubber - widen to redact *_PWD and add extra list in config
  - fetch-tool - widen blocklist for reserved addrs
  - session-log - validate session id before writing
  - marker-mangler - escape dashed-prefixed markers without terminator at end of string

- fixes
  - /compact N - no longer leaves orphaned tool messages, which can cause errors on some backends
  - mcp-client - handle write/stdin errors without full hotdog crash
  - avoid orphaning tool messages when interrupted (ctrl+C, or stop button)
  - fix `--no-log`, was writing log files anyway due to a regression during JS->TS rewrite
  - fix regression with `--compact-debug` - The flag/config promised `compaction.out.json` but nothing was ever written. `_handleCompactCommand` now dumps `{ts, session_id, mode, keep_requested, strategy, settings, messages:{before,after}}` to `compaction.out.json` in the sessions dir
  - file-tools **BOM/CRLF fidelity in the write tools.** silent-corruption bug - bun keeps `\uFEFF`/`\r\n` in utf-8 strings, so the edit trimmed-line fallback mixed bare LF into CRLF files and could drop the BOM when the first line was replaced; append/overwrite wrote model LF into CRLF files and overwrite always dropped the BOM. Fix = detect-on-read, re-apply-on-write
  - /loop + handoff - handoff now supercedes loop deterministically
  - interactive cli - mid-string tab completion clobbered input -- fixed completing `@pac` in `/loop review this software, including @pac<TAB>` replaced everything with `@package.json`

- internals
  - add session teardown hook
  - steering queue refactor (followQueue->steer)
  - `exitCommands` unused config key deleted
  - hook priority system to enable that loop/handoff fix

- experimental/file-watch - notices are no longer injected into every LLM request: each external change is logged **once** as a persistent harness message in the session (quiet until the file is re-read or overwritten). Bash looks count as reads: a successful `cat`, `grep`, print-mode `sed`, or `git diff`/`git status` naming a tracked path resolves its stale flag and write guard.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.10.0...v0.11.0

## [v0.10.0] - 2026-09-19

- **[BRK]** removed the profile-level `role` field. The only "role" concepts that remain are the message-format wire encoding (`Message.role`, role-mapping) and plain prose in user-supplied context files.
  - Profile files with `role:` frontmatter still parse -- the key is dropped and can never reach prompt assembly (covered by tests asserting a profile role can never leak into the system prompt).
  - Config keys `role` and `taskDefaultRole` and the `--role` flag are gone; the `{{ role }}` placeholder was removed from the default system prompt template. If you had a role line, fold it into the profile body.

- [BRK] internals / hooks - pipeline handlers now patch the payload. Whatever a handler returns is written onto the payload, field by field, so every later handler and core read one thing: the payload. This replaces reading "the last handler's whole return value" at each call site, which silently dropped earlier patches — a `provider:request` handler returning `{ modelConfig }` followed by one returning `{ messages }` used to lose the model. Same rule now covers `context` (`{ messages }`), `provider:request`, `provider:response`, `tool:result`, `tool:call`, `input`, and `command:dispatch`. Non-object returns (a bare array, a string) are not patches and are ignored. `runHookPipeline()` no longer returns a `lastResult` field; `results` (every return, in order) and `stopped` remain. The now-dead type-guard helpers (`isGateActionBlock/Modify/Continue/Handled`, `isInputTransform`, `isInputHandled`) are removed: call sites directly read the payload's `action`.

- extensions - new opt-in tier: `@experimental` in `extension_paths` loads `src/experimental/` (the setting replaces the default, so use `["@extensions", "@experimental"]` to keep the built-ins). First entry: `file-watch`, cooperative-editing awareness for a shared working tree — it tracks the files a session reads and writes, notices when the bytes on disk stop matching what the session believes, rides that onto each request as a harness system-notice, and blocks an `overwrite` onto a file that changed underneath the session.

- fix - duplicate message delivery in the core agent loop: a UI host calling `run()` after `SessionManager` had already started the loop spawned a second consumer on the same queue, so one queued message could drive two `agent.run()` calls (the loser threw `AlreadyRunning`). `run()`/`runUntilCancelled()` are now idempotent -- a later call joins the active loop instead of racing it.

- tools - a batch of core-tool and extension fixes found by auditing `src/extensions/`:
  - `project_info`: the non-git file listing was computed relative to the process CWD instead of the requested directory, so listing a directory from another launch dir produced absolute/`../` paths.
  - `web_search`: the `results` count entry reported the number of output lines instead of the number of results (e.g. 3 results with descriptions read as 9).
  - `find`: `max_results: 0` was accepted and silently returned "No files found" even when matches exist; it now falls back to the default like any other sub-minimum value. The `file_type` tool schema now documents the empty-file filter (`"e"`) the code already supported.
  - `read`: files above 1MB are now read with a single streaming pass (the whole-file read is kept for small files), so paginating a multi-GB log no longer materializes the entire file in memory per call.
- config - removed two dead config keys: `coreTools.maxDiffSize` and `handoffTool.systemPrompt` (declared in schema and docs, read by no code). Added the missing `layers` block to the `loop` config schema, which had left `loop.*` settings outside the config resolution pipeline.
- `question` tool: the schema no longer marks `key` as required — it was always auto-generated from the prompt when omitted.

- hooks - `notifyHooks()` is now awaitable: handlers start immediately in registration order (async ones run in parallel). Core call sites now await it where later code depends on the effect: the tool pipeline (`TOOL_BEFORE_EXECUTE`, `AGENT_TOOL_CONTEXT`, `TOOL_AFTER_EXECUTE`, `TOOL_METRICS`), turn boundaries (`TURN_START`/`TURN_END`), session create/swap, the bootstrap registration hooks, and `SHUTDOWN_CLEANUP`. Previously an async `AGENT_TOOL_CONTEXT` handler could complete its tool-context mount *after* the `TOOL_CALL` gate (e.g. the user-gate approval seam) had already run. Signature note: `notifyHooks()` returns `Promise<void>` (was `void`); unawaited call sites keep the old behavior.


**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.9.2...v0.10.0

## [v0.9.2] - 2026-09-17

- `tool-call-repair` - now handles both xml and chatml style tags, instead of just chatml style

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.9.1...v0.9.2

## [v0.9.1] - 2026-09-17

- added `tool-call-repair` extension: recovers malformed tool calls that often occur with local backend. When it detects a dropped tool call, the response is rewritten in place and the agent's normal tool-execution path runs the calls.
  - Config: `toolCallRepair.enabled` (default `true`), `toolCallRepair.maxRepairsPerTurn` (default `2`, `-1` = unlimited).
  - If you find any broken tool calls going forward, please make an issue on the tracker with the shape of the tool call, so that I can repro and fix it.

- internals
  - `PROVIDER_RESPONSE` became a real pipeline: handlers may return `{ response }` to replace the parsed response before the assistant message is built and tools execute.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.9.0...v0.9.1

## [v0.9.0] - 2026-09-15

- **[BRK]** llm-client / config: the tool-result seam split into two independently-selected seams.
  - `WireFormat` owns the model-facing *markup shape* of harness wrappers (tool results, attached-file includes, system notices): `modelToolFormat`/`--model-tool-format` became `modelWireFormat`/`--model-wire-format` (default still `"xml"`, but the shape -- and the `file-include`/`system-notice` marker protection -- now come from the autoloaded `wire-format-xml` extension).
  - `RoleMapping` owns where the internal `harness` role rides on the wire: the provider/model entry `wireFormat: "system-first" | "developer"` moved to `roleMapping` with the same two ids, registered by the new autoloaded `role-mapping-default`.
  - Tool results now travel as structured parts (tool/status/meta/error/hint/output) through context, session logs, hooks, and UI events instead of pre-rendered text. Rendering is up to each UI. The wire serializer is the only render point for the wire format. Fields are mangled before the format sees them.
  - Wire breaks for extension authors: the `turn:end` hook payload's `result` is `content`, same for the TOOL_RESULT output event; `ToolResult.outputTag` removed; `EXTENSION_PROVIDES.TOOL_FORMATS` replaced by `WIRE_FORMATS` + `ROLE_MAPPINGS`. A seam name configured but not registered by a handler throws `Unknown wire format/role mapping "<name>"`
  - **Config Migration**: a stale `wireFormat: "developer"` config fails on the first request with `Unknown wire format "developer"` -- rename the key to `roleMapping`/`role-mapping`.

- added visual display protection from zero-width characters / bidi spoofing (which a malicious llm could use to hide a dangerous command in an innocent-looking `ask` prompt) by escaping these characters prior to rendering.
- ui-interactive-cli: bracketed pastes whose content is a single line once surrounding newlines are trimmed no longer become a `[Paste #N]` marker -- the trimmed content is inserted inline (a pasted line with a trailing Enter behaves like typing it).
- ~~added experimental sysbox layer for bash-tool~~ -- kernel enforced resource limits, syscall-level sandboxing (seccomp launcher C, Landlock fence, capability probes, cgroup DoS limits).
- removed sysbox layer. Fun experiment but I was not confident enough shipping it. For real isolation run hotdog in a container or VM. More info at `docs/postmortems/sysbox.md`
- approvals - `user-gate`, a **tool-call** approval layer, above the spawn boundary.
  - Opt-in (`userGate.enabled` defaults false -- with `default: "ask"` an on-by-default gate would prompt every user on every call).
  - Grammar is `tool` or `tool.param=glob` -- `bash.cmd=git`, `edit.paths=src`, `fetch.url=https://docs.example.com/*` -- and path values reuse `Workspace` rule matcher (same as `workspace.deny`), matched against the absolute AND the workspace-relative path.
  - Precedence `deny` > `allow` > `default`. `deny` never prompts and cannot be overridden mid-run. `default` can be set to `ask` (interactive), `allow` or `deny` -- allowlist-only, nothing prompts, unrecognized tools and unanalyzable bash deny too. _`default` `deny` recommended in non-interactive mode, like on CI or with `-p`._
  - Bash commands are segmented on `;`/`&&`/`||`/`|`/newline with `cd` retargeting later segments, and the analysis **bails to an ask** on anything that could hide an effect: `$(...)`, backticks, `${}`/`$VAR`, parens, brace expansion, unquoted globs, here-documents, `xargs`, `eval`, `env`, `find -exec`/`-delete`, and inline-code interpreters (`sh -c`, `python -c`, `node -e`, `awk`...).
  - Fails closed -- no seam, non-interactive UI, throwing prompt, aborted run or empty answer all block, with the reason; malformed rule is a startup error and keeps every call blocked until fixed.
  - **What it does NOT stop**: the command is not executed and the final operation isn't checked; nothing enforced at system level once the command is started.
  - Nothing is written to config from a prompt; a session allow is in-memory only, keyed on the tool plus every extracted value.
- added `/show-prompt` command to see the active system prompt, as an interactive slash command and the `show-prompt` subcommand.
- cli - token usage line reworked; now also shows the context window size.
- workspace - now warns and continues when some configured roots are missing; errors only when **all** roots are missing. Also fix workspace handling when a root is `/`.
- extensions - an invalid `extension.json` now throws at load instead of being silently skipped. Fix nested extension import.
- sessions - resuming with an invalid session id now throws instead of silently starting a fresh session.
- sessions - interrupted or missing tool results are healed on load, so a session killed mid tool-call no longer produces API errors on resume.
- agent - fix per-model context-limit lookup; non-default models were falling back to the base limit.
- compaction - an unrecognized model now resolves the default context limit instead of erroring and skipping compaction.
- llm-client - connection errors now report the url being connected to.
- question tool - more robust Ctrl-C handling; clearer error in one-shot mode when no user is connected to answer.
- info - fix skills display.
- internals
  - tool-executor - `toolCtx` is now built (and `AGENT_TOOL_CONTEXT` fires) BEFORE the `TOOL_CALL` gate pipeline, and the gate payload carries `toolCtx`
  - bash-tool - add `truncated="true"` result metadata info when output is truncated, same as find/grep/etc
  - hooks - unrecognized hook name now logs a warning instead of being silently ignored.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.8.0...v0.9.0

# [v0.8.0] - 2026-09-06

Added `utils/jsx` to hook into [bun's jsx support](https://bun.com/docs/runtime/jsx) as a react-like jsx view layer for the UI, and then refactored most of the webui to use that. There's also a bunch of little QoL things and bug fixes in this release.

- llm-client - retries now honor a server `Retry-After` header (delta-seconds and HTTP-date forms, capped at 60s) instead of the fixed exponential backoff; absent or malformed headers fall back to the existing ladder
- llm-client - error responses are now read up to the 200K cap but quoted in the LlmError message up to 2K (with a `[truncated]` marker), so a broken endpoint returning a full HTML page no longer dumps hundreds of KB into the sink, logs, and retry lines
- agent - `run()` is now guarded against re-entrancy: a second overlapping `run()` throws `AgentError.AlreadyRunning` instead of silently interleaving loop state (iteration count, abort controller, stream replay buffers)
- tool-executor - "Tool 'x' is not available for this agent" now suggests near-matching tools from the set the model was offered (case/separator differences first, then prefix/substring near-matches), so a misspelled or case-flipped tool name self-corrects in one retry
- cli - unknown flags are now fatal (exit 1) with a "Did you mean" suggestion when a registered flag is a near-match, instead of a warning that let the run proceed with the flag silently dropped
- session - a throwing channel event handler is now logged at debug level instead of being swallowed silently; other handlers still run
- package - minimum bun bumped to 1.3.1 (the `--only-failures` flag used by the test scripts landed in 1.3.1)

- internals
  - webui - rewrote in jsx
  - marker mangler - compiled escape/unescape regexes are now built once per name pair instead of rebuilt per protected prefix on every escape() call
  - cleanup session - remove unused SessionManager.deserialize and related unused serialize/deserialize hooks
  - task-manager - drop unsafe last-set bus fallback
  - task-manager - release the finished task's Agent reference from the registry when a task reaches a terminal state (completed/failed/cancelled); previously dead tasks pinned their full agent context for the manager's lifetime, an unbounded leak on long-lived hosts like the webui
  - tool-utils - remove legacy parseToolArgs (its invalid-JSON `{input: ...}` fallback was a footgun); subagents now use parseToolInput like every other tool

- CLI colors now honor the NO_COLOR environment convention and TERM=dumb: color output is disabled regardless of config when either is present

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.7.3...v0.8.0

[v0.7.3] - 2026-09-01

This release includes some security fixes for grep/find, expands the default workspace path denylist to include cloud creds, and other improvements.

- find/grep tool - fix argument injection in the fd path: a model-supplied pattern starting with - was parsed as an fd flag (e.g. --exec=rm made fd run rm on every file found, recursively). Same issue with grep/rg. Dash-leading patterns now route to the find fallback, whose -name/-path consume the pattern as a literal, and the positional slot is additionally guarded with a -- separator.
- workspace denylist defaults expanded with cloud/credential directories: `.aws`, `.azure`, `.docker`, `.gnupg`, `.kube` (alongside `.ssh`, `.config`, `.git`). Projects that legitimately keep a directory of one of these names inside a workspace root can carve it out via `workspace.deny` (rules are last-match-wins, so `!.aws` after the positive rule disables it, or configure the exact rule set you want)
- fetch tool SSRF blocklist now refuses Teredo (`2001:0000::/32`) alongside the existing 6to4/NAT64 refusal -- a Teredo packet carries an unchecked (XOR-obfuscated) IPv4 destination; adjacent `2001::` allocations such as provider space (`2001:4860::/32`) and documentation (`2001:db8::/32`) are unaffected
- websocket/webui: renaming a session now sets a display title instead of changing the session's profile; the profile keeps driving behavior (role, tools, model) and is still switched via the profile switcher. Titles are in-memory only and are dropped when a session is rebuilt from a cold log or the server restarts
- ui-session-review-cli - sessions delete subcommand now validates sessionId before confirmation gate
- handoff-tool: listed handoff files that exist and are under the new `handoffTool.autoIncludeFilesUnderBytes` config (default 24KB) are now auto-inlined into the handoff message instead of just listed; oversized, binary, missing, and directory entries are listed with a note (size, `binary`, `not found`, `directory`, or `path rejected`)

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.7.2...v0.7.3

## [v0.7.2] - 2026-08-30

I've been wanting this feature for a while and took a few tries at it - this is the first implementation I'm happy with so it's worth cutting a release.

- ui-interactive-cli: clipboard paste detection and support in the interactive session (bracketed paste mode)
  - does not auto-submit on paste; pasted content appears inline as a numbered `[Paste #N - M lines]` marker in the input line.
  - one backspace, or the Delete key with the cursor on the marker, deletes the whole paste.
  - paste answers in question prompts are normalized the same way and should work the same.

- internal code cleanup, config resolution system consolidated

- removed action dependencies from CI test/coverage runner

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.7.1...v0.7.2

## [v0.7.1] - 2026-08-30

- mcp-client fix regression in http, incorrect DI
- internals code cleanup

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.7.0...v0.7.1

## [v0.7.0] - 2026-08-29

- requirements
  - minimum bun version bumped to 1.2

- [BRK] the placeholder `qwen3.5-0.8b` default model is gone -- when nothing in the model resolution chain (CLI `--model`, profile, env, config `default_model`, provider models) supplies a model, agent creation now fails with a `No model configured` configuration error instead of silently using a bogus model; model-free subcommands (`profiles`, `sessions`, `info`, `show-prompt`) keep working with an incomplete config
  - fix - the `HOTDOG_MODEL`/`AI_MODEL` env layers of the `defaultModel` schema were dead for the final resolved model (only the raw config value reached `resolveModel`); they are honored now

- llm-client
  - `chatStreamCancellable` now cancels the response body when the consumer abandons the stream (cancellation or early return), so the connection is released instead of lingering
  - fix - streaming no longer sees stale provider state: SSE parsing now receives the provider-resolved `baseUrl`/`apiKey`/session id instead of the raw client-level fallbacks, so protocols that read those values while streaming work with per-provider settings
  - `maxRetries: 0` now means exactly one attempt with no retries, instead of falling back to the configured default

- config
  - the previously hardcoded fallback context window is now the `contextLimit` core config key (default `128000`) -- it feeds the model registry fallback, the agent, and compaction, so small-context local models can lower the base limit from `defaults.json`; compaction can override it per-extension via `compaction.contextLimit`
  - **behavior change** -- `extensionAutoload` now defaults to `true` (was `false`); extensions on disk are loaded without being listed explicitly. Set `extensionAutoload: false` to restore the previous opt-in behavior
  - removed dead config keys that were never read: `defaultAiUrl`, `systemPromptDefaultTemplate`, `embeddingsTimeout` / `embeddingsTimeoutSecs`

- workspace
  - `.git` is now in the default deny list; workspace files inside `.git` are no longer reachable by file tools
  - fix - deny-list entries could be bypassed through symlinks that resolve outside the listed path; the resolved target is now checked as well

- mcp-client
  - new `mcpClient.httpTimeoutSecs` config (default `30`) -- bounds HTTP transport requests (connect, headers, body) so a wedged MCP HTTP server can't hang a tool call indefinitely; invalid values fall back to the default, never to "no timeout"
  - per-stream in-memory accumulation is now capped (2M chars) for stdio and HTTP transports; a chatty or hostile server can no longer exhaust memory, and truncated oversized lines are drained (not dispatched) to keep framing aligned

- fetch tool
  - default `maxBodyLength` raised from `8000` to `20000`

- file-attachment
  - fails closed (attachment rejected) when a workspace boundary check throws, instead of propagating the error

- internals
  - the tool-call hook pipeline now fails the call with an error when a hook errors, instead of swallowing the error and continuing
  - tool defs are resolved once per batch of parallel tool calls, not once per call (faster multi-tool turns)

- performance
  - read tool - fewer redundant disk reads for the same functionality
  - grep tool - the native fallback binary detection no longer reads whole file into memory

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.6.0...v0.7.0

## [v0.6.0] - 2026-08-27

- [BRK] the `"builtins"` magic string for extension paths is no longer accepted and now fails startup with a config error -- use the `@extensions` path alias instead

- workspace
  - multi-root workspace support: new `workspace.paths` config (array of directories; entries may be relative, `~`-expanded, or globs). Relative tool paths resolve against the first root; absolute paths must fall inside one of the configured roots. The roots are surfaced in the system prompt environment chunk when more than one is configured
  - **Notice for existing configs** -- legacy `cwdBoundary` / `workspaceRoot` keys are still honored (as a single root) when `workspace.paths` is absent, but their handling changed: they are now validated at startup, so a value pointing at a nonexistent path fails startup with a config error instead of degrading at runtime, and `~` / glob expansion is now applied to their values as well
  - fix - `project_info` path was not bounded by the workspace boundary; it now is, and escaping paths are rejected

- llm-client / tool-executor
  - `maxRetries` now means retries *after* the initial attempt (total attempts = `1 + maxRetries`); previously the value was the total number of attempts, so `maxRetries: 3` gave 1 + 2 rather than 1 + 3

- mcp-client
  - tool names no longer use `server/tool` as the `/` may be rejected by some APIs. Tools now register as `server__tool` with characters outside `[a-zA-Z0-9_-]` sanitized
  - tool registry now rejects names outside `[a-zA-Z0-9_-]` at registration, so a bad name fails fast instead of failing every LLM request

- bash tool
  - model-requested `timeoutMs` is now sanitized and clamped: invalid values (zero, negative, non-numeric) fall back to the configured default, and valid values are capped by the new `bashTool.maxTimeoutMs` config (default `600000`)

- fetch tool
  - transient failures (timeout, abort, network) are now only auto-retried for GET/HEAD; other methods resolve as a plain error so a dropped POST/PUT/PATCH is not re-executed against a third-party endpoint

- websocket
  - unauthenticated sockets can no longer join the broadcast group until authenticated (defense in depth for extensions that upgrade without a token)
  - profile switch now also switches the model when the profile specifies one, and rebuilds the cached system prompt and tool defs; session metadata reports the active model

- static file server
  - fix - sibling directories sharing a prefix with the root (e.g. `/srv/app2` under root `/srv/app`) no longer pass the path containment check

- render templates
  - fix - left-dash whitespace control (`{%-`) now actually strips the whitespace before the token

- explore tool
  - fix - the spawned sub-agent used outdated `-c` instead of `-p` flag
  - marked `sideEffects: true` (it spawns an agent process)

- sessions
  - fix - images duplicated on every save/load round-trip; content is now persisted raw and legacy sessions with inlined image parts are healed on load

- info CLI
  - fix - `info --config-debug`

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.5.0...v0.6.0

## [v0.5.0] - 2026-08-26

- add string-length tool
- add medium reasoning level support
- `/loop` - now keyed by session id, supports multi-agent sessions
- fix - tab completion for the `/reasoning` level argument
- fix - environment system prompt chunk referenced the wrong profile name
- bash tool - set `EDITOR=cat` in child process env to prevent hangs in some programs

- internals
  - split internal message format from wire formats
  - split the tool->model wire format (ToolFormat) and the LLM provider protocol (LlmProtocol) out of the llm-client
  - fetch util bugfix - remove default content-type json header
  - move token estimation (chars/4 heuristic) out of the compaction extension into `utils/token-estimate.ts`
  - hook system - dedupe trace logging into a single helper (notifyHooks + runHookPipeline)
  - fix - `retryWithBackoff` with `maxRetries: 0` made zero attempts
  - fix - tool registry logged "unknown" instead of the tool name when a tool's `toToolDef()` threw
  - fix - `switchSession` emitted `session:swap` with the switch target as both old and new agent; oldAgent is now the previously active agent
  - compaction - fix - abort listener leaked on the agent's long-lived signal; now removed after each summarization call

- llm-client
  - health check (`ping`) now accepts a model name to check a specific provider, instead of only the default base url
  - fix - health check (`ping`) now times out; configurable via `healthCheckTimeoutSecs`
  - LLM HTTP error bodies are now capped at 200k chars before being embedded into error messages
  - retry classification reads a structured `LlmError.status` instead of parsing the error message

- fetch tool
  - response read cap raised 100k -> 2mb; display truncation now runs after cleanup / md conversion, so verbose HTML isn't cut before it can shrink

- mcp-client
  - stdio servers now run detached; process group is killed on destroy (no orphaned processes)

- subagents
  - fix tool registration issue
  - remove noop complete_task tool
  - fix task result routing to the delegating session (instead of whatever session was created last)

- security
  - expand env var filter for child process secret scrubbing (bash/mcp-client)
  - fetch tool - fix redirect SSRF bypass (redirect targets are now re-validated)

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.4.1...v0.5.0

## [v0.4.1] - 2026-08-19

This is mostly a bug fixes and security hardening release.

- webui - interactive question tool support
- edit tool - support empty replacement string / deletion
- edit tool - fix - when using space-stripped fallback, the starting index to replace is now correct so lines aren't duplicated or cut off mid-line.
- explore tool - inherit and respect workspace/cwd boundary
- fetch tool - add configurable scheme filter, and disallow private addresses by default (SSRF filtering)
- tool executor now actually enforces tool filters. Previously these were just filtered from system prompt/tools param, but technically if the LLM was guided into calling a tool it couldn't see, it could do so if it guessed the syntax exactly right.
- compaction - no longer orphans tool results without tool call
- handoff tool - tighten up inlined ctx, remove system prompt chunk
- fix - reject path traversal in profile/aspect names
- webui/websocket - default bind to localhost instead of 0.0.0.0, warn when publicly accessible
- mcp-client - hide inherited env secrets from stdio mcp

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.4.0...v0.4.1

## [v0.4.0] - 2026-08-17

It's been a couple weeks since I cut a release, figure it's about time. The focus here has been around code cleanup, improving robustness, security, and QoL features.

- [BRK] renamed TokenTracker fields for clarity
- [BRK] improve /compaction syntax (see README.md or `--help`)
- [BRK] remove pager tool (used exactly once, by a model that did not believe it existed)
- add HOTDOG_MODEL, AI_MODEL, HOTDOG_API_KEY envvars for config
- fix some issues with profile loading & switching
- webui - add profile switching
- webui - markdown streaming formatting improvements
- webui - brute force hardening, rate-limit login endpoint
- websocket - stricter auth gate on ws lib backend
- refactor - drop duplicate configuration fallbacks and fail harder to uncover actual problems faster
- bash tool - kill whole process tree on timeout, not just shell
- bash tool - filter out sensitive env vars to reduce secrets exposure
- skills - fix - now mid-session loaded skills properly list files & resources section
- harden path resolution / path escape prevention for filesystem-related tools, default workspace boundary to cwd
- file-attachment no longer triggers in the middle of email addresses
- internals - add short import path aliases (`@core/`, `@utils/`, `@extensions/`, `@package.json`)
- html-to-md (fetch) - strip unsafe images and links
- use unified fetch wrapper everywhere, consistently use user agent string with hotdog version
- fix - rebuild system prompt when model changes
- subagents - fix result double-appended

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.3.6...v0.4.0

## [v0.3.6] - 2026-08-02

- interactive cli - added tab completions for slash commands, \@file-attachments, and shell mode.
- shell mode - better command foregrounding; color support
- shell mode - can now send the command & results to the agent by using the suffix `| @`.
  May include an optional note after that, for example `bun run test | @ review the failing tests.`
- better error output in logs

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.3.5...v0.3.6

## [v0.3.5] - 2026-07-31

- new extension: file-attachment - picks up on @file-include syntax in direct user input to automatically include files into the context.
- fixes in configuration system where missing values were silently dropped in favor of defaults; most noticeably in compaction context limit.
- `/model` switch now validates the target model and prints an error if not found.
- shortened handoff system prompt chunk.
- agents-md - added clear instructions to read docs before edits in system prompt chunk.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.3.4...v0.3.5

## [v0.3.4] - 2026-07-29

- add `fetchModels` option to provider config to automatically load model list from backend if supported (llama-swap tested)
- add maxToolCallsPerIteration to prevent runaway tool call storm
- webui: hide empty chat messages, eg during rapid tool calls
- md-to-html / webui: better handling of escape sequences like `\\`
- html-to-md / fetch: strip data: images which can be very long
- add transient / agent retry-able with hint error types
- fix: slash commands arguments no longer always lowercased
- more fixes and code cleanup

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.3.3...v0.3.4

## [v0.3.3] - 2026-07-26

- All tools now require a `sideEffects: bool` definition to indicate if they have any capacity for destruction, RCE, or exfil.
- Added `--sandbox` mode, which disables all tools with sideEffects.
- Added tool `difficulty: number (1-5)` indicating which tools are easier/harder to use, which can be used for automatically hiding more complex tools from smaller models that they would struggle with by setting a `max-tool-difficulty`/`maxToolDifficulty` on the model configuration.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.3.2...v0.3.3

## [v0.3.2] - 2026-07-24

- add "handoff" tool allowing the assistant to prepare a context, then start fresh on that in a new context window, as an alternative technique to compaction
- webui - add cold session history viewing/resuming
- webui - session switching and reload resume bug fixes
- fix - avoid mangling system prompt message
- core tool `write` rework into simpler tools that are easier for current llms to understand and use -> `overwrite` & `append`
- tool definitions cleaned up, base system prompt reduced ~5k -> 3.5k

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.3.1...v0.3.2

## [v0.3.1] - 2026-07-21

- add utils/md-parser, one-shot and streaming md->ast->html transforms
- webui - render md into better-looking html
- reworked internals between agent and ui, add SessionManager, Channels

Dev Notes: The webui is really coming along, but at the same time it's still rough. Particularly buggy around switching sessions - I want to lock down the state handling there next, then add cold session loading to it, profile switching, session forking, and settings management.

cli feels fairly solid to me in the current shape, although you can't do a whole lot while it's streaming. I am experimenting with wrapping stdout in another stream to keep the input prompt below the streaming output but it's super experimental right now and not solid enough to ship. I'll keep playing with it but this will unlock easy multi-agent switching and then we can open up autocomplete.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.3.0...v0.3.1

## [v0.3.0] - 2026-07-19

**Breaking Changes**

- rename prompt shorthand `-c` flag to `-p` to mirror most other tools
- rename `hotdog review` subcommand to `hotdog sessions show`

**Other Changes**

- add `sessions delete <id>`
- add `sessions cleanup [n-days: default 30]`
- internal code cleanup and type updates

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.2.1...v0.3.0

## [v0.2.1] - 2026-07-18

- grep - fix "No matches found" when path is a specific single file.
- add `/loop Some prompt here` command
- code cleanup and type improvements

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.2.0...v0.2.1

## [v0.2.0] - 2026-07-15

- Ported the codebase from JS->TS -- still some rough edges to iron out but mostly looking good.
- question tool - fixed it to prompt now instead of skip with an error
- bash tool - add env vars to get cleaner output for 3rd party tools, easier for agent to use (`TERM=dumb,NO_COLOR=1,CI=true,AGENT=1,GIT_EDITOR=cat,GIT_TERMINAL_PROMPT=0`)
- webui - fixed issues and worked on the interface to bring it up to a basic usable point (still has some visual bugs and no cold session resume yet)
- skills - fixed loading issues
- updated configuration system to do more runtime validation
- improved test suite
- file path handling - added simple autocorrects for paths input handling for various tools that hit the filesystem

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.1.5...v0.2.0

## [v0.1.5] - 2026-07-08

- webui stability fixes
- interactive cli shell mode - added word filter list for basic common words likely to trigger a false positive such as `if` / `yes` etc

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.1.4...v0.1.5

## [v0.1.4] - 2026-07-07

- [BRK] removed old /sh command extension in favor of --shell-mode
- fixed and fleshed out output for ui-info commands
- fixed some issues around config loading
- improve llm-client sse perser to be more robust
- improved tool error handling
- improved hooks for extension development

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.1.3...v0.1.4

## [v0.1.3] - 2026-07-05

Ironed out some issues around the display in interactive cli, fixed a couple bugs like double-print user messages, too few/too many line breaks.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.1.2...v0.1.3

## [v0.1.2] - 2026-07-05

Some bugfixes in this release; also added the config reference docs and expanded on the examples.

**model**

- fix: `/model switch` no longer incorrectly clears the message log, keeps conversation history

**fetch**

- fix: output returning [object Object] when using md
- fix: use internal html->md function instead of invoking pandoc when using md output

**web-search**

- improvement: use proper HTML parser (bun HTMLRewriter) instead of regex for ddg search

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.1.0...v0.1.2

## [v0.1.0] (aka v0.1.1) - 2026-07-03

Well, hot-dog! I guess it's about cooked.

Here's what's stable and solid:

- One-shot prompt mode (`hotdog prompt "Hey! What's the word?"`)
- Interactive cli -- simple, but works great for one interactive session. `hotdog` or `hotdog cli`
- Extension system base -- I am happy with where this is at generally and ready to build on the foundations.
- Declarative config system.
- Profiles, aspects, skills, tool calling.

Experimental stuff that may be broken:

- explore tool (disabled by default).
- websocket/webui -- this part is rough; session swapping seems broken. Cleaning these up is my main goal for 0.2.0.

Features that generally work but have rough edges:

- Compaction. Not all strategies tested; haven't explored all the potential failure modes.
- Marker mangler / io escaping pipeline needs work, customizable tokens per model/backend, different format support, converting to extension.
- Tool result formatting - should be configurable/swappable via extension system; a bit too simplistic right now; needs work with io escaping pipeline.

**Full Changelog**: https://github.com/devoidfury/hotdog/releases/tag/v0.1.0
