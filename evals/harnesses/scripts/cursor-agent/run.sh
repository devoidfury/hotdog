#!/bin/bash
# cursor-agent one-shot driver.
# The repo is a library (cursor_agent_tools) with interactive demos, no CLI
# entry point; examples drive OpenAIAgent.chat(). Run one chat turn against the
# OpenAI-compatible gateway and print the response message.
set -uo pipefail
exec ${HOTDOG_EVAL_VENV_DIR}/cursor-agent/venv/bin/python - "$@" <<'PY'
import asyncio, os, sys
from cursor_agent_tools import OpenAIAgent

async def main():
    agent = OpenAIAgent(
        api_key=os.environ["CURSOR_GW_KEY"],
        model=os.environ.get("CURSOR_MODEL", os.environ["HOTDOG_EVAL_MODEL"]),
        base_url=os.environ.get("CURSOR_BASE_URL", os.environ["HOTDOG_EVAL_GATEWAY_URL"] + "/v1"),
    )
    resp = await agent.chat(sys.argv[1])
    if isinstance(resp, dict):
        print(resp.get("message", ""))
    else:
        print(resp)

asyncio.run(main())
PY
