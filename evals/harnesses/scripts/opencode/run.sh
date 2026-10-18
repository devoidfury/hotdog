#!/bin/bash
# opencode harness entry: seed ~/.config/opencode/opencode.json in the per-run
# sandbox $HOME with an openai-compatible provider pointed at the gateway,
# then run the one-shot `run` mode.
set -e
mkdir -p "$HOME/.config/opencode"
python3 - "$OPENCODE_GW_KEY" > "$HOME/.config/opencode/opencode.json" <<'PY'
import json, sys
print(json.dumps({
  "provider": {
    "gw": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "gw",
      "options": {"baseURL": os.environ["HOTDOG_EVAL_GATEWAY_URL"] + "/v1", "apiKey": sys.argv[1]},
      "models": {os.environ["HOTDOG_EVAL_MODEL"]: {}}
    }
  }
}))
PY
exec bun ${HOTDOG_EVAL_HARNESS_DIR}/opencode/packages/opencode/src/index.ts run "$1" -m gw/${HOTDOG_EVAL_MODEL}
