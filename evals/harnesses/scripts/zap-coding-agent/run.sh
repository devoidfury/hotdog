#!/bin/bash
set -u
WS=$PWD
export HOME="$WS/.zap-home"
mkdir -p "$HOME"
export AGENT_PROVIDER=openai
export AGENT_MODEL=${HOTDOG_EVAL_MODEL}
export AGENT_BASE_URL=${HOTDOG_EVAL_GATEWAY_URL}/v1
export AGENT_API_KEY="$ZAP_GW_KEY"
export AGENT_PERMISSION_MODE=auto
exec ${HOTDOG_EVAL_HARNESS_DIR}/zap-coding-agent/target/debug/zap --goal "$1" --auto
