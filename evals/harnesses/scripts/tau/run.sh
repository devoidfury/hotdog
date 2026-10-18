#!/bin/bash
# tau: seed per-run TAU_HOME, register an OpenAI-compatible gateway provider
# (options must precede the "setup" positional or typer launches the TUI),
# then run non-interactive print mode.
set -uo pipefail
export TAU_HOME="$PWD/.tau"
mkdir -p "$TAU_HOME"
${HOTDOG_EVAL_VENV_DIR}/tau/venv/bin/tau \
  --provider gw --base-url ${HOTDOG_EVAL_GATEWAY_URL}/v1 \
  --api-key-env TAU_GW_KEY --model ${HOTDOG_EVAL_MODEL} setup >/dev/null
${HOTDOG_EVAL_VENV_DIR}/tau/venv/bin/tau --print "$1"
RC=$?
exit $RC
