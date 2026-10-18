#!/bin/bash
# oh-my-pi harness entry: seed ~/.omp/agent/models.yml with a custom
# openai-completions provider pointed at the gateway (key via OMP_GW_KEY),
# then run the one-shot -p print mode.
set -e
mkdir -p "$HOME/.omp/agent"
OMP_GW_KEY="$OMP_GW_KEY" python3 - <<'PY'
import os
tpl = """providers:
  gw:
    baseUrl: %s/v1
    apiKey: %s
    api: openai-completions
    models:
      - id: %s
        name: %s
        api: openai-completions
        reasoning: false
        input: ["text"]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 128000
        maxTokens: 16384
"""
open(os.path.expanduser("~/.omp/agent/models.yml"), "w").write(tpl % (os.environ["HOTDOG_EVAL_GATEWAY_URL"], os.environ["OMP_GW_KEY"], os.environ["HOTDOG_EVAL_MODEL"], os.environ["HOTDOG_EVAL_MODEL"]))
PY
exec bun ${HOTDOG_EVAL_HARNESS_DIR}/oh-my-pi/packages/coding-agent/src/cli.ts -p "$1" --model gw/${HOTDOG_EVAL_MODEL}
