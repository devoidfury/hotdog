#!/bin/bash
# SWE-agent one-shot wrapper.
# - Local deployment copies the repo to /<repo_name> (needs writable /; the
#   bwrap sandbox root is a fresh tmpfs, so this only works sandboxed).
# - LocalRepoConfig.copy() then runs `chown -R root:root /<repo>` (docker-era
#   habit); as uid 1001 in the sandbox that fails. PATH shim: a no-op chown,
#   since the agent runs as the same uid that owns the files.
set -uo pipefail
ROOT="$PWD"
export COLUMNS=300
mkdir -p "$ROOT/.swebin"
printf '#!/bin/bash\nexit 0\n' > "$ROOT/.swebin/chown"
chmod +x "$ROOT/.swebin/chown"
export PATH="$ROOT/.swebin:$PATH"
mkdir -p "$ROOT/swe-repo"
cd "$ROOT/swe-repo"
git init -q 2>/dev/null
git config user.email swe@swe 2>/dev/null
git config user.name swe 2>/dev/null
echo 'print("hi")' > main.py
git add -A && git commit -qm init
cd "$ROOT"
OUT=$(mktemp -d "$ROOT/.sweout.XXXX")
${HOTDOG_EVAL_VENV_DIR}/SWE-agent/venv/bin/sweagent run \
  --config ${HOTDOG_EVAL_HARNESS_DIR}/SWE-agent/config/default.yaml \
  --env.deployment.type=local \
  --env.repo.type=local \
  --env.repo.path "$ROOT/swe-repo" \
  --agent.model.name openai/${HOTDOG_EVAL_MODEL} \
  --agent.model.api_base ${HOTDOG_EVAL_GATEWAY_URL}/v1 \
  --agent.model.api_key "$SWE_GW_KEY" \
  --agent.model.per_instance_cost_limit 0 \
  --agent.model.total_cost_limit 0 \
  --problem_statement.text "$1" \
  --output_dir "$OUT" > "$OUT/run.log" 2>&1
RC=$?
cat "$OUT/run.log"
# Emit the model's final submission from the trajectory to stdout.
python3 - "$OUT" <<'PY'
import json, sys, glob
out = sys.argv[1]
sub = ""
for f in sorted(glob.glob(out + "/trajectories/*.traj")) + sorted(glob.glob(out + "/trajectories/*")):
    try:
        for line in open(f, encoding="utf-8", errors="replace"):
            line = line.strip()
            if line.startswith("{"):
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                if ev.get("action") == "submit":
                    sub = str(ev.get("arguments", {}).get("content", sub))
    except Exception:
        continue
print(sub)
PY
exit $RC
