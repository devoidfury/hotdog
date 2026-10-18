#!/bin/bash
set -e
export COLUMNS=500 LINES=50
CFG="$PWD/.3code-cfg"
cat > "$CFG" <<'CFGEOF'
[settings]
current = "gw.__MODEL__"
sandbox = off

[provider]
name = "gw"
url = "__GW_URL__/v1"
key = "REPLACE_KEY"
family = "gpt"
models = "__MODEL__"
CFGEOF
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "$CFG"
sed -i "s|REPLACE_KEY|$THREECODE_GW_KEY|" "$CFG"
exec ${HOTDOG_EVAL_HARNESS_DIR}/3code/3code -x -c "$CFG" "$1"
