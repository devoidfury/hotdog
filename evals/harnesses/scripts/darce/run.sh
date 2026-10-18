#!/bin/bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# darce-cli is an ink TUI (requires a TTY; no headless mode). This wrapper
# drives it on a pseudo-terminal: the prompt is auto-submitted via the CLI
# arg, the reply is awaited, then Ctrl+C terminates the REPL. The captured
# screen stream (ANSI included) is emitted on stdout.
set -u
export DARCE_API_KEY=${DARCE_GW_KEY}
export DARCE_API_BASE=${DARCE_API_BASE:-${HOTDOG_EVAL_GATEWAY_URL}}
export DARCE_MODEL=${DARCE_MODEL:-${HOTDOG_EVAL_MODEL}}
exec python3 ${HERE}/pty_run.py "$1" 20
