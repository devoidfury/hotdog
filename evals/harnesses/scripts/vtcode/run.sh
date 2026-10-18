#!/bin/bash
set -u
WS=$PWD
export XDG_CONFIG_HOME="$WS/.vtcode-xdg"
mkdir -p "$XDG_CONFIG_HOME/vtcode"
cat > "$XDG_CONFIG_HOME/vtcode/vtcode.toml" <<'TOML'
[agent]
provider = "gw"
default_model = "__MODEL__"

[[custom_providers]]
name = "gw"
display_name = "Gateway"
base_url = "__GW_URL__/v1"
api_key_env = "VTCODE_GW_KEY"
model = "__MODEL__"
TOML
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "$XDG_CONFIG_HOME/vtcode/vtcode.toml"
exec ${HOTDOG_EVAL_HARNESS_DIR}/vtcode/target/debug/vtcode ask "$1"
