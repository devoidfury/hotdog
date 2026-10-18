#!/bin/bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# OpenSquilla: single-turn automation via `opensquilla agent --message`.
# Gateway wiring: per-run opensquilla.toml in $PWD (cwd config path takes
# precedence) with the openai provider pointed at a local pass-through
# proxy. The proxy exists to normalize one verified gateway wire quirk:
# after the terminal choices frame (finish_reason set) the gateway may emit
# a duplicate terminal frame before [DONE]; OpenSquilla's strict stream
# validator aborts on it ("stream mutated state after finish_reason",
# ErrorEvent code=invalid_stream_order). The proxy (osq-proxy.py, stdlib
# only) drops duplicate terminal frames and passes everything else through.
set -uo pipefail
export OSQ_PROXY_KEY="$OSQ_GW_KEY"
export OSQ_GATEWAY="${HOTDOG_EVAL_GATEWAY_URL}"
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
python3 ${HERE}/osq-proxy.py "$PORT" 2>/dev/null &
PROXY_PID=$!
for _ in $(seq 1 50); do
  if python3 -c "import socket; s=socket.socket(); s.settimeout(0.2); s.connect(('127.0.0.1',$PORT))" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
mkdir -p "$PWD"
cat > opensquilla.toml <<TOML
[llm]
provider = "openai"
model = "${HOTDOG_EVAL_MODEL}"
base_url = "http://127.0.0.1:$PORT/v1"
api_key_env = "OSQ_GW_KEY"

[squilla_router]
enabled = false
TOML
trap 'kill $PROXY_PID 2>/dev/null || true' EXIT
${HOTDOG_EVAL_VENV_DIR}/opensquilla/venv/bin/opensquilla agent \
  --message "$1" \
  --workspace "$PWD" \
  --max-iterations 4
RC=$?
exit $RC
