#!/bin/bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# tura one-shot via local gateway, routed to the eval gateway through
# TURA_PROVIDER_CONFIG (openai provider base_url override).
# TURA_HOME pins all daemon state to a per-run writable dir.
set -u
TURA=${HOTDOG_EVAL_HARNESS_DIR}/tura/node_modules/tura-linux-x64/target/release/tura
# provider_config.json carries a __GW_URL__ token (the repo copy must stay
# machine-neutral); stamp the real gateway into a per-run copy.
mkdir -p "$PWD/.tura"
if [ -z "${TURA_PROVIDER_CONFIG:-}" ]; then
  sed "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "${HERE}/provider_config.json" > "$PWD/.tura/provider_config.json"
  export TURA_PROVIDER_CONFIG="$PWD/.tura/provider_config.json"
fi
sed "s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "${HERE}/agent_gw.json" > "$PWD/.tura/agent_gw.json"

export TURA_HOME=${TURA_HOME:-$PWD/.tura-home}
mkdir -p "$TURA_HOME"
"$TURA" agent create gw --config "$PWD/.tura/agent_gw.json" >/dev/null 2>&1 || true
exec "$TURA" run -a gw -m openai/${HOTDOG_EVAL_MODEL} --color never --plain "$1"
