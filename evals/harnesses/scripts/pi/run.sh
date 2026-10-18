#!/bin/bash
# pi harness entry: seed ~/.pi/agent/models.json with a custom OpenAI-compatible
# provider pointed at the gateway (apiKey via $PI_GW_KEY env interpolation),
# then run one-shot print mode.
set -e
mkdir -p "$HOME/.pi/agent"
PI_GW_KEY="$PI_GW_KEY" python3 - <<'PY'
import json, os
cfg = {"providers": {"gw": {"baseUrl": os.environ["HOTDOG_EVAL_GATEWAY_URL"] + "/v1", "api": "openai-completions", "apiKey": "$PI_GW_KEY", "models": [{"id": os.environ["HOTDOG_EVAL_MODEL"], "name": os.environ["HOTDOG_EVAL_MODEL"], "reasoning": False, "input": ["text"], "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}, "contextWindow": 128000, "maxTokens": 16384}]}}}
open(os.path.expanduser("~/.pi/agent/models.json"), "w").write(json.dumps(cfg, indent=2))
PY
exec node ${HOTDOG_EVAL_HARNESS_DIR}/pi/packages/coding-agent/dist/bundle/cli.js -p "$1" --model gw/${HOTDOG_EVAL_MODEL}
