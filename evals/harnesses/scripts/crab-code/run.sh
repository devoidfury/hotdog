#!/bin/bash
set -euo pipefail
H=${HOTDOG_EVAL_HARNESS_DIR}/crab-code
export CRAB_CONFIG_DIR="$PWD/.crab-home"
mkdir -p "$CRAB_CONFIG_DIR"
exec "$H/target/release/crab" -p "$1" --provider openai --model ${HOTDOG_EVAL_MODEL}
