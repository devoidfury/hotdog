#!/bin/bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# trae-agent: one-shot task mode `trae-cli run TASK`.
# Wiring: per-run trae_config.yaml with an OpenAI provider pointed at the
# gateway. Two gateway quirks require a local pass-through proxy
# (gw-proxy.py, stdlib only): the /v1/responses usage object omits
# output_tokens_details, which trae's OpenAIClient dereferences
# unconditionally (AttributeError), so the proxy injects empty detail
# objects. Config keeps max_steps small; the run always exits 0 when it
# completes a pass (task success/failure is only reported in the summary
# panel), and COLUMNS=500 (spec env) keeps the rich panel from wrapping
# reply text mid-string.
set -uo pipefail
export GW_PROXY_KEY="$TRAE_GW_KEY"
export GW_PROXY_UPSTREAM="${HOTDOG_EVAL_GATEWAY_URL}"
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
python3 ${HERE}/gw-proxy.py "$PORT" 2>/dev/null &
PROXY_PID=$!
for _ in $(seq 1 50); do
  if python3 -c "import socket; s=socket.socket(); s.settimeout(0.2); s.connect(('127.0.0.1',$PORT))" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
WORK="$PWD/.trae-work"
mkdir -p "$WORK"
cat > "$WORK/trae_config.yaml" <<YAML
agents:
  trae_agent:
    enable_lakeview: false
    model: gw-model
    max_steps: 5
    tools:
      - sequentialthinking
      - task_done
model_providers:
  gw:
    provider: openai
    api_key: $TRAE_GW_KEY
    base_url: http://127.0.0.1:$PORT/v1
models:
  gw-model:
    model_provider: gw
    model: ${HOTDOG_EVAL_MODEL}
    max_tokens: 2048
    temperature: 0.5
    top_p: 1
    top_k: 0
    max_retries: 2
    parallel_tool_calls: true
YAML
cd "$WORK"
${HOTDOG_EVAL_VENV_DIR}/trae-agent/venv/bin/trae-cli run "$1" -w "$WORK" -ct simple
RC=$?
kill $PROXY_PID 2>/dev/null || true
exit $RC
