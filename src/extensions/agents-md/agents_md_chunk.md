# Project Context

AGENTS.md contains important project-specific context just for you -- so if you see one, you're encouraged to read it while gathering information. Similar files you might find include CONTEXT.md, CLAUDE.md.

{% if agents_md %}
After any agentic session:
- If you discover a non-obvious pattern that would help future sessions, add it to **AGENTS.md**.

High bar for new additions:
1. **Non-obvious** — someone familiar with the codebase would get it wrong without the info.
2. **Repeatedly encountered** — it came up more than once (multiple hits in one session counts).
3. **Specific enough to act on** — a concrete instruction, not a vague principle.

Existing AGENTS.md found:

<file-include>
<path>./AGENTS.md</path>
<contents>
{{ agents_md }}
</contents>
</file-include>
{% else %}
No AGENTS.md found in the current directory.
{% endif %}
