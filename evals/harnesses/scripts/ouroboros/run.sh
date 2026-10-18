#!/bin/bash
# ouroboros: managed headless task via `ouroboros run`.
# Notes from the source:
#  - the `run` prompt positional is nargs=REMAINDER, so every flag must
#    PRECEDE the prompt text or it is swallowed into the prompt;
#  - `--start` only auto-launches a loopback server on attach failure, so
#    the wrapper starts its own server on a free loopback port and points
#    the CLI at it with OUROBOROS_URL;
#  - provider wiring: OUROBOROS_MODEL="openai-compatible::${HOTDOG_EVAL_MODEL}"
#    plus OPENAI_COMPATIBLE_BASE_URL / OPENAI_COMPATIBLE_API_KEY (settings
#    keys resolved in gateway/settings.py active-model route);
#  - per-run state under OUROBOROS_APP_ROOT in the workspace.
# The run prints the task result text to stdout and exits 0 only on a
# terminal success.
set -uo pipefail
export OPENAI_COMPATIBLE_BASE_URL="${HOTDOG_EVAL_GATEWAY_URL}/v1"
export OPENAI_COMPATIBLE_API_KEY="$OBO_GW_KEY"
export OUROBOROS_MODEL="openai-compatible::${HOTDOG_EVAL_MODEL}"
export OUROBOROS_APP_ROOT="$PWD/.ouroboros"
PY=${HOTDOG_EVAL_VENV_DIR}/ouroboros/venv/bin/python
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
export OUROBOROS_URL="http://127.0.0.1:$PORT"
"$PY" -m ouroboros.cli server --host 127.0.0.1 --port "$PORT" > "$PWD/.ouroboros-server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
ok=""
for _ in $(seq 1 120); do
  if grep -q "Supervisor ready" "$PWD/.ouroboros-server.log" 2>/dev/null; then ok=1; break; fi
  sleep 0.5
done
if [ -z "$ok" ]; then
  echo "ouroboros: server did not become ready" >&2
  exit 1
fi
"$PY" ${HOTDOG_EVAL_VENV_DIR}/ouroboros/venv/bin/ouroboros run --timeout 200 --quiet \
  --result-json-out "$PWD/.ouroboros-task-result.json" "$1"
RC=$?
exit $RC
