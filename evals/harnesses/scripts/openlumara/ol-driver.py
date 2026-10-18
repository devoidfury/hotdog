"""Driver for openlumara's cli_lite channel (stdin REPL, no one-shot mode).

Feeds the prompt on stdin (EOF right after). The app prints the model
response and then keeps running (EOF only kills the channel task;
non-debug manager swallows it, so the process never exits). After the
response settles this driver sends SIGTERM and exits 0.
Completion rule: >=20s elapsed (startup is ~1s) AND >=6s output silence
(only startup noise appears before the response; the response is a single
non-streaming print).
"""
import os
import select
import signal
import subprocess
import sys
import time

PROMPT = sys.argv[1]
CWD = os.getcwd()
BIN = os.environ.get("HOTDOG_EVAL_VENV_DIR", "/opt/harnesses") + "/openlumara/venv/bin/python"


def main():
    t0 = time.time()
    deadline = t0 + 240
    p = subprocess.Popen(
        [BIN, "main.py", "--quiet", "--disable_auto_installer"],
        cwd=CWD,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        p.stdin.write((PROMPT + "\n").encode())
        p.stdin.close()
    except BrokenPipeError:
        pass
    last_output = None
    saw_output = False
    while time.time() < deadline:
        ready, _, _ = select.select([p.stdout], [], [], 0.5)
        if ready:
            try:
                chunk = os.read(p.stdout.fileno(), 65536)
            except OSError:
                break
            if not chunk:
                break
            os.write(sys.stdout.fileno(), chunk)
            saw_output = True
            last_output = time.time()
        else:
            if (
                last_output is not None
                and time.time() - last_output >= 6
                and time.time() - t0 >= 20
            ):
                break
    rc = p.poll()
    if rc is None:
        p.send_signal(signal.SIGTERM)
        try:
            rc = p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()
            rc = p.wait()
    # killed-after-response is the normal path: success iff we saw output.
    if rc == 0 or saw_output:
        sys.exit(0)
    sys.exit(rc if rc and rc > 0 else 1)


if __name__ == "__main__":
    main()
