#!/usr/bin/env bash
# codex harness wrapper (Stage A study).
# Seeds a per-run CODEX_HOME with a config.toml that points the gateway
# provider at the local gateway (SHORT model name; key via env_key), then
# runs the debug-built `codex exec` one-shot.
set -euo pipefail

BIN=${HOTDOG_EVAL_HARNESS_DIR}/codex/codex-rs/target/debug/codex
CHOME=/tmp/codex-home
rm -rf "$CHOME"
mkdir -p "$CHOME"
cat > "$CHOME/config.toml" <<'EOF'
model_provider = "gateway"

[model_providers.gateway]
name = "gateway"
base_url = "__GW_URL__/v1"
env_key = "CODEX_GW_KEY"
wire_api = "responses"
EOF
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g" "$CHOME/config.toml"

export CODEX_HOME="$CHOME"
cd /tmp
exec "$BIN" exec -m ${HOTDOG_EVAL_MODEL} --skip-git-repo-check --ephemeral --color never -- "$1"
