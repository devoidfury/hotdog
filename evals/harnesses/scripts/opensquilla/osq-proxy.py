"""Minimal stdlib pass-through proxy for the local gateway's /v1 endpoints.

The gateway's OpenAI stream quirk (verified on 2026-10-11): after the
terminal choices frame (finish_reason != null) it may emit a duplicate
terminal frame before [DONE]. OpenSquilla's strict stream-order validator
rejects any frame after the terminal one ("stream mutated state after
finish_reason"), so the proxy drops duplicate terminal frames (no new
content, no reasoning, no tool calls, no usage) and passes everything
else through byte-for-byte.
"""
import json
import os
import socket
import sys
import threading
import urllib.error
import urllib.request

GATEWAY = os.environ["OSQ_GATEWAY"]
KEY = os.environ["OSQ_PROXY_KEY"]
_counter = [0]


def _dup_terminal(obj, seen_terminal):
    if not seen_terminal:
        return False
    choices = obj.get("choices")
    if not isinstance(choices, list) or len(choices) != 1:
        return False
    choice = choices[0]
    if not isinstance(choice, dict) or choice.get("finish_reason") is None:
        return False
    delta = choice.get("delta")
    if not isinstance(delta, dict):
        return True
    if delta.get("content") or delta.get("reasoning_content") or delta.get("tool_calls"):
        return False
    if isinstance(obj.get("usage"), dict) and obj["usage"]:
        return False
    return True


def _rewrite_frame(data: bytes):
    """Strip the gateway's non-standard top-level ``timings`` key.

    OpenSquilla's post-terminal inert-epilogue validation rejects any
    unknown top-level chunk key; ``timings`` on the usage trailer (or a
    duplicate terminal frame) makes it abort with invalid_stream_order.
    """
    try:
        obj = json.loads(data)
    except Exception:
        return None
    if not isinstance(obj, dict) or "timings" not in obj:
        return None
    obj.pop("timings")
    return ("data: " + json.dumps(obj) + "\n").encode()


def filter_sse(raw: bytes) -> bytes:
    out = []
    seen_terminal = False
    for line in raw.splitlines(keepends=True):
        if line.startswith(b"data:"):
            data = line[5:].strip()
            if data and data != b"[DONE]":
                try:
                    obj = json.loads(data)
                except Exception:
                    out.append(line)
                    continue
                if isinstance(obj, dict) and _dup_terminal(obj, seen_terminal):
                    continue
                if isinstance(obj, dict):
                    choices = obj.get("choices")
                    if (
                        isinstance(choices, list)
                        and choices
                        and isinstance(choices[0], dict)
                        and choices[0].get("finish_reason") is not None
                    ):
                        seen_terminal = True
                rewritten = _rewrite_frame(data)
                out.append(rewritten if rewritten is not None else line)
                continue
        out.append(line)
    return b"".join(out)


def serve(conn):
    try:
        head = b""
        while b"\r\n\r\n" not in head:
            part = conn.recv(65536)
            if not part:
                return
            head += part
        header_block, rest = head.split(b"\r\n\r\n", 1)
        lines = header_block.decode("latin1").split("\r\n")
        method, path, _ = lines[0].split(" ", 2)
        hdrs = {}
        for l in lines[1:]:
            if ":" in l:
                k, v = l.split(":", 1)
                hdrs[k.strip()] = v.strip()
        clen = int(hdrs.get("Content-Length") or 0)
        body = rest
        while len(body) < clen:
            part = conn.recv(65536)
            if not part:
                break
            body += body[:0] + part

        fwd = {
            k: v
            for k, v in hdrs.items()
            if k.lower() not in ("host", "content-length", "connection")
        }
        fwd["Authorization"] = "Bearer " + KEY
        req = urllib.request.Request(GATEWAY + path, data=body, headers=fwd, method=method)
        try:
            resp = urllib.request.urlopen(req, timeout=600)
            status, reason = resp.status, resp.reason
            data = resp.read()
        except urllib.error.HTTPError as e:
            status, reason = e.code, e.reason
            data = e.read()
        if (
            b'"stream"' in body[:65536]
            and status == 200
            and (data.startswith(b"data:") or b"\ndata:" in data[:4096])
        ):
            filtered = filter_sse(data)
            dbg = os.environ.get("OSQ_PROXY_DEBUG_DIR")
            if dbg:
                n = _counter[0]
                _counter[0] += 1
                open(os.path.join(dbg, "raw-%d.bin" % n), "wb").write(data)
                open(os.path.join(dbg, "filt-%d.bin" % n), "wb").write(filtered)
            data = filtered
        out = (
            "HTTP/1.1 %d %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n"
            % (status, reason, len(data))
        ).encode("latin1")
        conn.sendall(out + data)
    except Exception as e:
        sys.stderr.write("proxy error: %r\n" % (e,))
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main():
    port = int(sys.argv[1])
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(16)
    sys.stderr.write("proxy listening on 127.0.0.1:%d\n" % port)
    while True:
        c, _ = srv.accept()
        threading.Thread(target=serve, args=(c,), daemon=True).start()


if __name__ == "__main__":
    main()
