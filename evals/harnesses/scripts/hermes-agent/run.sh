#!/bin/bash
# hermes-agent: seed per-run HERMES_HOME with a custom OpenAI-compatible
# gateway provider, then run the one-shot CLI (-z = answer and exit).
set -euo pipefail
HERMES_HOME="$PWD/.hermes-home"
export HERMES_HOME
mkdir -p "$HERMES_HOME"
cat > "$HERMES_HOME/config.yaml" <<YAML
custom_providers:
  - name: gw
    base_url: ${HOTDOG_EVAL_GATEWAY_URL}/v1
    api_key: "$HERMES_GW_KEY"
    model: ${HOTDOG_EVAL_MODEL}
model:
  default: ${HOTDOG_EVAL_MODEL}
  provider: gw
YAML
exec ${HOTDOG_EVAL_VENV_DIR}/hermes-agent/venv/bin/hermes -z "$1" --yolo
