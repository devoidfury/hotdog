# Security Policy

## Supported Versions

Until we hit v1.x.x, only the latest minor version is supported.

## Execution Boundary (tool exec plane)

By default (`toolExec: "worker"`, `docs/config-reference.md`) the tools tagged
for the execution plane -- today `bash`, `read`, `grep` -- run in pooled
out-of-process executors, not inside the agent process:

- Tool crashes are events, not process deaths.
- Provider keys and websocket auth secrets never enter the tool plane (env is
  scrubbed at the broker spawn; the config files are not mounted into the
  jail). `envScrubbing: false` is honored plane-wide: that opt-out hands the
  broker -- and through it every pool entry -- the full environment copy, so
  the "keys never enter" property is exactly as switched-off as it is inline.
- Session-log records are physically unwritable by tool-executed code when
  the fence is up and the sessions directory lives outside the workspace
  roots. With the fence down (`toolExec: "inline"`, a failed probe, macOS) or
  a sessions dir inside a jail's rw roots, the records are ordinary files and
  only the workspace checks stand between tool code and them.
- Workspace roots and deny patterns become OS-enforced for tagged tools where
  the platform fence works: on Linux with bubblewrap (`execFence: "probe"`),
  each entry gets a fresh tmpfs root with read-only system dirs and read-write
  ONLY the session's workspace roots, inside its own PID/IPC/UTS namespaces
  (jailed code sees and can signal no host process) -- no `$HOME`, no config
  chain, no sibling session roots. `hotdog info` reports the posture
  (`fence: bwrap`, `off`, or `none -- probe failed`); the plane never fails
  open silently.
- Per-session jails: cross-workspace reads via `bash` are structurally
  impossible for tagged tools when the fence is up.

What the plane does NOT buy:

- Prompt-injection defense (the marker mangler and spoof neutralizer, unchanged).
- In-fence abuse: deleting the workspace, egress over the permitted network,
  or exfiltration through the model channel itself.
- Allowlist quality is policy: anything bound into the jail is readable.
- `toolExec: "inline"`, a failed probe, or macOS/Windows (no jail backend yet):
  the plane is pooled but unfenced, and says so. The general advice stands --
  a dedicated host, VM, or container is recommended.

Disclosure shift: for tagged tools behind a working fence, the workspace/deny
guarantee moves from advisory to enforced. A jail or plane escape is a
reportable vulnerability under this policy.

## Network Policy (fetch-policy)

On by default: model-triggered HTTP answers to an origin policy
(`fetchPolicy`, `docs/config-reference.md`). The `fetch` tool is gated on the
request URL and every redirect hop; child processes (`bash` -- inline or on
the plane -- and stdio MCP servers) are injected with `HTTP_PROXY`/`HTTPS_PROXY`
pointing at a loopback, token-authenticated policy proxy. Unknown origins
prompt a human; deny rules cannot be outvoted mid-run; every fail-closed path
blocks with the exact config line that would have allowed it.

Ceilings, stated plainly:

- **The proxy is cooperative, not a boundary.** Injection happens post-scrub
  and merges last (a child cannot keep its own proxy setting to opt out), but
  a process is free to ignore proxy variables altogether: raw sockets,
  `--noproxy`, an interpreter that never reads env. A determined script
  bypasses it, and that bypass is documented behavior, not a vulnerability.
- **Loopback is out of policy by design -- cooperatively.** The injected `NO_PROXY` keeps
  `127.0.0.1`/`localhost`/`::1` direct so local dev services work; the cooperative proxy never sees
  loopback traffic. Under `fetchPolicy.hardEgress` this inverts on purpose: `NO_PROXY` is empty, loopback
  connects arrive at the policy, and they are refused (loopback exists nowhere the jail can reach) unless
  `hardEgressLoopback: true` makes them ask like any origin.
- **The kernel-enforced layer is opt-in and never degrades.** The fence's `no-egress` class
  (`--unshare-net`, a fresh netns with no routes) blocks egress for real. `fetchPolicy.hardEgress` goes
  further: every fenced child runs in a private network namespace created **before exec**, and the jail's
  only exit is the policy proxy itself -- a loopback port bridged to a per-session UNIX socket, where the
  same allow/ask/deny decisions are made. Attribution is double-bound (the socket it came through AND the
  session's token must name the same owner; a borrowed socket or a stolen token alone is a 403). Ignoring
  the proxy env is no longer a bypass: an empty netns has no route to bypass *to*. Both tiers refuse the
  spawn rather than run unfenced when the jail is unavailable (no bwrap, no unprivileged userns,
  `execFence: "off"`, or an inline tool path), and `hotdog info` reports the posture (`Net Block: bwrap |
  off | unavailable -- no --unshare-net jail`; `hard-armed` / `hard-unavailable` for `hardEgress`). Hosts
  without either have no egress control beyond the cooperative proxy -- say so to yourself before granting
  `bash`.

## Reporting a Vulnerability

Report any discovered vulnerability to devoidfury at `hotdog.agent.hotline@gmail.com` or via `furycodes.com`.
I will acknowledge your report within a week, review the issue, and then either reject or accept the report.
If accepted I'll prioritize getting this fixed, released, and announced as soon as possible,
with your credit in the release notes.


