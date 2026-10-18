#!/bin/bash
# neovate harness entry: seed ~/.neovate/config.json with a custom openai
# provider pointed at the gateway (key via NEOVATE_GW_KEY), then run the
# quiet one-shot mode with the custom provider/model ref.
set -e
mkdir -p "$HOME/.neovate"
NEOVATE_GW_KEY="$NEOVATE_GW_KEY" python3 - <<'PY'
import json, os
cfg = {
  "provider": {
    "gw": {
      "id": "gw",
      "env": ["NEOVATE_GW_KEY"],
      "apiEnv": ["NEOVATE_GW_BASE"],
      "name": "Gateway",
      "api": os.environ["HOTDOG_EVAL_GATEWAY_URL"] + "/v1",
      "models": {
        os.environ["HOTDOG_EVAL_MODEL"]: {"apiFormat": "openai"}
      }
    }
  }
}
open(os.path.expanduser("~/.neovate/config.json"), "w").write(json.dumps(cfg))
PY
exec bun ${HOTDOG_EVAL_HARNESS_DIR}/neovate-code/src/cli.ts -q "$1" -m gw/${HOTDOG_EVAL_MODEL}
