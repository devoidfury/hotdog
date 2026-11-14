# agent-browser (experimental)

One model-facing tool, `agent_browser`, driving headless browser views on
[`Bun.WebView`](https://bun.com/docs/runtime/webview) (experimental API; requires
bun >= 1.4.3). Opt-in: nothing loads until the user adds `@experimental` to
`extensionPaths` (which **replaces** the default `@extensions` list, so keep both).

```json
{ "extensionPaths": ["@extensions", "@experimental"] }
```

## Tool

`agent_browser` takes an `action` enum plus per-action args. Views are named,
keyed by the calling hotdog `sessionId`, and survive across tool calls (a
session's views are closed on `session:end`).

| Action | Args | What it does |
|--------|------|--------------|
| `open` | `url`, `view?` | Create (or replace) a named view and load an http(s) URL. |
| `navigate` | `url`, `view?` | Load a URL in an existing view. |
| `snapshot` | `view?` | Structured text of interactive elements: tag, id/class/name/type/role, aria label, text snippet, bounding-box center `(x,y)`. |
| `click` | `selector` or `x`+`y`, `view?` | Click a selector (waits for actionability, 10s cap) or raw viewport coordinates. Raw x/y outside the **measured viewport** are refused with that frame named; nothing is dispatched. `open`/`snapshot`/`screenshot` print the measured frame. |
| `type` | `text`, `view?` | Insert text into the focused element. |
| `press` | `key`, `view?` | Press a key (`Enter`, `Tab`, `Escape`, arrows, a single character...). |
| `screenshot` | `view?` | Viewport-only capture; attaches an image part for vision-capable models, otherwise path + text stub. Always saved under the session's directory. |
| `evaluate` | `script`, `view?` | Run **model-authored** JavaScript (an expression, awaited) inside the loaded page. Approval-gated, see below. |
| `close` | `view?` | Close one named view, or all of the session's views. |
| `list` | -- | The session's views with URL/title and the cap. |

## Owner rulings (non-negotiable, all enforced by tests)

1. **Placement**: `src/experimental/agent-browser/`; opt-in via `extensionPaths`,
   never in `@extensions`.
2. **One tool** with the action enum above. Sessions keyed by the calling hotdog
   `sessionId`; `SESSION_END` closes the session's views (the repo's known leak
   pattern, pinned by a test). Hardcoded cap: **3 views per session** -- open
   beyond it errors with a hint, open on an existing name replaces (closes) it.
   Ephemeral storage only (`dataStore: "ephemeral"`, Bun.WebView's default,
   spelled explicitly); **no persistent dataStore in v1**. Chrome backend is
   **spawn-forced**: `backend: { type: "chrome", url: false }` -- Bun never
   auto-connects to a stray `DevToolsActivePort` browser; model tabs cannot land
   in the user's running Chrome.
3. **Navigation admission**: https-or-http only; the host is resolved and
   private/reserved ranges are **blocked, loopback included**, reusing fetch-tool's
   classifier (`assertPublicHost`, imported, not forked). Config:
   `agentBrowser.allowLoopback` (boolean, default `false`) additionally admits
   the loopback literals (`localhost`, `127/8`, `::1`) and nothing else.
   `onNavigated` re-checks every landed URL (redirects and page-initiated jumps
   fire it) and navigates the view to `about:blank` when a disallowed host was
   reached; the tool call that triggered it reports the guard error, later calls
   surface one WARNING line.
4. **`evaluate` (model-authored JS)** rides the user-gate `TOOL_CALL` approval,
   so it prompts and supports "allow for session". Wiring (see
   `src/utils/approvals/`): for `action === "evaluate"` the extractor makes the
   **script itself** the approval target and flags the call `bailOnToolAllow`,
   so `decide()` ignores a blanket tool-level `allow: ["agent_browser"]` entry
   and also refuses to let `userGate.default: "allow"` admit it (bail semantics:
   only a matching **param rule** -- `agent_browser.script=<glob>` -- or a human
   at the prompt lets it through; under the `"deny"` allowlist default it
   denies). The session memo keys on the exact script, so "allow for session"
   covers *that* script, not every future one. Where no prompt surface exists
   (one-shot mode, CI, or user-gate not enabled at all), the tool **refuses**
   `evaluate` at execute time, fail closed, before touching the page.
   `snapshot` is *not* that path: its extraction script is fixed code shipped in
   `index.ts` and runs ungated by design.
5. **`snapshot`** is extension-internal structured extraction (tag, id/class/
   name/aria label, text snippet, bounding-box center) run via `view.evaluate`
   in the extension's own code -- deliberately a separate code path from the
   gated model `evaluate` (the two never share entry points). Output is capped:
   200 elements, 150 lines via the house `truncateOutput` seam.
6. **`screenshot`** is viewport-only with a **1.5 MB source-byte budget**: PNG
   first; if over budget, `Bun.Image` re-encodes jpeg down a quality/width
   ladder (q75 → q55 → 800px q55 → 600px q40). Image parts bypass the tool-result
   char caps (review 11-02 frame-cap H-1), so the fence is on the source bytes:
   if nothing fits, the file is saved to disk and **never attached**. Attaches an
   image part (`image_url` idiom, same as the read tool) for vision-capable
   models only; others get path + text stub. Files save under the session's
   directory (`sessionsDir`, honoring `HOTDOG_SESSIONS_DIR`); an unsafe session
   id falls back to a private tmp dir instead of traversing.
7. **Testability**: views are constructed through the injectable `ViewFactory`
   seam (no `mock.module` anywhere). Unit tests run against a fake view
   (routing, gating, lifecycle, caps); one real-chromium smoke test is gated on
   browser presence and skips loudly (reason in the describe title) otherwise.
8. **Config**: exactly one key, `agentBrowser.allowLoopback` -- no `enabled`
   key either; loading `@experimental` *is* the opt-in. See
   `docs/config-reference.md`.
9. **Viewport honesty** (the raw-click offset fix): the constructor's
   width/height size the Chrome **window**, so `open` calls
   `resize(1280, 900)` (a layout-viewport override that survives navigate)
   once the first page commits -- Chrome rejects it on an un-navigated view
   (`Emulation.setDeviceMetricsOverride` wasn't found) -- then measures
   `{innerWidth, innerHeight, devicePixelRatio}` page-side through the
   extension-internal evaluate seam (fixed script, never the gated model
   `evaluate`) and caches the frame on the view. `open`, `snapshot` and
   `screenshot` publish that measured frame; raw `click` x/y outside it -- or
   non-finite -- are refused with the measured dimensions named and nothing
   dispatched. Deliberately **no rescaling**: guessing which frame a caller
   meant compounds the bug, a loud refusal plus a published frame is honest.
   An unmeasurable frame turns raw aims into refusals, never into aiming in
   an assumed frame.

## The network ceiling, honestly

This is **navigation admission only**. What is fenced:

- the URL given to `open`/`navigate`, and
- every URL the view actually **lands on** (redirects, meta-refresh,
  `location.href` jumps), enforced after the fact by returning the view to
  `about:blank`.

What is **not** fenced:

- **Subresources, XHR/fetch, WebSocket, form posts** initiated by an admitted
  page can address anything the browser can reach, including private space. The
  admission gate judges the document URL, not the page's requests.
- **`evaluate` runs model-authored JavaScript inside whatever page is loaded**
  -- from that page's origin it can make the same unfenced requests (subject to
  CORS for reading responses). Its consent surface is the approval prompt, not
  the network policy.
- **A `click` on a page-provided `javascript:` href or auto-redirecting anchor
  executes page JavaScript with no prompt** -- the scheme gate judges the URLs
  the model passes to `open`/`navigate`, not links the page itself supplies, so
  page-driven JS execution sits in the same unfenced family as `evaluate` above.
- **DNS rebinding**: like fetch-tool's identical gate (the ceiling is documented
  at its source), the host is resolved at check time and re-resolved at connect
  time; a hostile resolver can split those answers. Closing it would mean pinning
  the connection to the resolved IP, which breaks SNI/virtual hosting.
- A public host that itself proxies to private space (the usual DNS-rebind
  services) passes every check here, because the *resolved address* is public.

Do not treat this extension as a sandbox. Run hotdog in a container/VM if the
threat model includes a page or script reaching the host network.

## Hardcoded limits (documented, not config -- ruling 8 forbids speculative keys)

| Limit | Value |
|-------|-------|
| Views per session | 3 |
| Viewport | 1280x900 -- but the `Bun.WebView` constructor sizes the Chrome **window**, so after the first page commits every view is `resize()`d to pin the **layout viewport** to 1280x900 (Chrome rejects the override on an un-navigated view); the frame is then measured page-side and printed on `open`/`snapshot`/`screenshot` (a Chromium build where the pin does not hold shows a smaller measured frame, e.g. 1280x813). Raw `click` x/y outside the measured frame are refused. |
| Selector-click wait | 10s |
| Snapshot elements / lines | 200 / 150 |
| Screenshot inline budget | 1.5 MB (source bytes) |
| Evaluate result | 8000 chars |

## Tests

- `tests/extensions/agent-browser.test.ts` -- fake-view unit tests (routing, cap,
  admission matrix, redirect egress, snapshot caps, screenshot budget ladder,
  evaluate refusal, SESSION_END leak pin, viewport pin: resize-after-initial-
  load ordering, measured-frame publication on open/snapshot/screenshot,
  the raw x/y viewport gate including the unmeasured-frame refusal). The
  `{x:10, y:20}` passthrough pin proves in-range coordinates reach the view
  untransformed. Writes only under a tmp `HOTDOG_SESSIONS_DIR`.
- `tests/extensions/agent-browser-smoke.test.ts` -- real chromium, loopback
  fixture with `allowLoopback: true` (a `data:` URL cannot be used: the very
  admission ruling above would egress it); pins the measured frame to the
  requested 1280x900 (the 87 px band regression), asserts the PNG IHDR matches
  it, clicks the fixed-bottom strip at `innerHeight - 5`, and rejects a raw
  aim `innerHeight + 40`; skipped with a loud title when no chromium is found.
- Approvals wiring pins: `tests/utils/approvals/{rules,extract}.test.ts` and the
  `agent_browser evaluate through the gate` block in
  `tests/extensions/user-gate.test.ts`.
