#!/bin/bash
set -u
WS=$PWD
export ZEROCLAW_CONFIG_DIR="$WS/.zeroclaw-config"
export ZEROCLAW_DATA_DIR="$WS/.zeroclaw-data"
mkdir -p "$ZEROCLAW_CONFIG_DIR" "$ZEROCLAW_DATA_DIR"
cat > "$ZEROCLAW_CONFIG_DIR/config.toml" <<'TOML'
schema_version = 3

[providers.models.custom.gw]
uri = "__GW_URL__/v1"
model = "__MODEL__"

[agents.assistant]
model_provider = "custom.gw"
risk_profile = "default"
runtime_profile = "default"

[risk_profiles.default]
level = "full"

[runtime_profiles.default]
max_tool_iterations = 5
max_context_tokens = 64000
TOML
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "$ZEROCLAW_CONFIG_DIR/config.toml"
export ZEROCLAW_providers__models__custom__gw__api_key="$ZC_GW_KEY"
exec ${HOTDOG_EVAL_HARNESS_DIR}/zeroclaw/target/debug/zeroclaw agent -a assistant -m "$1" --model ${HOTDOG_EVAL_MODEL}
