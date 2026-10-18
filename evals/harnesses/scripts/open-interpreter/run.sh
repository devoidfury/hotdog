#!/bin/bash
# open-interpreter harness entry: per-run CODEX_HOME with a custom gateway
# provider (codex 0.0.56 fork of openai/codex), then headless `codex exec`.
set -e
export CODEX_HOME="$PWD/.codex-home"
mkdir -p "$CODEX_HOME"
OI_GW_KEY="$OI_GW_KEY" python3 - <<'PY'
import os
toml = """model_provider = "gateway"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.gateway]
name = "gateway"
base_url = os.environ["HOTDOG_EVAL_GATEWAY_URL"] + "/v1"
env_key = "OI_GW_KEY"
wire_api = "chat"
"""
open(os.path.join(os.environ["CODEX_HOME"], "config.toml"), "w").write(toml)
PY
exec ${HOTDOG_EVAL_HARNESS_DIR}/open-interpreter/codex-rs/target/debug/codex exec -m ${HOTDOG_EVAL_MODEL} --skip-git-repo-check --ephemeral --color never "$1"
