# Conformance tests

Tests that verify hotdog against **published external specs**, with the spec
text as the oracle — not against our own prior behavior. Contrast with the
unit suites under `tests/`, which answer "behavior-preserved"; these answer
"spec-correct".

## Hard rules

1. **Never regenerate a fixture from hotdog's own output.** The golden-file
   trap: if we misread the spec, our output and our fixture are wrong together.
   Fixtures come from the spec text or the wider world only.
2. **Provenance header on every fixture.** JSON fixtures carry:

   ```json
   { "_provenance": { "source": "...", "url": "...", "retrieved": "YYYY-MM-DD", "sha256": "..." } }
   ```

   Non-JSON fixtures (`.sse`, `.txt`) carry the same block as a leading
   comment. `sha256` is the digest of the *external content as retrieved*
   (excluding the provenance wrapper), verified in-test with
   `Bun.CryptoHasher` over the fixture's payload field(s).
3. **Provenance values**: `spec` (quoted from the spec text), `official-example`
   (example message from spec/docs prose), `recorded` (capture of real
   third-party traffic — only when no external example exists), or `derived`
   (mechanically derived from a spec grammar, e.g. boundary-split streams).
4. **Refresh is manual only.** Re-curl the URL, diff, update `retrieved` +
   `sha256`. There is deliberately **no refresh script** — nothing here may
   pull the network in CI.
5. **Zero new dependencies**, dev included. Specs enter as plain JSON/text
   fixtures.
6. **Network-free**, and the whole `bun test` budget stays under 10s.
7. Every `it()` name cites its spec section, e.g.
   `it("RFC 9110 §10.2.3: delta-seconds form")`.

## Pinned specs

| Suite | Spec | Pin | URL |
|-------|------|-----|-----|
| `mcp-conformance` | Model Context Protocol | 2025-11-25 | https://modelcontextprotocol.io/specification/2025-11-25 |
| `mcp-conformance` | JSON-RPC 2.0 | 2010-03-26 | https://www.jsonrpc.org/specification |
| `openai-wire-conformance` | OpenAI Chat Completions wire shape | captured 2026-09 (unversioned API; assert stable-required fields only) | https://platform.openai.com/docs/api-reference/chat |
| `sse-conformance` | WHATWG HTML, "Interpreting a text/event-stream" | living standard, captured 2026-09 | https://html.spec.whatwg.org/multipage/server-sent-events.html |
| `retry-after-conformance` | RFC 9110 §10.2.3 `Retry-After` | Sep 2022 | https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3 |
| `json-schema-suite` | JSON-Schema-Test-Suite (draft 2020-12 subset) | phase 3, TBD | https://github.com/json-schema-org/JSON-Schema-Test-Suite |

## Layout

One `.test.ts` per spec plus `fixtures/` with a subdirectory per spec. See
`secret-sauce/spec-test-plan.md` for phasing and target rationale.

## Deviations (intentional, pinned by tests)

hotdog's SSE parser is an OpenAI-flavored JSON parser, not a browser
EventSource. Where WHATWG HTML 9.2.6 and hotdog deliberately differ:

1. **Per-line dispatch.** The spec buffers `data:` lines until the blank-line
   event boundary, then dispatches one event. hotdog dispatches each `data:`
   line that holds complete JSON immediately (streaming latency; OpenAI sends
   one JSON payload per data line). Case `incomplete-event-at-eof`.
2. **Non-`message` event types are ignored**, not dispatched as custom events.
   Case `event-field-not-message`.
3. **Only JSON objects are yielded** (the parser's type contract). Spec data
   is an opaque string; hotdog drops scalars/arrays with a warning. Case
   `official-yhoo-example`.

Also hotdog-specific, no spec claim: the `[DONE]` sentinel, JSON fragmentation
across data lines (LF-less concat), and the `maxJsonBuffer` cap.
