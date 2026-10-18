#!/bin/bash
set -euo pipefail
H=${HOTDOG_EVAL_HARNESS_DIR}/bitfun
BIN=$H/target/release-fast/openbitfun
ROOT="$PWD/.bitfun-user"
export OPENBITFUN_USER_ROOT="$ROOT"
mkdir -p "$ROOT/config"
cat > "$ROOT/config/app.json" <<JSON
{
  "product_id": "openbitfun",
  "app": {},
  "editor": {},
  "terminal": {},
  "workspace": {},
  "ai": {
    "models": [
      {
        "id": "gw",
        "name": "Gateway Gemma 4",
        "provider": "openai",
        "model_name": "${HOTDOG_EVAL_MODEL}",
        "base_url": "${HOTDOG_EVAL_GATEWAY_URL}/v1",
        "api_key": "$BITFUN_GW_KEY",
        "enabled": true
      }
    ],
    "default_models": { "primary": "gw" }
  },
  "appearance": { "selection": "system" },
  "schema_version": 1,
  "version": "1.0.3",
  "last_modified": 1760000000000
}
JSON
exec "$BIN" --model gw exec "$1"
