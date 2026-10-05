012-error-paste-landmines fixture. paste.ts embeds the full control-token pool
(byte-exact strings harvested from evals/control-tokens/; rewrite with
`bun evals/tools/gen-paste-pool.ts`) and on each run deals 40 unique tokens,
shuffled, into a fake pasted error message. Random on purpose: every repeat
round gets a fresh deal, so 012 is run via the task-level "repeat": 10.
