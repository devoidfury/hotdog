#!/bin/bash
set -euo pipefail
export ZOT_HOME="$PWD/.zot-home"
mkdir -p "$ZOT_HOME"
cat > "$ZOT_HOME/models.json" <<'JSON'
{
  "providers": {
    "gw": {
      "baseUrl": "__GW_URL__/v1",
      "api": "openai",
      "models": [
        { "id": "__MODEL__", "name": "Gemma 4 26B", "contextWindow": 262144, "maxTokens": 8192 }
      ]
    }
  }
}
JSON
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "$ZOT_HOME/models.json"
exec ${HOTDOG_EVAL_HARNESS_DIR}/zot/bin/zot -p "$1" --provider gw --model ${HOTDOG_EVAL_MODEL} --api-key "${ZOT_GW_KEY}"
