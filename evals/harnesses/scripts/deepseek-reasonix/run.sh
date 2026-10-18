#!/bin/bash
set -euo pipefail
export REASONIX_HOME="$PWD/.reasonix-home"
mkdir -p "$REASONIX_HOME"
cat > "$REASONIX_HOME/.env" <<ENV
REASONIX_GW_KEY=${REASONIX_GW_KEY}
ENV
cat > "$REASONIX_HOME/config.toml" <<'TOML'
default_model = "gw/__MODEL__"

[[providers]]
name     = "gw"
kind     = "openai"
base_url = "__GW_URL__/v1"
model    = "__MODEL__"
api_key_env = "REASONIX_GW_KEY"
context_window = 262144
reasoning_protocol = "none"
TOML
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "$REASONIX_HOME/config.toml"
exec ${HOTDOG_EVAL_HARNESS_DIR}/deepseek-reasonix/bin/reasonix -p --yolo --output-format text "$@"
