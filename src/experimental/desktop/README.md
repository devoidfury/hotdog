# desktop (experimental)

`hotdog desktop` opens the WebUI in a real window: a small native shell
around the system's web engine, the way Tauri does -- minus Rust, minus a
build system, minus dependencies. Opt-in like every `@experimental`
extension: nothing loads until `extensionPaths` carries `@experimental`
(which **replaces** the default list, so keep both):

```json
{ "extensionPaths": ["@extensions", "@experimental"] }
```

## Modes

**Local (no argument).** This process hosts a private webui listener --
loopback, **ephemeral port**, a **random one-boot API key** (a configured
`webui.apiKey` never travels through the handoff), no proxy trust. It
self-logs-in over loopback, mints a session token, and opens the window at
`http://127.0.0.1:<port>/#tok=<token>`. Fragments never cross the wire: the
window parses the token on boot, scrubs it from history, and rides the normal
verify/activate path (webui/ui/login.tsx). Closing the window drains agent
sessions through the same commit-point drain the `hotdog webui` SIGINT path
uses. A lockfile under the data dir (`<data>/desktop/instance.json`) refuses
a second local stack and answers with the running port.

**Remote (one URL argument).** No server here: a window onto an existing
hotdog WebUI, whose own login screen owns auth. Admission:

- `https://` anywhere: allowed.
- Self-signed / intranet certs: WebKit blocks the load, the shim prints the
  certificate's SHA-256 (openssl-style) and asks once on the terminal.
  `yes` -- or typing the fingerprint back -- trusts exactly that certificate
  for that host for that launch (host-scoped, in-memory, never persisted).
  `HOTDOG_DESKTOP_TRUST=<sha256-fingerprint>` skips the prompt; a pin that
  does NOT match refuses WITHOUT asking, because a changed certificate is
  the moment not to nag.
- `http://` **loopback names only** (127.x, localhost, `*.localhost`, `::1`)
  -- the `ssh -L 8420:127.0.0.1:3000 host` tunnel shape.
- Cleartext http beyond loopback: refused. There is deliberately no
  `--allow-insecure`: the webui session token is a bearer credential over
  plain HTTP, and a desktop launcher is the last place that should be
  normalized. TLS in front of the server (reverse proxy with `webui.
  trustedProxy` set) is the supported remote posture.
- URL credentials and `#...` fragments: refused (login belongs to the
  window; the token handoff belongs to the local launcher).

**Boot posture.** The subcommand declares `skipRemoteModelFetch`, so hotdog
boots without the providers' `/v1/models` round trips -- a remote window
opens in ~100 ms even with dead or offline providers (no five-second
catalog timeout in front of it, no `Failed to fetch remote models` noise).
Local mode pays the fetch honestly: it hydrates the catalog itself
(`hydrateModelRegistry`) after taking the instance lock and before serving,
so webui sessions get the same dynamic catalogs `hotdog webui` gets.

**Unreachable server** (link down, DNS dead, tunnel not up yet): the window
no longer sits white with WebKit's cryptic "Operation was cancelled." page.
The shim prints the real error (message + domain + code) to the terminal,
renders a failure page naming the target and the reason, and retries every
3 seconds -- when the server answers, the app appears without a relaunch.
The printed and rendered URL drop the `#tok=` fragment. A TLS refusal still
exits; once the real document has committed, later network drops reach the
terminal only (the webui's own websocket-reconnect UI covers the app side).

Every WebKit load call the shim makes (failure page, TLS reload, the TOFU
decision itself) runs from an idle callback, never inside a signal
emission. And two WebKitGTK API traps this shim walked into, learned the
hard way from a `free(): invalid size` abort (SIGABRT, exit 134):
`webkit_web_view_get_uri`/`get_title` return **const internal pointers**
(never g_free them -- the first successful commit aborts the process), and
`load-failed` really marshals **three** arguments `(load_event, uri,
error)` despite the docs' two-argument callback signature. A window
process that dies on its own is no longer silent: hotdog reports
`[desktop] the window exited unexpectedly (code N)` and exits 1; only a
signal-quit (Ctrl+C / window close) reads as success.

## The window chain

`launcher.ts` resolves once per boot; first rung that holds wins:

1. **WebKit shim, compiled on demand**: `shims/linux.c` (WebKitGTK) or
   `shims/macos.m` (Cocoa + WKWebView, compiled with `clang`; the `CC`
   env is honored on Linux only). On Linux the module is probed
   in order -- `webkitgtk-6.0` (GTK4 umbrella `<webkit/webkit.h>`), then
   `webkit2gtk-4.1` (GTK3 umbrella `<webkit2/webkit2.h>`) -- each asked
   ALONE, because the two are mutually exclusive stacks whose own Requires
   drag in the right GTK. (A combined `gtk4 webkit2gtk-4.1` request
   "succeeds" on any machine that happens to hold both and hands the
   compiler a poisoned include path; that trap is what the ordering fixes.
   The shim branches on `GTK_CHECK_VERSION`.) On macOS there is no
   pkg-config: fixed flags (`-fobjc-arc -mmacosx-version-min=11.3
   -framework Cocoa -framework WebKit -framework Security`), and after a
   successful build the binary is **ad-hoc codesigned** (`codesign
   --force --sign -`; Apple Silicon refuses to launch WKWebProcess
   against an unsigned main binary -- a missing or failing `codesign`
   warns and proceeds, the spawn failure still falls through the chain).
   A `-Wl,-sectcreate,__TEXT,__info_plist,<plist>` flag embeds an ATS
   exception of `NSAllowsLocalNetworking` only: WKWebView applies ATS to
   unbundled binaries, so without it local mode's `http://127.0.0.1:<port>`
   and ssh -L tunnels never load, while the https posture for everything
   else stays whole.
   Both binaries are cached under `<data>/desktop/<shim|shim-macos>-<hash>`
   keyed by source bytes + flags + arch, so they rebuild only when what
   they compile against changes. The shim takes the URL on **stdin**
   (argv is world-readable through /proc and the local URL carries the
   token), and exits when the window closes. Parent-death: Linux uses
   `PR_SET_PDEATHSIG`; macOS has no such call, so `macos.m` polls
   `getppid()` once a second and exits when it changes (a SIGKILLed
   parent must not leave a window on a dead server).
   The macOS shim mirrors the Linux contract: same-origin navigation
   gate with everything else to the system browser, new windows refused,
   TOFU through `didReceiveAuthenticationChallenge` (one prompt covers
   subresources too; the `HOTDOG_DESKTOP_TRUST` pin has the same
   semantics and the same fingerprint string), failure page + 3s retry
   until the first commit, downloads into `~/Downloads` via the `WKDownload`
   hooks (macOS 11.3+, which is why the min target is 11.3), uploads via
   NSOpenPanel and JS `confirm()` via NSAlert (unlike GTK, WKWebView
   routes both to the client and **silently cancels** them when
   unimplemented -- the webui needs both), and
   `setActivationPolicy:Regular` so a bundleless binary actually shows a
   focused window. Data is `nonPersistentDataStore`: ephemerality matches
   the Linux shim; remote mode re-logs in every launch.
2. **Chromium-family browser in app mode** (`--app`, dedicated
   `--user-data-dir` under the data dir): no address bar, own taskbar entry,
   browser process lifetime = window lifetime. On macOS `Bun.which` never
   resolves inside `.app` bundles, so candidates are probed by absolute
   path (Chrome, Chromium, Edge, Brave; Safari has no app mode). Cost,
   logged at startup: the token rides argv (same-uid `ps` visible) and
   that profile's storage.
3. **Print the URL.** The process waits for SIGINT/SIGTERM.

A shim that spawned but exited nonzero is reported, never chained -- a second
window would double the session. Only probe/compile/spawn failures fall through.

No native bridge exists in any rung. The webui's websocket is the entire app
protocol; the window is a dumb terminal, which is what makes pointing the
shim at a remote server exactly as safe as a browser tab.

## Live-config interactions (shared machinery, documented not special-cased)

- A `webui.port` write **rebinds the live local listener** to the stored
  port; the window's URL goes stale (app mode has no address bar to edit),
  so restart the desktop app after moving the port.
- A `webui.apiKey` write replaces the boot key for **future** logins;
  issued tokens -- including the window's -- survive to their TTL, which is
  auth.ts's carried-state contract.

## Ceiling notes (v1, stated honestly)

- Shim **compile is unverified in the dev sandbox** for both platforms:
  no GTK headers installable there, no clang/SDK at all. The chain's
  fallbacks are test-covered; `tests/extensions/desktop-shim-macos-smoke.
  test.ts` compiles `macos.m` with the real launcher flags and checks the
  ATS section + ad-hoc signature -- but only on a Mac; elsewhere it skips
  with the reason in the describe title. First-run compile errors print
  the compiler's words before falling back. Real-window behavior
  (activation, TOFU prompt, downloads) is manual-verification territory.
- macOS TOFU: consent is per-session in memory and the challenge covers
  document + subresources (no webkit2gtk-style ignore-policy gap), but a
  `wss://` socket opening against a freshly-pinned cert has not been
  exercised -- same report-me corner as the Linux note below.
- macOS data store is non-persistent by design: remote mode re-logs in
  every launch (no cookie/session carry-over in v1). No save panel and no
  JS `prompt()` dialog (the webui uses neither; confirm/alert are
  implemented because it does use them).
- The lockfile is a pid file: a recycled pid can misreport a dead instance
  as running (accepted ceiling; clean exit always releases).
- Remote mode is the dumb terminal: TLS trust is TOFU-prompt-or-pin, nothing
  else -- no client certs, no persisted pin store (re-prompt every launch;
  pin via env if that's noise). Trust lands on the page load, per host;
  trusted-cert pages that still refuse the `wss://` socket would be a corner
  this shim hasn't exercised -- report it if you land in it.
- Downloads save silently to the OS Downloads dir (Linux: the webview
  default; macOS: the WKDownload destination, uniquified, no save dialog).
  User-triggered from the webui's own buttons, but a page CAN also drop
  files there unattended; the trust ceiling is "your own servers and
  tunnel endpoints".
