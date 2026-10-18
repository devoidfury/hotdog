#!/bin/bash
# jcode wrapper: OpenAI-compatible gateway via per-run JCODE_HOME config.
# base_url must be reachable from jcode's normalize_api_base; on the rig
# where this was built it only accepted an IP-based URL, not a hostname.
set -e
export JCODE_HOME="$PWD/.jcode-home"
mkdir -p "$JCODE_HOME"
cat > "$JCODE_HOME/config.toml" <<'EOF'
[provider]
default_provider = "gw"
default_model = "__MODEL__"

[providers.gw]
type = "openai-compatible"
base_url = "__GW_URL__/v1"
api_key_env = "JCODE_GW_KEY"
default_model = "__MODEL__"

[[providers.gw.models]]
id = "__MODEL__"
context_window = 262144
EOF
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "$JCODE_HOME/config.toml"
export JCODE_NO_TELEMETRY=1
exec ${HOTDOG_EVAL_HARNESS_DIR}/jcode/target/release/jcode --provider-profile gw run "$1"
