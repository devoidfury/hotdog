#!/bin/bash
# codewhale one-shot: seed per-run CODEWHALE_HOME config pointing the
# openai provider at the eval gateway, then run the vendored release
# binary in headless exec mode.
set -u
CW=${HOTDOG_EVAL_HARNESS_DIR}/codewhale/npm/codewhale/bin/downloads/codewhale
export CODEWHALE_HOME=$PWD/.codewhale-home
export CODEWHALE_NO_UPDATE_CHECK=1
mkdir -p "$CODEWHALE_HOME"
cat > "$CODEWHALE_HOME/config.toml" <<EOF
provider = "openai"
[providers.openai]
api_key = "$CW_GW_KEY"
base_url = "${HOTDOG_EVAL_GATEWAY_URL}/v1"
model = "${HOTDOG_EVAL_MODEL}"
allow_insecure_http = true
EOF
exec "$CW" exec "$1"
