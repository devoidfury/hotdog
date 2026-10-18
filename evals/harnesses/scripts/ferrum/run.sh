#!/bin/bash
set -euo pipefail
H=${HOTDOG_EVAL_HARNESS_DIR}/ferrum
CFG="$PWD/.ferrum-home"
mkdir -p "$CFG"
cat > "$CFG/config.toml" <<'TOML'
provider = "gw"
model = "__MODEL__"

[providers.gw]
type = "openai-compatible"
base_url = "__GW_URL__/v1"
api_key_env = "FERRUM_GW_KEY"
allow_insecure_http = true
TOML
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "$CFG/config.toml"
export FERRUM_CONFIG_DIR="$CFG"
exec "$H/target/release/ferrum" -p "$1"
