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
- Session-log records are physically unwritable by tool-executed code.
- Workspace roots and deny patterns become OS-enforced for tagged tools where
  the platform fence works: on Linux with bubblewrap (`execFence: "probe"`),
  each entry gets a fresh tmpfs root with read-only system dirs and read-write
  ONLY the session's workspace roots -- no `$HOME`, no config chain, no sibling
  session roots. `hotdog info` reports the posture (`fence: bwrap`, `off`, or
  `none -- probe failed`); the plane never fails open silently.
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

## Reporting a Vulnerability

Report any discovered vulnerability to devoidfury at `hotdog.agent.hotline@gmail.com` or via `furycodes.com`.
I will acknowledge your report within a week, review the issue, and then either reject or accept the report.
If accepted I'll prioritize getting this fixed, released, and announced as soon as possible,
with your credit in the release notes.


