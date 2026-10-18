#!/usr/bin/env python3
"""Run darce-cli (ink TUI, requires a TTY) on a pseudo-terminal.

Feeds no input; the prompt is auto-submitted via the CLI arg. After a
fixed wait (reply completes), sends Ctrl+C and emits the captured
screen stream to stdout.
"""
import fcntl
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time

CLI = os.environ["HOTDOG_EVAL_HARNESS_DIR"] + "/darce-cli/dist/cli.js"


def main() -> int:
    prompt = sys.argv[1]
    wait_s = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0
    master, slave = pty.openpty()
    # 200 columns so single-line replies do not wrap
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))
    proc = subprocess.Popen(
        ["node", CLI, prompt],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    out = bytearray()
    start = time.time()
    sent = False
    while True:
        try:
            r, _, _ = select.select([master], [], [], 0.5)
            if r:
                data = os.read(master, 65536)
                if not data:
                    break
                out += data
        except OSError:
            break
        if not sent and time.time() - start >= wait_s:
            try:
                os.write(master, b"\x03")
            except OSError:
                pass
            sent = True
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
            break
    # drain any remaining bytes
    deadline = time.time() + 5
    while time.time() < deadline:
        r, _, _ = select.select([master], [], [], 0.2)
        if not r:
            break
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        out += data
    try:
        os.close(master)
    except OSError:
        pass
    sys.stdout.buffer.write(bytes(out))
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
