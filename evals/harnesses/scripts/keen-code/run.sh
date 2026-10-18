#!/bin/bash
set -euo pipefail
D="$HOME/.keen"
mkdir -p "$D"
cat > "$D/configs.json" <<JSON
{
  "active_provider": "openai-compatible",
  "active_model": "${HOTDOG_EVAL_MODEL}",
  "providers": {
    "openai-compatible": {
      "models": ["${HOTDOG_EVAL_MODEL}"],
      "api_key": "${KEEN_GW_KEY}",
      "base_url": "${HOTDOG_EVAL_GATEWAY_URL}/v1"
    }
  }
}
JSON
exec ${HOTDOG_EVAL_HARNESS_DIR}/keen-code/bin/keen run --format text "$@"
