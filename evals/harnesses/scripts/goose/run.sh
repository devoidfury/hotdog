#!/bin/bash
set -euo pipefail
H=${HOTDOG_EVAL_HARNESS_DIR}/goose
ROOT="$PWD/.goose-home"
mkdir -p "$ROOT/config/custom_providers" "$ROOT/data" "$ROOT/state"
cat > "$ROOT/config/custom_providers/gw.json" <<'JSON'
{
  "name": "gw",
  "engine": "openai",
  "display_name": "Gateway",
  "api_key_env": "GOOSE_GW_KEY",
  "base_url": "__GW_URL__/v1/chat/completions",
  "models": [
    { "name": "__MODEL__", "context_limit": 262144, "max_tokens": 8192 }
  ],
  "supports_streaming": true,
  "dynamic_models": false,
  "skip_canonical_filtering": true
}
JSON
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "$ROOT/config/custom_providers/gw.json"
export GOOSE_PATH_ROOT="$ROOT"
export GOOSE_DISABLE_KEYRING="true"
cd "$ROOT/data"
exec "$H/target/release/goose" run -q -t "$1" --provider gw --model ${HOTDOG_EVAL_MODEL}
