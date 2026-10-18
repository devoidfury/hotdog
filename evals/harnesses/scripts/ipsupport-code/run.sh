#!/bin/bash
set -euo pipefail
H="$HOME/.config/ipsupport-code"
mkdir -p "$H"
cat > "$H/config.json" <<JSON
{
  "llm": {
    "base_url": "${HOTDOG_EVAL_GATEWAY_URL}/v1",
    "model": "${HOTDOG_EVAL_MODEL}",
    "api_key": "${IPSUPPORT_GW_KEY}",
    "context_window": 262144
  }
}
JSON
exec ${HOTDOG_EVAL_HARNESS_DIR}/ipsupport-code/bin/ipsupport-code -skip-permissions -new "$@"
