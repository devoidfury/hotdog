#!/bin/bash
set -euo pipefail
H=${HOTDOG_EVAL_HARNESS_DIR}/forge-norvialabs
export OPENAI_API_BASE="${HOTDOG_EVAL_GATEWAY_URL}/v1"
export OPENAI_API_KEY="$FORGE_GW_KEY"
printf '%s' "$1" | "$H/target/release/forge" bench --model openai/${HOTDOG_EVAL_MODEL} --approve-all
