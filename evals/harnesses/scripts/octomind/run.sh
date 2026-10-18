#!/usr/bin/env bash
set -euo pipefail

PROMPT="${*}"
BIN=${HOTDOG_EVAL_HARNESS_DIR}/octomind/target/release/octomind
TEMPLATE=${HOTDOG_EVAL_HARNESS_DIR}/octomind/config-templates/default.toml
MODEL="local:${HOTDOG_EVAL_MODEL}"

# Isolate all octomind state under the (sandbox-writable) cwd.
export OCTOMIND_DATA_DIR="$PWD/.octomind-home"
export LOCAL_API_URL="${HOTDOG_EVAL_GATEWAY_URL}/v1/chat/completions"
export LOCAL_API_KEY="${OCTOMIND_GW_KEY:-}"
export OCTOMIND_TELEMETRY=0
export DO_NOT_TRACK=1

mkdir -p "$OCTOMIND_DATA_DIR/config"
CFG="$OCTOMIND_DATA_DIR/config/config.toml"

# Start from the shipped, schema-complete template and point every model at the
# local gateway; kill the out-of-band supervisor control plane + telemetry.
python3 - "$TEMPLATE" "$CFG" "$MODEL" <<'PY'
import sys
tpl, out, model = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(tpl, encoding="utf-8").read()

# Route every hosted model reference at the local gateway.
s = s.replace('name = "octohub:auto"', f'name = "{model}"')
s = s.replace('model = "octohub:auto"', f'model = "{model}"')
s = s.replace('model = "muvon/hindsight"', f'model = "{model}"')
# NOTE: supervisor.evaluate.model must stay a provider the octolib EVALUATION
# factory supports (cloudflare|octohub|typesafe); it is validated even with the
# supervisor disabled, and never called because the supervisor is off.
# Left as the template's cloudflare:typesafe/jev.

# Silence telemetry + logs.
s = s.replace("telemetry = true", "telemetry = false")
s = s.replace('log_level = "info"', 'log_level = "none"')

# Use a local role as the default (avoid tap download).
s = s.replace('default = "assistant:concierge"', 'default = "assistant"')

# Disable the supervisor master switch + learning, but keep every required
# sub-table intact (the template already provides them).
lines = s.split("\n")
res = []
section = None
for ln in lines:
    st = ln.strip()
    if st.startswith("["):
        section = st.strip("[]")
    if section == "supervisor" and st == "enabled = true":
        ln = ln.replace("enabled = true", "enabled = false")
    elif section == "supervisor.learning" and st == "enabled = true":
        ln = ln.replace("enabled = true", "enabled = false")
    res.append(ln)
s = "\n".join(res)
open(out, "w", encoding="utf-8").write(s)
PY

printf '%s' "$PROMPT" | "$BIN" run assistant --model "$MODEL" --format plain
