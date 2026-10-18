#!/bin/bash
set -euo pipefail
D="$HOME/.WorkGround2"
mkdir -p "$D"
cat > "$D/config.toml" <<'TOML'
default_model = "gw/__MODEL__"

[[providers]]
name     = "gw"
kind     = "openai"
base_url = "__GW_URL__/v1"
model    = "__MODEL__"
api_key_env = "WGT2_GW_KEY"
context_window = 262144
reasoning_protocol = "none"
TOML
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "$D/config.toml"
printf 'WGT2_GW_KEY=%s\n' "${WGT2_GW_KEY}" > "$D/.env"
exec ${HOTDOG_EVAL_HARNESS_DIR}/workground2/bin/workground2 run "$@"
