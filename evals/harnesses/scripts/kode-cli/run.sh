#!/bin/bash
# kode-cli harness entry: seed a custom-openai model profile pointed at the
# gateway (key via KODE_GW_KEY from the spec), wire the main/task/compact/quick
# pointers to it, then run the one-shot -p print mode.
set -e
CLI=${HOTDOG_EVAL_HARNESS_DIR}/kode-cli/apps/cli/src/dispatch.ts
mkdir -p "$HOME/.kode-cfg"
cat > "$HOME/.kode-cfg/models.yaml" <<'YAML'
version: 1
profiles:
  - name: gw-gemma
    provider: custom-openai
    modelName: __MODEL__
    baseURL: __GW_URL__/v1
    maxTokens: 8192
    contextLength: 128000
    apiKey:
      fromEnv: KODE_GW_KEY
pointers:
  main: __MODEL__
  task: __MODEL__
  compact: __MODEL__
  quick: __MODEL__
YAML
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "$HOME/.kode-cfg/models.yaml"
bun "$CLI" models import "$HOME/.kode-cfg/models.yaml" >/dev/null
exec bun "$CLI" -p "$1" --permission-mode bypassPermissions
