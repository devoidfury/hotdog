#!/bin/bash
set -e
PROMPT=$1
BIN=${HOTDOG_EVAL_HARNESS_DIR}/smelt/target/release/smelt
export HOME=$PWD/.smelt-home
export XDG_CONFIG_HOME=$PWD/.smelt-home/config
export XDG_STATE_HOME=$PWD/.smelt-home/state
export XDG_DATA_HOME=$PWD/.smelt-home/data
export XDG_CACHE_HOME=$PWD/.smelt-home/cache
exec "$BIN" "$PROMPT" --headless --type openai-compatible \
  --api-base ${HOTDOG_EVAL_GATEWAY_URL}/v1 --api-key-env SMELT_GW_KEY \
  -m ${HOTDOG_EVAL_MODEL} --format text --color never
