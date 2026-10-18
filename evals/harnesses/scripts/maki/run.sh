#!/bin/bash
set -e
PROMPT=$1
BIN=${HOTDOG_EVAL_HARNESS_DIR}/maki/target/release/maki
export HOME=$PWD/.maki-home
mkdir -p "$HOME/.maki"
cat > "$HOME/.maki/providers.toml" <<TOML
[gw]
protocol = "openai"
base_url = "${HOTDOG_EVAL_GATEWAY_URL}/v1"
api_key_env = "MAKI_GW_KEY"
TOML
exec "$BIN" "$PROMPT" -p --yolo --model gw/${HOTDOG_EVAL_MODEL} --output-format text
