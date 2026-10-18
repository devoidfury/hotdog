#!/bin/bash
# gptme one-shot wrapper: seed a per-run HOME with ~/.config/gptme/config.toml
# defining custom OpenAI-compatible provider "gw" -> gateway; then run gptme
# non-interactively with tools disabled (001-greet requires no tools).
set -euo pipefail
export HOME="$PWD/.gptme-home"
mkdir -p "$HOME/.config/gptme"
cat > "$HOME/.config/gptme/config.toml" <<'TOML'
[[providers]]
name = "gw"
base_url = "__GW_URL__/v1"
api_key_env = "GPTME_GW_KEY"
TOML
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g" "$HOME/.config/gptme/config.toml"
exec ${HOTDOG_EVAL_VENV_DIR}/gptme/venv/bin/gptme -n --no-stream --tools none -m gw/${HOTDOG_EVAL_MODEL} "$1"
