#!/bin/bash
set -u
WS=$PWD
export AGENTTY_HOME="$WS/.agentty-home"
mkdir -p "$AGENTTY_HOME"
exec ${HOTDOG_EVAL_HARNESS_DIR}/agentty/build-rust3/agentty run "$1" \
  --provider ${HOTDOG_EVAL_GATEWAY_URL}/v1 \
  -m ${HOTDOG_EVAL_MODEL} -k "$AGENTTY_GW_KEY" -w "$WS"
