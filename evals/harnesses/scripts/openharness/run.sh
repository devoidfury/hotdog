#!/bin/bash
# openharness harness entry: seed ~/.oh/config.yaml with apiKey + baseUrl for
# an OpenAI-compatible endpoint (the gateway), then run one-shot `run` with an
# explicit gw/<model> so the provider resolves as OpenAI-compatible.
set -e
mkdir -p "$HOME/.oh"
OH_GW_KEY="$OH_GW_KEY" python3 - <<'PY'
import os
cfg = "provider: openai\nmodel: %s\npermissionMode: trust\nbaseUrl: %s/v1\napiKey: %s\n" % (os.environ["HOTDOG_EVAL_MODEL"], os.environ["HOTDOG_EVAL_GATEWAY_URL"], os.environ["OH_GW_KEY"])
open(os.path.expanduser("~/.oh/config.yaml"), "w").write(cfg)
PY
exec ${HOTDOG_EVAL_HARNESS_DIR}/openharness/node_modules/.bin/tsx ${HOTDOG_EVAL_HARNESS_DIR}/openharness/src/main.tsx run --model gw/${HOTDOG_EVAL_MODEL} --no-session-persistence "$1"
