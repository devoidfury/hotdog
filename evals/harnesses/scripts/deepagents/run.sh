#!/bin/bash
set -e
cd "$PWD"
export DEEPAGENTS_HOME="$PWD/.dcode-home"
export OPENAI_BASE_URL="${HOTDOG_EVAL_GATEWAY_URL}/v1"
export OPENAI_API_BASE="${HOTDOG_EVAL_GATEWAY_URL}/v1"
export OPENAI_API_KEY="$DCODE_GW_KEY"
export DEEPAGENTS_CODE_AUTO_UPDATE=off
export COLUMNS=200 LINES=50
exec ${HOTDOG_EVAL_HARNESS_DIR}/deepagents/libs/code/.venv/bin/dcode -n "$1" -q -M openai:${HOTDOG_EVAL_MODEL} --max-turns 10 --timeout 240
