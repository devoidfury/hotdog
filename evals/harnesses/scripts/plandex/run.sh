#!/bin/bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -u
WS=$PWD
cleanup() {
  /usr/bin/pg_ctl -D "$WS/pgdata" stop -m fast >/dev/null 2>&1 || true
  pkill -f "plandex-server" 2>/dev/null || true
  pkill -f "litellm_proxy:app" 2>/dev/null || true
}
trap cleanup EXIT
export HOME="$WS/.plandex-home"
mkdir -p "$HOME"
# Prebuilt plandex + plandex-server binaries (not vendorable here; build from
# the plandex checkout): expected at <harness-dir>/plandex/bin.
BIN=${HOTDOG_EVAL_HARNESS_DIR}/plandex/bin
PLD=${HOTDOG_EVAL_HARNESS_DIR}/plandex
export PATH="${HOTDOG_EVAL_LITELLM_DIR:+$HOTDOG_EVAL_LITELLM_DIR/bin:}$PATH"

# --- postgres: fresh per-run cluster in the sandbox workspace ---
mkdir -p "$WS/pgsock"
/usr/bin/initdb -D "$WS/pgdata" -U plandex --auth=trust -E utf8 >"$WS/pg-init.log" 2>&1 || { echo PG-INIT-FAIL; tail -5 "$WS/pg-init.log"; exit 1; }
/usr/bin/pg_ctl -D "$WS/pgdata" -o "-p 54321 -k $WS/pgsock" -l "$WS/pg.log" start >"$WS/pg-ctl.log" 2>&1 || { echo PG-CTL-FAIL; tail -5 "$WS/pg.log" 2>/dev/null; exit 1; }
sleep 1
psql -h 127.0.0.1 -p 54321 -U plandex -d postgres -c "CREATE DATABASE plandex" >"$WS/pg-db.log" 2>&1 || { echo PG-DB-FAIL; tail -5 "$WS/pg-db.log"; exit 1; }

# --- plandex server (spawns its own litellm proxy on :4000) ---
export GOENV=development LOCAL_MODE=1
export DATABASE_URL="postgres://plandex@127.0.0.1:54321/plandex?sslmode=disable"
export PLANDEX_BASE_DIR="$WS/.plandex-base"
export LITELLM_PROXY_DIR=$PLD/app/server
export PYTHONDONTWRITEBYTECODE=1
export OPENAI_API_BASE=${HOTDOG_EVAL_GATEWAY_URL}/v1
export OPENAI_API_KEY="$PLANDEX_GW_KEY"
cd "$PLD/app/server"
nohup "$BIN/plandex-server" >"$WS/server.log" 2>&1 &
SERVER_PID=$!
cd "$WS"
ok=""
for i in $(seq 1 90); do
  if curl -sf http://127.0.0.1:8099/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ -z "$ok" ]; then echo SERVER-FAIL; tail -20 "$WS/server.log"; exit 1; fi

# --- bootstrap: account + org + auth.json (pure HTTP, no TTY) ---
export PLANDEX_AUTH_JSON="$HOME/.plandex-home-v2/auth.json"
timeout 120 python3 ${HERE}/bootstrap.py >"$WS/bootstrap.log" 2>&1 || { echo BOOTSTRAP-FAIL; tail -10 "$WS/bootstrap.log"; exit 1; }

# --- project: git repo in the workspace ---
PROJ="$WS/proj"
mkdir -p "$PROJ"
cd "$PROJ"
git init -q 2>/dev/null
git config user.email plandex@local
git config user.name plandex
echo ready > README.md
git add -A >/dev/null 2>&1 && git commit -qm init >/dev/null 2>&1

# --- custom gateway models + org-wide default pack ---
cp ${HERE}/models.json "$WS/models.json"
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "$WS/models.json"
timeout 90 "$BIN/plandex" models custom --file "$WS/models.json" --save >"$WS/models.log" 2>&1 || { echo MODELS-FAIL; tail -10 "$WS/models.log"; exit 1; }
timeout 60 python3 ${HERE}/setpack.py >"$WS/setpack.log" 2>&1 || { echo SETPACK-FAIL; tail -5 "$WS/setpack.log"; exit 1; }

# --- default plan config: auto-context off (gemma degenerates into a zero-content
#     reasoning loop on the auto-context chat prompt; verified by stream capture) ---
timeout 60 python3 ${HERE}/planconfig.py >"$WS/planconfig.log" 2>&1 || { echo PLANCONFIG-FAIL; tail -5 "$WS/planconfig.log"; exit 1; }

# --- expected exact reply, when the prompt demands one (001-greet form) ---
EXPECT=""
case "$1" in
  *"Reply with exactly this string and nothing else: "*)
    EXPECT="${1#*Reply with exactly this string and nothing else: }"
    ;;
esac

REPLY=""
ATTEMPT=1
while [ "$ATTEMPT" -le 3 ]; do
  timeout 90 "$BIN/plandex" new --name "greet-$ATTEMPT" >"$WS/new-$ATTEMPT.log" 2>&1 || { echo NEW-FAIL; tail -10 "$WS/new-$ATTEMPT.log"; exit 1; }
  export PTY_TIMEOUT=180
  timeout 240 python3 ${HERE}/ptyrun.py "$WS/tell-$ATTEMPT.log" "$BIN/plandex" tell "$1"
  RC=$?
  REPLY=$(timeout 60 "$BIN/plandex" convo --plain 2>&1 | sed -e "s/\x1b\[[0-9;?]*[a-zA-Z]//g" | awk '
    /^#### / { if (inblk) { printf "%s", buf }; buf = ""; inblk = ($0 ~ /Plandex/); next }
    inblk { buf = buf $0 "\n" }
    END { if (inblk) printf "%s", buf }')
  if [ -n "$(printf '%s' "$REPLY" | tr -d '[:space:]')" ]; then
    if [ -z "$EXPECT" ] || printf '%s' "$REPLY" | grep -qF -- "$EXPECT"; then
      break
    fi
  fi
  ATTEMPT=$((ATTEMPT + 1))
done

if [ -z "$(printf '%s' "$REPLY" | tr -d '[:space:]')" ]; then
  echo "EMPTY-REPLY"
  exit 1
fi
printf '%s\n' "$REPLY"
exit 0
