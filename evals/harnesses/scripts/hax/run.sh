#!/bin/bash
set -e
export XDG_CONFIG_HOME="$PWD/.hax-home"
mkdir -p "$XDG_CONFIG_HOME/hax"
cat > "$XDG_CONFIG_HOME/hax/config.json" <<'JSON'
{
  "providers": {
    "gw": {
      "display_name": "GW",
      "api": "openai-completions",
      "base_url": "__GW_URL__/v1",
      "api_key_env": "HAX_GW_KEY"
    }
  }
}
JSON
sed -i "s|__GW_URL__|${HOTDOG_EVAL_GATEWAY_URL}|g" "$XDG_CONFIG_HOME/hax/config.json"
exec ${HOTDOG_EVAL_HARNESS_DIR}/hax/build/hax -p "$1" --provider=gw --model=${HOTDOG_EVAL_MODEL}
