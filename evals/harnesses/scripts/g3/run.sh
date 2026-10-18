#!/bin/bash
set -euo pipefail
H=${HOTDOG_EVAL_HARNESS_DIR}/g3
CFG="$PWD/.g3-home"
WS="$CFG/workspace"
mkdir -p "$WS"
cat > "$CFG/g3.toml" <<TOML
[providers]
default_provider = "openai.gw"

[providers.openai.gw]
api_key = "$G3_GW_KEY"
model = "${HOTDOG_EVAL_MODEL}"
base_url = "${HOTDOG_EVAL_GATEWAY_URL}/v1"
TOML
export G3_WORKSPACE_PATH="$WS"
cd "$WS"
exec "$H/target/release/g3" --config "$CFG/g3.toml" "$1"
