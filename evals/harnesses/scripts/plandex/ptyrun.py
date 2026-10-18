#!/usr/bin/env python3
"""Passive pty runner: exec a command on a pty, capture all output, no input."""
import os, pty, select, sys, time

log = open(sys.argv[1], "wb")
cmd = sys.argv[2:]
timeout = int(os.environ.get("PTY_TIMEOUT", "240"))
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
    os._exit(127)

t0 = time.time()
rc = None
while time.time() - t0 < timeout:
    r, _, _ = select.select([fd], [], [], 1.0)
    if fd in r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        log.write(chunk)
        log.flush()
    p, status = os.waitpid(pid, os.WNOHANG)
    if p == pid:
        rc = os.waitstatus_to_exitcode(status)
        break
if rc is None:
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    p, status = os.waitpid(pid, 0)
    rc = os.waitstatus_to_exitcode(status)
sys.exit(rc if rc is not None else 1)
