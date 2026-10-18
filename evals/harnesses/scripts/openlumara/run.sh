#!/bin/bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# openlumara: chatbot framework (discord/telegram/etc.) with a stdin REPL
# channel (cli_lite); there is no headless one-shot flag. The manager never
# exits on stdin EOF in non-debug mode, so the wrapper: (1) runs a per-run
# copy of the checkout (the manager reloads config from the project root),
# (2) seeds config.yml with the gateway as the OpenAI endpoint, the cli_lite
# channel only, no tools, no thinking, (3) drives it with ol-driver.py which
# feeds the prompt on stdin and SIGTERMs the app once the response settles.
set -uo pipefail
DEST="$PWD/openlumara"
mkdir -p "$DEST"
tar -C ${HOTDOG_EVAL_HARNESS_DIR}/openlumara \
  --exclude=venv --exclude=data --exclude=data_backups --exclude=__pycache__ \
  --exclude=.module_cache.json --exclude=config.yml --exclude='*.yml' -cf - . | tar -C "$DEST" -xf -
cat > "$DEST/config.yml" <<YAML
api:
  url: ${HOTDOG_EVAL_GATEWAY_URL}/v1
  key: "$OPENLUMARA_GW_KEY"
model:
  name: ${HOTDOG_EVAL_MODEL}
  use_tools: false
  enable_thinking: false
channels:
  enabled:
    - cli_lite
  disabled:
    - cli
    - webui
YAML
cd "$DEST"
PROMPT=$(cat)
python3 ${HERE}/ol-driver.py "$PROMPT"
RC=$?
exit $RC
