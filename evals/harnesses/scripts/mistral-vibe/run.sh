#!/bin/bash
# mistral-vibe: seed per-run VIBE_HOME config.toml with an OpenAI-compatible
# gateway provider, run programmatic mode (-p sends prompt, prints response,
# exits). Vibe's plugin installer drops read-only SKILL.md files under
# VIBE_HOME, which breaks the runner's rmSync cleanup (EACCES), so chmod the
# tree writable before exiting.
set -uo pipefail
export VIBE_HOME="$PWD/.vibe"
mkdir -p "$VIBE_HOME"
cat > "$VIBE_HOME/config.toml" <<'TOML'
active_model = "gw-gemma"

[[providers]]
name = "gw"
api_base = "__GW_URL__/v1"
api_key_env_var = "VIBE_GW_KEY"
api_style = "openai"
backend = "generic"
emits_finish_reason = true

[models."gw-gemma"]
name = "__MODEL__"
provider = "gw"
alias = "gw-gemma"
max_context_length = 131072
TOML
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "$VIBE_HOME/config.toml"
${HOTDOG_EVAL_VENV_DIR}/mistral-vibe/venv/bin/vibe -p "$1" --auto-approve --trust
RC=$?
chmod -R u+w "$VIBE_HOME" 2>/dev/null || true
exit $RC
