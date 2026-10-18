#!/bin/bash
# kimi-code harness entry: seed ~/.kimi-code/config.toml in the per-run
# sandbox $HOME with a gateway openai provider + model alias, then run the
# one-shot prompt mode.
set -e
mkdir -p "$HOME/.kimi-code"
cat > "$HOME/.kimi-code/config.toml" <<'TOML'
default_model = "gw-gemma"

[providers.gateway]
type = "openai"
api_key_env = "KIMI_GW_KEY"
base_url = "__GW_URL__/v1"

[models.gw-gemma]
provider = "gateway"
model = "__MODEL__"
max_context_size = 128000
TOML
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "$HOME/.kimi-code/config.toml"
exec node ${HOTDOG_EVAL_HARNESS_DIR}/kimi-code/apps/kimi-code/dist/main.mjs -p "$1" -m gw-gemma
