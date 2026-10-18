#!/bin/bash
# forge one-shot: seed a per-run FORGE_CONFIG dir with an OpenAI-compatible
# provider pointed at the eval gateway, then run the debug binary with -p.
set -u
FORGE=${HOTDOG_EVAL_HARNESS_DIR}/forge/target/debug/forge
export FORGE_CONFIG=$PWD/.forge-config
mkdir -p "$FORGE_CONFIG"
cat > "$FORGE_CONFIG/.forge.toml" <<TOML
[session]
provider_id = "gateway"
model_id = "${HOTDOG_EVAL_MODEL}"

[reasoning]
enabled = false
effort = "none"

[[providers]]
id = "gateway"
api_key_var = "FORGE_GW_KEY"
url = "${HOTDOG_EVAL_GATEWAY_URL}/v1/chat/completions"
response_type = "OpenAI"
auth_methods = ["api_key"]

[[providers.models]]
id = "${HOTDOG_EVAL_MODEL}"
name = "Gemma 4 26B A4B"
context_length = 262144
tools_supported = true
supports_parallel_tool_calls = true
supports_reasoning = false
input_modalities = ["text"]
TOML
exec "$FORGE" -p "$1"
