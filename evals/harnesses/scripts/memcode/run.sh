#!/bin/bash
set -euo pipefail
export MEMCODE_ENDPOINT_URL="${HOTDOG_EVAL_GATEWAY_URL}/v1"
export MEMCODE_ENDPOINT_KEY="${MEMCODE_GW_KEY}"
export MEMCODE_ENDPOINT_MODEL="${HOTDOG_EVAL_MODEL}"
export COLUMNS=500
exec ${HOTDOG_EVAL_HARNESS_DIR}/memcode/bin/memcode run --allow-all --no-context "$@"
