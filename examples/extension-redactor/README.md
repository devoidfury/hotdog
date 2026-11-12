# extension-redactor

A result-side gate: when a tool result matches a secret-shaped pattern, the
human is asked -- **"send it to the model as-is, or redact?"** -- before the
result reaches the provider, the session log, or the transcript. Pairs with
`extension-starter` (which shows the tool shape); this one shows the hook
shape: pipeline mutation plus the question seam.

```
extension.json   manifest + configSchema (patterns own their defaults here)
index.ts         create(core) -> one tool:result handler
```

## Load it

```json
{
  "extensionPaths": ["@extensions", "examples/extension-redactor"],
  "extensionRedactor": {
    "patterns": {
      "aws-access-key": "AKIA[0-9A-Z]{16}",
      "acme-cookie": "acme-session=[A-Za-z0-9]{40}"
    }
  }
}
```

A user `patterns` block **replaces** the default map, so re-include any
defaults you want kept. Patterns are JavaScript regexes (case-sensitive); the
label is what the human sees and what the session grant is keyed by.

## Verdicts

On a match the handler asks, one question at a time even with parallel tool
calls:

- **redact** (the default answer, so pressing Enter is the safe choice) --
  every match becomes `[redacted:<label>]`.
- **allow once** -- this result passes untouched.
- **allow for session** -- same tool + same label set passes until the session
  ends. A later result matching a *wider* label set asks again.

Everything else fails **closed** toward redact: no interactive UI (headless
runs), a seam that throws, a cancelled run, an empty answer. A malformed
regex withholds *every* result until the config is fixed -- a matcher that
can't be trusted doesn't get to wave things through. The handler never
throws.

## Threat model, plainly

This is **exfiltration control, not a sandbox**. By the time `tool:result`
fires, the tool has already run; what is mediated here is whether the secret
*leaves the machine* (provider request, session log, transcript). Three
honest limits:

- `tool:afterExecute` fires **before** this pipeline. Any other extension
  listening there sees the raw value.
- **Image bytes pass through.** A screenshot containing a secret is logged as
  unredactable; an opaque (non-text) result that matches is withheld whole.
- A model that copies the secret across calls or transforms it defeats any
  pattern list. Pattern gates catch accidents, not adversaries.

## The SDK surface it demonstrates

- `HOOKS.TOOL_RESULT` -- a **pipeline** hook: the handler returns
  `{ result }` and the payload adopts it; returning nothing is a no-opinion.
- `toolCtx` on the result payload (additive in the same release as this
  example) -- the same context the `tool:call` gate saw, so a result gate can
  prompt exactly like a pre-call gate.
- `QuestionSeam` via `toolCtx.get("input")` -- the one route to the human:
  `isInteractive()` then `collectAnswers(questions, signal)`. Always check
  `isInteractive()` and fail closed when the answer is no.
- `spoofSafe()` -- prompt text carries tool output; neutralize escapes/bidi
  before a human terminal sees it.
- Config at the point of use, `extension.json` owning every default, and no
  `enabled` re-check in `create()` -- same rules as the starter.

## Try it

```sh
bun bin/hotdog -p "cat ~/.aws/credentials"   # with the extension loaded
```

The repo suite boots this extension through the real discovery and loader
path and drives the pipeline with a fake seam (`extension-redactor.test.ts`
next to this README).
