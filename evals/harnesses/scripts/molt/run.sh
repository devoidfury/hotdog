#!/bin/bash
# molt (maat) harness entry: `run` verifies work against a .maat/done.yml bar
# and exits 3 on a pure-reply task; `ask` skips file-change checks but hangs on
# the interactive bar verdict afterwards. So: run ask, wait for the reply to
# land (the "· step 1" marker prints after it), then kill the process and
# emit the captured output. The runner's stdout regex is the real gate.
export MOLT_BASE_URL="${HOTDOG_EVAL_GATEWAY_URL}/v1"
export MOLT_MODEL="${HOTDOG_EVAL_MODEL}"
OUT="$(mktemp)"
timeout 150 node ${HOTDOG_EVAL_HARNESS_DIR}/molt/dist/cli.js ask "$1" --raw --yes >"$OUT" 2>&1 &
PID=$!
for _ in $(seq 1 90); do
  sleep 1
  if grep -q "· step 1" "$OUT" 2>/dev/null; then break; fi
done
kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null
cat "$OUT"
rm -f "$OUT"
exit 0
