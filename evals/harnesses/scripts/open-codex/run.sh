#!/bin/bash
# open-codex harness entry: seed ~/.codex/config.json (model + gateway baseURL;
# no "provider" key, so the pinned per-provider baseURL is not forced) then
# run quiet one-shot mode. The bundled dist/cli.js is broken (vite single-file
# bundle trips apply-patch's self-exec guard: import.meta.url === argv[1] on
# the bundle, so it always exits "Please pass patch text through stdin");
# run the TS source via bun instead. Quiet mode prints every conversation
# item as JSON, so emit only the assistant text lines.
set -e
mkdir -p "$HOME/.codex"
python3 - <<'PY'
import json, os
cfg = {"model": os.environ["HOTDOG_EVAL_MODEL"], "baseURL": os.environ["HOTDOG_EVAL_GATEWAY_URL"] + "/v1"}
open(os.path.expanduser("~/.codex/config.json"), "w").write(json.dumps(cfg))
PY
out=$(bun ${HOTDOG_EVAL_HARNESS_DIR}/open-codex/codex-cli/src/cli.tsx -q "$1" 2>/dev/null)
rc=$?
printf '%s\n' "$out" | python3 -c '
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        e = json.loads(line)
    except Exception:
        continue
    if e.get("role") == "assistant":
        c = e.get("content")
        if isinstance(c, str):
            print(c)
        elif isinstance(c, list):
            for p in c:
                if isinstance(p, dict) and p.get("type") == "text":
                    print(p.get("text", ""))
'
exit $rc
