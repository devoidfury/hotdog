#!/bin/bash
# crush wrapper: per-run project-level crush.json pointing at the study gateway
set -euo pipefail
cat > crush.json <<JSON
{
  "models": {
    "large": { "model": "${HOTDOG_EVAL_MODEL}", "provider": "gw" },
    "small": { "model": "${HOTDOG_EVAL_MODEL}", "provider": "gw" }
  },
  "permissions": { "allowed_tools": ["agent","agentic_fetch","ask_user","bash","edit","glob","grep","ls","lsp_call_hierarchy","lsp_definition","lsp_symbols","multiedit","question","read_mcp_resource","sourcegraph","todos","view","write","list_mcp_resources"] },
  "providers": {
    "gw": {
      "id": "gw",
      "name": "gateway",
      "base_url": "${HOTDOG_EVAL_GATEWAY_URL}/v1",
      "type": "openai-compat",
      "api_key": "${CRUSH_GW_KEY}",
      "models": [
        { "id": "${HOTDOG_EVAL_MODEL}", "name": "${HOTDOG_EVAL_MODEL}", "context_window": 262144, "max_output_tokens": 8192 }
      ]
    }
  }
}
JSON
exec ${HOTDOG_EVAL_HARNESS_DIR}/crush/crush run --quiet -m gw/${HOTDOG_EVAL_MODEL} "$@"
