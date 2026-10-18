#!/bin/bash
set -euo pipefail
D="$HOME/.waveloom"
mkdir -p "$D"
cat > "$D/settings.json" <<JSON
{
  "llm": {
    "provider": "openai",
    "model": "${HOTDOG_EVAL_MODEL}",
    "base_url": "${HOTDOG_EVAL_GATEWAY_URL}/v1",
    "api_key": "${WAVE_GW_KEY}"
  }
}
JSON
exec ${HOTDOG_EVAL_HARNESS_DIR}/waveloom/bin/waveloom "$@"
