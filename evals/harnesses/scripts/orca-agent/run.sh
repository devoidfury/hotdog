#!/bin/bash
# orca-agent wrapper: DeepSeek-native client pointed at the OpenAI-compatible
# gateway via ORCA_* env. Per-run ORCA_HOME; workspace marked trusted (a fresh
# workspace fails closed read-only by default). Runs headless `orca exec` in
# jsonl mode and emits only the final assistant_content (the text format
# streams token-by-token lines, which would break exact-match).
set -e
export ORCA_HOME="$PWD/.orca-home"
mkdir -p "$ORCA_HOME"
KEY="$(realpath "$PWD")"
cat > "$ORCA_HOME/folder_trust.toml" <<EOF
[folders."$KEY"]
level = "trusted"
EOF
export ORCA_BASE_URL="${HOTDOG_EVAL_GATEWAY_URL}/v1"
export ORCA_MODEL="${HOTDOG_EVAL_MODEL}"
export ORCA_API_KEY="$ORCA_GW_KEY"
BIN=${HOTDOG_EVAL_HARNESS_DIR}/orca-agent/target/release/orca
OUT="$(mktemp)"
RC=0
"$BIN" exec --mode full-auto --output-format jsonl "$1" > "$OUT" 2>/dev/null || RC=$?
python3 - "$OUT" <<'PY'
import json, sys
last = None
with open(sys.argv[1]) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("type") == "model.response.completed":
            c = (o.get("payload") or {}).get("assistant_content")
            if c:
                last = c
if last:
    print(last)
PY
rm -f "$OUT"
exit "$RC"
