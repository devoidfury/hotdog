#!/bin/bash
# atomic-agent harness entry: seed per-run user config with the gateway
# openai-compatible provider (key arrives via ATOMIC_GW_KEY from the spec),
# then run the one-shot `run` mode. stdin is held open after the prompt so
# the turn's answer lands on stdout before EOF.
set -e
CLI=${HOTDOG_EVAL_HARNESS_DIR}/atomic-agent/dist/cli/index.js
mkdir -p "$HOME/.atomic-agent"
export ATOMIC_AGENT_GW_KEY="$ATOMIC_GW_KEY"
CFG=$(ATOMIC_AGENT_GW_KEY="$ATOMIC_AGENT_GW_KEY" python3 - <<'PY'
import json, os
print(json.dumps({
  "llm": {
    "activeTextProvider": "gateway",
    "activeEmbeddingProvider": "gateway",
    "toolTransport": "auto",
    "providers": [
      {
        "id": "gateway",
        "kind": "openai-compatible",
        "baseUrl": os.environ["HOTDOG_EVAL_GATEWAY_URL"] + "/v1",
        "apiKeyEnvVar": "ATOMIC_AGENT_GW_KEY",
        "model": os.environ["HOTDOG_EVAL_MODEL"],
        "defaultChatModel": os.environ["HOTDOG_EVAL_MODEL"],
        "defaultEmbeddingModel": os.environ["HOTDOG_EVAL_MODEL"]
      }
    ]
  }
}))
PY
)
printf '%s' "$CFG" | /usr/bin/node "$CLI" config set -
timeout 150 bash -c '{ printf "%s\n" "$0"; sleep 120; }' "$1" | /usr/bin/node "$CLI" run --no-approval
