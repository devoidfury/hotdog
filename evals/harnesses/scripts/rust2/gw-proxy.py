"""Local pass-through proxy for the study gateway (the configured eval gateway).

Normalizes verified gateway wire quirks for Rust harnesses:

1. /v1/chat/completions + /v1/responses: usage objects omit
   ``output_tokens_details`` (and may omit ``input_tokens_details``);
   strict serde clients (rig 0.28 etc.) fail to deserialize. Inject empty
   detail objects when absent.
2. /v1/chat/completions streams: every chunk carries a non-standard
   top-level ``timings`` key; a duplicate terminal choices frame can follow
   the real one before [DONE]. Strip ``timings`` from every frame and drop
   duplicate terminal frames.
Everything else passes through byte-for-byte. Stdlib only.
"""
import json
import os
import socket
import sys
import threading
import urllib.error
import urllib.request

GATEWAY = os.environ["GW_PROXY_UPSTREAM"]
KEY = os.environ["GW_PROXY_KEY"]
_counter = [0]


def _fix_usage(obj):
    if not isinstance(obj, dict):
        return False
    usage = obj.get("usage")
    if not isinstance(usage, dict):
        return False
    changed = False
    otd = usage.get("output_tokens_details")
    if not isinstance(otd, dict):
        usage["output_tokens_details"] = {"reasoning_tokens": 0}
        changed = True
    elif "reasoning_tokens" not in usage["output_tokens_details"]:
        usage["output_tokens_details"]["reasoning_tokens"] = 0
        changed = True
    if not isinstance(usage.get("input_tokens_details"), dict):
        usage["input_tokens_details"] = {"cached_tokens": 0}
        changed = True
    return changed


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
    try:
        obj = json.loads(data)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    changed = False
    if "timings" in obj:
        obj.pop("timings")
        changed = True
    if _fix_usage(obj):
        changed = True
    return ("data: " + json.dumps(obj) + "\n").encode() if changed else None


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


def patch_json(data: bytes) -> bytes:
    try:
        obj = json.loads(data)
    except Exception:
        return data
    if not _fix_usage(obj):
        return data
    return (json.dumps(obj) + "\n").encode()


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
            body += part

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

        if status == 200:
            if (
                b'"stream"' in body[:65536]
                and (data.startswith(b"data:") or b"\ndata:" in data[:4096])
            ):
                data = filter_sse(data)
            else:
                data = patch_json(data)

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
