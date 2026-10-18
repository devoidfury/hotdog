#!/bin/bash
# kimi-cli (archived): the shipped `kimi` entry point is short-circuited by a
# deprecation gate (kimi_cli/__main__.py _deprecation_gate). The original
# Typer CLI is kept in the tree and reachable via run_original_cli, so this
# wrapper drives that path. Seeds a per-run config with an OpenAI-compatible
# gateway provider (type openai_legacy) and runs quiet print mode.
set -uo pipefail
CFG="$PWD/.kimi-cfg"
mkdir -p "$CFG"
cat > "$CFG/config.toml" <<TOML
default_model = "gw-gemma"

[providers.gw]
type = "openai_legacy"
base_url = "${HOTDOG_EVAL_GATEWAY_URL}/v1"
api_key = "$KIMI_GW_KEY"
reasoning_key = ""

[models."gw-gemma"]
provider = "gw"
model = "${HOTDOG_EVAL_MODEL}"
max_context_size = 131072
TOML
${HOTDOG_EVAL_VENV_DIR}/kimi-cli/venv/bin/python -c '
from kimi_cli.__main__ import run_original_cli
import sys
sys.exit(run_original_cli(["-p", sys.argv[1], "--quiet", "--config-file", sys.argv[2]]))
' "$1" "$CFG/config.toml"
RC=$?
exit $RC
