#!/bin/bash
# grok-build wrapper: BYOK gateway model via per-run GROK_HOME config.
set -e
GROK_HOME="$PWD/.grok-home"
mkdir -p "$GROK_HOME"
cat > "$GROK_HOME/config.toml" <<'EOF'
[model.gemma]
model = "__MODEL__"
base_url = "__GW_URL__/v1"
api_backend = "chat_completions"
env_key = "GROK_GW_KEY"
context_window = 262144
EOF
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "$GROK_HOME/config.toml"
export GROK_HOME
exec ${HOTDOG_EVAL_HARNESS_DIR}/grok-build/target/debug/xai-grok-pager -p "$1" -m gemma
