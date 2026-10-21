#!/usr/bin/env python3
# Generic scripted PTY expect driver for the renderer-pty-3c test suite (host-only
# tooling; python stdlib only -- the zero-dep law binds src, not test rigs).
#
# Usage: python3 pty_driver.py <spec.json>
# Spec: {
#   "cmd":[argv...], "env":{...}, "cwd":"...", "rows":int, "cols":int,
#   "capture":path, "status":path, "probes":path, "total_timeout":secs,
#   "script":[
#     {"op":"expect","needle":str,"timeout":secs,"capture_pid":bool},
#     {"op":"send","data":str,"pre_pause":secs},
#     {"op":"sleep","secs":n},
#     {"op":"signal","sig":int,"from_captured_pid":bool},
#     {"op":"termios_probe","label":str}
#   ]
# }
# The pty child runs cmd[]; every master byte lands in capture raw. expect
# scans forward (each needle found once, in order); capture_pid records the
# digit run immediately after the match. termios_probe reads the pty's line
# discipline from the MASTER fd (it mirrors the slave state hotdog owns) and
# appends {label, echo, icanon} JSONL -- the physical raw-mode witness.
# Status json: {ok, fail_reason, ops_done, ops_total, child_exit, elapsed_ms}

import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
import fcntl


def write_status(state):
    with open(state["spec"]["status"], "w") as f:
        json.dump({
            "ok": state["ok"],
            "fail_reason": state.get("fail_reason"),
            "ops_done": state["op_index"],
            "ops_total": len(state["spec"]["script"]),
            "child_exit": state.get("child_exit"),
            "elapsed_ms": int((time.monotonic() - state["t0"]) * 1000),
        }, f)


def main():
    with open(sys.argv[1]) as f:
        spec = json.load(f)

    master, slave = pty.openpty()
    # Winsize BEFORE spawning: hotdog reads stdout.columns/rows at mount, so
    # a late ioctl would race the session (the narrow scenario pins cols).
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", spec["rows"], spec["cols"], 0, 0))

    pid = os.fork()
    if pid == 0:
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        os.dup2(slave, 0)
        os.dup2(slave, 1)
        os.dup2(slave, 2)
        if slave > 2:
            os.close(slave)
        os.close(master)
        os.chdir(spec["cwd"])
        try:
            os.execvpe(spec["cmd"][0], spec["cmd"], spec["env"])
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("pty exec failed: %s\n" % e)
            os._exit(127)

    os.close(slave)
    state = {"spec": spec, "t0": time.monotonic(), "op_index": 0, "ok": True, "child_exit": None}
    cap = open(spec["capture"], "wb")
    probes_path = spec.get("probes")
    buf = bytearray()
    scanned_from = 0
    total_deadline = time.monotonic() + float(spec.get("total_timeout", 180))
    captured_pid = None
    child_done = False
    all_ops_done = len(spec["script"]) == 0
    drained_at = None
    pending_op_index = None   # expect-op currently being waited on
    pending_deadline = 0.0

    def run_instant_ops():
        # Everything except expect happens immediately when reached; expect
        # advances only when its needle is present. Returns (done, err).
        nonlocal scanned_from, captured_pid, all_ops_done, pending_op_index
        while state["op_index"] < len(spec["script"]):
            op = spec["script"][state["op_index"]]
            kind = op["op"]
            if kind == "expect":
                needle = op["needle"].encode("utf-8")
                idx = buf.find(needle, scanned_from)
                if idx < 0:
                    return False, None
                scanned_from = idx + len(needle)
                if op.get("capture_pid"):
                    m = re.match(rb"(\d+)", bytes(buf[scanned_from:]))
                    if not m:
                        return False, "capture_pid set but no digits after needle"
                    captured_pid = int(m.group(1))
                state["op_index"] += 1
            elif kind == "send":
                time.sleep(float(op.get("pre_pause", 0.05)))
                os.write(master, op["data"].encode("utf-8"))
                state["op_index"] += 1
            elif kind == "sleep":
                time.sleep(float(op["secs"]))
                state["op_index"] += 1
            elif kind == "signal":
                target = captured_pid if op.get("from_captured_pid") else pid
                if target is None:
                    return False, "signal op with no pid captured"
                os.kill(int(target), int(op["sig"]))
                state["op_index"] += 1
            elif kind == "termios_probe":
                if probes_path:
                    lflag = termios.tcgetattr(master)[3]
                    with open(probes_path, "a") as pf:
                        pf.write(json.dumps({
                            "label": op.get("label", "probe"),
                            "echo": bool(lflag & termios.ECHO),
                            "icanon": bool(lflag & termios.ICANON),
                        }) + "\n")
                state["op_index"] += 1
            else:
                return False, "unknown op %r" % kind
        all_ops_done = True
        return True, None

    try:
        while True:
            now = time.monotonic()
            if now > total_deadline:
                state["ok"] = False
                state["fail_reason"] = "total_timeout with %d ops left" % (len(spec["script"]) - state["op_index"])
                break
            done, err = run_instant_ops()
            if err:
                state["ok"] = False
                state["fail_reason"] = err
                break
            if all_ops_done and child_done and drained_at is None:
                drained_at = now  # let the stty tail land, then finish
            if all_ops_done and drained_at is not None and now - drained_at > 1.0:
                break
            # Per-op timeout for the pending expect (if any).
            if not done and state["op_index"] < len(spec["script"]):
                op = spec["script"][state["op_index"]]
                if op["op"] == "expect":
                    if state["op_index"] != pending_op_index:
                        pending_op_index = state["op_index"]
                        pending_deadline = now + float(op.get("timeout", 30))
                    elif now > pending_deadline:
                        state["ok"] = False
                        state["fail_reason"] = "expect timeout (%ss): %r" % (
                            op.get("timeout", 30), op["needle"][:80])
                        break
                else:
                    pending_op_index = None
            else:
                pending_op_index = None
            r, _, _ = select.select([master], [], [], 0.2)
            if not child_done:
                wpid, wstatus = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    child_done = True
                    state["child_exit"] = os.waitstatus_to_exitcode(wstatus)
            if r:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    if all_ops_done:
                        break
                    state["ok"] = False
                    state["fail_reason"] = "pty EOF with %d ops left" % (len(spec["script"]) - state["op_index"])
                    break
                cap.write(chunk)
                cap.flush()
                buf.extend(chunk)
    finally:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pid, sig)
            except OSError:
                pass
        try:
            if not child_done:
                os.waitpid(pid, 0)
        except OSError:
            pass
        cap.close()
        os.close(master)
        write_status(state)

    sys.exit(0 if state["ok"] else 1)


if __name__ == "__main__":
    main()
