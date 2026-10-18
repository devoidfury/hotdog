#!/bin/bash
set -euo pipefail
D="$HOME/.san"
mkdir -p "$D"
cat > "$D/providers.json" <<JSON
{
  "connections": { "custom": { "authMethod": "api_key", "connectedAt": "2026-10-10T00:00:00Z" } },
  "current": { "modelId": "${HOTDOG_EVAL_MODEL}", "provider": "custom", "authMethod": "api_key" },
  "customProvider": { "id": "custom", "baseURL": "${HOTDOG_EVAL_GATEWAY_URL}/v1" }
}
JSON
printf '{"SAN_CUSTOM_API_KEY": "%s"}\n' "${SAN_GW_KEY}" > "$D/secrets.json"
exec ${HOTDOG_EVAL_HARNESS_DIR}/san/bin/san -p "$1"
