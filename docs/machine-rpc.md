# Machine interface (`hotdog rpc`, `--json-events`)

A versioned JSONL protocol for driving hotdog from programs: CI jobs, other agents, IDE glue, dashboards. Two transports, one record vocabulary:

| Transport | Command | Shape |
|---|---|---|
| RPC session | `hotdog rpc` | persistent; commands on stdin, events on stdout |
| One-shot stream | `hotdog -p "..." --json-events` | single turn; events on stdout, terminal `result` record |

This is deliberately **not** the webui WebSocket protocol. That one is the webui's private contract and evolves with the UI. This protocol is the embedding surface: small, stable, additive-within-major like the rest of the published surface (`./sdk`).

## Invariants

- **stdout carries only records.** One JSON object per line, `\n`-terminated. Diagnostics, logs, and warnings go to stderr (and the session log). Piping stdout to `jq` always works.
- **Every record carries `v`** (protocol version, currently `1`) and a string `type`.
- **Event names are strings** (`tool_call`, `streaming_chunk`, ...). The core's numeric event types are internal and never reach the wire.
- **Unknown inbound fields are ignored** (forward compatibility); an unknown `cmd` is a rejection, not an ignore.
- Ordering: event records carry a per-connection `seq` (monotonic from 1). Control records (`hello`, `reply`, `error`, `ask`, `result`) do not.

## Inbound commands (stdin, RPC session)

```json
{"id": 1, "cmd": "prompt", "text": "run the test suite"}
```

| `cmd` | Fields | Semantics |
|---|---|---|
| `prompt` | `text` (required, non-empty) | Non-`/` text is submitted like a terminal send: steers mid-run, queues at idle. `/`-prefixed text runs as a slash command (`/compact`, `/sessions`, `/attach ...`). |
| `cancel` | `session` (optional; default: connection's session) | The Esc-equivalent: stop the current run. |
| `interrupt` | `session` (optional) | Harder stop (same seam as the CLI interrupt). |
| `status` | — | Reply `data`: `{ current, sessions: [{id, model?, profile?}], pendingAsks: [...] }`. |
| `answer` | `askId` (required), `answers` (required object) | Resolve a pending `ask` (see below). |
| `shutdown` | — | Acks, closes the connection, process exits 0. |

`id` is an optional string/number echoed on the reply for correlation. Records without `id` still act, but you get no ack. A malformed line produces `{"type":"error"}`; a well-formed line with a readable `id` that fails validation produces `reply(ok:false, id)` so pipelining clients can correlate.

## Outbound records (stdout)

### `hello` — first record of an RPC session

```json
{"v":1,"type":"hello","protocol":"hotdog.rpc","version":1,"session":"<uuid>","model":"provider/model"}
```

One session per connection in v1; `hello` names it. Multi-attach (`/attach`) rides the event stream's `session` fields.

### `event` — the agent talking

```json
{"v":1,"type":"event","seq":12,"session":"<uuid>","event":"tool_call","data":{...}}
```

`data` is the core output event minus its internal numeric type:

| `event` | `data` |
|---|---|
| `user_message` | `content`, `images?`, `files?` |
| `assistant_message` | `content` |
| `thinking` | `content` (complete reasoning block of a step) |
| `streaming_chunk` | `content` (text delta) |
| `streaming_reasoning_chunk` | `content` (reasoning delta) |
| `tool_call` | `toolName`, `input` (raw JSON string), `toolCallId` |
| `tool_result` | `toolName`, `input`, `content`, `toolCallId`, `error?`, `images?` |
| `tool_call_delta` | `index`, `name`, `args` (accumulated), `argsDelta` -- live-only, mid-stream preview; the settled `tool_call` follows |
| `token_usage` | session/turn token totals, `contextWindow`, `durationMs?` |
| `session_state` | `key` (e.g. `"working"`), `value`, `sessionId` |
| `compacting` | `message?` |
| `compaction_result` | `messagesCompacted`, `tokensBefore`, `tokensAfter`, `strategy`, `summary?` |
| `command_result` | `content` (slash-command output) |
| `system_message` | `content` |
| `task_progress` | `taskId`, `status`, `message?` |
| `question` | `questions` -- display only; answer via the paired `ask` record |
| `queue_update` | `pending`, `preview` -- live-only queue chip state |
| `stream_reset` | `{}` (streaming buffer invalidated) |

An unmapped type surfaces as `event: "unknown"` with the raw number in `t` rather than being dropped.

### `reply` — command ack

```json
{"v":1,"type":"reply","id":1,"ok":true}
{"v":1,"type":"reply","id":2,"ok":false,"error":"unknown cmd: teleport"}
```

### `ask` / `answer` — the question seam

The question tool and (when `userGate` is enabled) tool-approval prompts block on a human. Over RPC they surface as:

```json
{"v":1,"type":"ask","session":"<uuid>","askId":"a1","data":{"questions":[{"key":"mode","prompt":"Which mode?","options":["a","b"],"required":true}]}}
```

Answer with `{"cmd":"answer","askId":"a1","answers":{"mode":"a"}}`. Honest-release rules, matching the CLI: a run cancel or connection close releases held asks as *unanswered* (the agent is told the question was not answered; defaults are never silently presented as your reply). `status.pendingAsks` lists live `askId`s.

### `error` — unattributable parse failure

```json
{"v":1,"type":"error","message":"invalid JSON"}
```

### `result` — terminal record, `--json-events` only

```json
{"v":1,"type":"result","session":"<uuid>","ok":true,"exitCode":0}
```

Always the last stdout record; replaces the human `Session: <id>` trailer. One turn is the whole contract: the run ends at the first completed turn. `--json-events` cannot be combined with `--json-schema` (two stdout contracts, one stdout).

## Examples

One-shot, extract the final text:

```sh
hotdog -p "summarize CHANGELOG.md" --json-events \
  | jq -r 'select(.event=="assistant_message") | .data.content'
```

Scripted RPC session (bash, correlation ids, answer the one question):

```sh
{ printf '{"id":1,"cmd":"prompt","text":"which port should the server use?"}\n'
  sleep 8
  printf '{"id":2,"cmd":"answer","askId":"a1","answers":{"port":"9090"}}\n'
  sleep 5
  printf '{"id":3,"cmd":"shutdown"}\n'
} | hotdog rpc
```

Watch a session live:

```sh
hotdog rpc < commands.fifo | jq --unbuffered 'select(.type=="event") | {seq, event}'
```

## Scope and non-goals (v1)

- One process, one primary session (`hello` names it); the multi-session hub stays the webui's WebSocket protocol for now.
- `-s <id>` continues a session (same contract as one-shot); questions held by the resumed log close honestly as unanswered -- the seam cannot re-ask a tool call that is gone.
- No auth: stdin/stdout is the trust boundary. Do not expose a raw RPC process over a socket; put a broker in front if you need one.
- Authenticated/embedded use: the webui server already speaks the richer internal protocol; this document's contract is stdio only.

## Versioning

`v` is the protocol version. Additive changes (new event names, new optional fields, new `cmd`s) ride within a major; breaking changes bump `v` and are listed in the CHANGELOG. Clients must ignore unknown fields and unknown event names.
