#!/bin/bash
# letta-code harness entry: seed per-run local-backend state in the workspace,
# then run the headless prompt against the seeded openai-compatible provider.
set -e
export LETTA_LOCAL_BACKEND_DIR="$PWD/.letta-state"
mkdir -p "$LETTA_LOCAL_BACKEND_DIR/providers"
KEY="$LETTA_STUDY_KEY" NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)" python3 - <<'PY'
import json, os, uuid, time
key = os.environ["KEY"]
rec = {
  "id": str(uuid.uuid4()),
  "name": "lc-openai-compatible",
  "provider_type": "openai-compatible",
  "provider_category": "byok",
  "auth": {"type": "api", "key": key},
  "base_url": os.environ["HOTDOG_EVAL_GATEWAY_URL"] + "/v1",
  "created_at": os.environ["NOW"],
  "updated_at": os.environ["NOW"],
}
with open(os.path.join(os.environ["LETTA_LOCAL_BACKEND_DIR"], "providers", "auth.json"), "w") as f:
    json.dump({"version": 1, "providers": {"lc-openai-compatible": rec}}, f, indent=2)
PY
exec /usr/bin/node ${HOTDOG_EVAL_HARNESS_DIR}/letta-code/letta.js \
  -p "$1" -m openai-compatible/${HOTDOG_EVAL_MODEL} --backend local
