#!/bin/bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -e
PROMPT=$1
BIN=${HOTDOG_EVAL_HARNESS_DIR}/picocode/target/release/picocode
# Local normalizing proxy in front of the gateway (rig 0.28 needs
# usage.output_tokens_details; gateway omits it).
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
GW_PROXY_UPSTREAM=${HOTDOG_EVAL_GATEWAY_URL} GW_PROXY_KEY=$PICOCODE_GW_KEY \
  python3 ${HERE}/../rust2/gw-proxy.py "$PORT" >/tmp/rust2-picocode-proxy.log 2>&1 &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null || true' EXIT
sleep 0.5
export OPENAI_BASE_URL=http://127.0.0.1:$PORT/v1
export OPENAI_API_KEY=$PICOCODE_GW_KEY
exec "$BIN" "$PROMPT" -p openai -m ${HOTDOG_EVAL_MODEL} -q --yolo true
