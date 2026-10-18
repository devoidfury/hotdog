#!/bin/bash
# grinta one-shot wrapper.
# grinta's piped-stdin non-interactive runner renders assistant text through
# Rich Live panels that never reach a piped stdout; the committed reply lands
# in the per-session events.db instead. So: seed per-run HOME (settings.json
# via APP_ROOT + data under $HOME/.grinta), disable file logging (its default
# dir is the source checkout's logs/, read-only in the sandbox), run one turn
# on piped stdin, then emit the last agent "message" event to stdout.
set -uo pipefail
export HOME="$PWD/.grinta-home"
export APP_ROOT="$HOME"
export LOG_TO_FILE=0
mkdir -p "$APP_ROOT"
cat > "$APP_ROOT/settings.json" <<'JSON'
{
  "llm_provider": "openai",
  "llm_model": "openai/__MODEL__",
  "llm_api_key": "${LLM_API_KEY}",
  "llm_base_url": "__GW_URL__/v1"
}
JSON
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g; s|__MODEL__|${HOTDOG_EVAL_MODEL}|g" "$APP_ROOT/settings.json"
cd "$HOME" && mkdir -p proj && cd proj
git init -q 2>/dev/null || true
${HOTDOG_EVAL_VENV_DIR}/grinta-coding-agent/venv/bin/grinta --no-splash --project "$PWD"
RC=$?
python3 - "$HOME" <<'PY'
import glob, json, os, sqlite3, sys
home = sys.argv[1]
reply = ""
dbs = sorted(glob.glob(os.path.join(home, ".grinta/workspaces/*/storage/sessions/*/events/events.db")))
for db in dbs:
    try:
        con = sqlite3.connect(db)
        for (payload,) in con.execute("SELECT payload FROM events ORDER BY id DESC"):
            try:
                ev = json.loads(payload)
            except Exception:
                continue
            if ev.get("source") == "agent" and ev.get("action") == "message" and not ev.get("args", {}).get("is_tool_call"):
                reply = ev.get("message", "")
                break
        con.close()
        if reply:
            break
    except Exception:
        continue
print(reply)
PY
exit $RC
