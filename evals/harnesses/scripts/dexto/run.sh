#!/bin/bash
# dexto headless one-shot: seed a project-local coding-agent.yml that routes
# the openai-compatible provider at the eval gateway, then `dexto run`.
# Runs under Node 22 (better-sqlite3 prebuilds; system Node 26 cannot build it).
set -u
export PATH="${HOTDOG_EVAL_NODE_DIR:+$HOTDOG_EVAL_NODE_DIR/bin:}$PATH"
cat > coding-agent.yml <<YML
systemPrompt: |
  You are a helpful AI assistant.

llm:
  provider: openai-compatible
  model: ${HOTDOG_EVAL_MODEL}
  apiKey: $DEXTO_GW_KEY
  baseURL: ${HOTDOG_EVAL_GATEWAY_URL}/v1
YML
exec node ${HOTDOG_EVAL_HARNESS_DIR}/dexto/packages/cli/dist/index.js run "$1"
