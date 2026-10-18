#!/usr/bin/env python3
"""Drive `plandex sign-in` on a pty: answer the survey prompts on cue."""
import os, pty, re, select, sys, time

argv = sys.argv[1:]
log_path = None
if argv and argv[0] == "--log":
    log_path = argv[1]
    argv = argv[2:]
LOG = open(log_path, "wb") if log_path else None

pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
    os._exit(127)

def emit(b):
    if LOG:
        LOG.write(b); LOG.flush()

buf = b""
sent = {"sel": False, "host": False}
deadline = time.time() + 90
rc = None
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.5)
    if fd in r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        emit(chunk)
        t = buf.decode("utf-8", "replace")
        if "Use local mode or another host?" in t and not sent["sel"]:
            os.write(fd, b"\n"); sent["sel"] = True
        if re.search(r"Host:.*http://localhost:8099", t) and not sent["host"]:
            os.write(fd, b"\n"); sent["host"] = True
        if "Signed in" in t:
            time.sleep(1.5)
            break
    p, status = os.waitpid(pid, os.WNOHANG)
    if p == pid:
        rc = os.waitstatus_to_exitcode(status)
        break
if rc is None:
    try: os.kill(pid, 9)
    except ProcessLookupError: pass
    p, status = os.waitpid(pid, 0)
    rc = os.waitstatus_to_exitcode(status)
sys.exit(rc if rc is not None else 1)
