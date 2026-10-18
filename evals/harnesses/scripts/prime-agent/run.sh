#!/bin/bash
set -e
PROMPT=$1
BIN=${HOTDOG_EVAL_HARNESS_DIR}/prime-agent/target/release/prime-agent
export PRIME_AGENT_CODING_AGENT_DIR=$PWD/.prime-agent-home
export COLUMNS=500
mkdir -p "$PRIME_AGENT_CODING_AGENT_DIR"
cat > "$PRIME_AGENT_CODING_AGENT_DIR/models.json" <<JSON
{
  "providers": {
    "gw": {
      "baseUrl": "${HOTDOG_EVAL_GATEWAY_URL}/v1",
      "apiKey": "$PRIME_GW_KEY",
      "api": "openai-completions",
      "authHeader": false,
      "models": [
        { "id": "${HOTDOG_EVAL_MODEL}", "reasoning": false, "contextWindow": 262144, "input": ["text"] }
      ]
    }
  }
}
JSON
exec "$BIN" --print --provider gw --model ${HOTDOG_EVAL_MODEL} "$PROMPT"
