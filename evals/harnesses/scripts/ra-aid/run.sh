#!/bin/bash
# ra-aid: one-shot task mode `ra-aid -m PROMPT --research-only` (research
# agent only; the full task pipeline drags in an aider-based expert).
# Wiring: the "openai-compatible" provider reads base_url from
# OPENAI_API_BASE and key from OPENAI_API_KEY (EXPERT_* variants set for
# parity), model passed via --model. COLUMNS=500 (spec env) keeps the rich
# Research Notes panel from wrapping reply text mid-string.
set -uo pipefail
export OPENAI_API_BASE="${HOTDOG_EVAL_GATEWAY_URL}/v1"
export OPENAI_API_KEY="$RA_GW_KEY"
export EXPERT_OPENAI_API_BASE="${HOTDOG_EVAL_GATEWAY_URL}/v1"
export EXPERT_OPENAI_API_KEY="$RA_GW_KEY"
${HOTDOG_EVAL_VENV_DIR}/ra-aid/venv/bin/ra-aid -m "$1" \
  --research-only --provider openai-compatible --model ${HOTDOG_EVAL_MODEL}
RC=$?
exit $RC
