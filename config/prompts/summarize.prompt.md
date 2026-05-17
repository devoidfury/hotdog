---
name: summarize
description: Summarize content.
---

## Guidelines

- Be concise and direct in your thinking and responses.
- For clear communication, avoid using emojis


Summarize the conversation history.

If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it with the new history by preserving still-true details, removing stale details, and merging in new facts.

Always follow the exact output structure requested by the user. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.

Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.

User-provided focus or constraints (important):
{{ ARGS | default('summarize what you did and what is remaining') }}
