#!/bin/bash
# qqcode (mistral-vibe fork): seed project-local .qqcode/config.toml with an
# OpenAI-compatible gateway provider, run programmatic mode (-p).
set -uo pipefail
mkdir -p "$PWD/.qqcode"
cat > "$PWD/.qqcode/config.toml" <<'TOML'
active_model = "gw/__MODEL__"

[[providers]]
name = "gw"
api_base = "__GW_URL__/v1"
api_key_env_var = "QQCODE_GW_KEY"
backend = "generic"

[[models]]
name = "__MODEL__"
provider = "gw"
alias = "gw/__MODEL__"
TOML
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "$PWD/.qqcode/config.toml"
${HOTDOG_EVAL_VENV_DIR}/qqcode/venv/bin/qqcode -p "$1" --auto-approve
RC=$?
exit $RC
