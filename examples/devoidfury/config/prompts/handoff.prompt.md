---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save it to a path produced by `mktemp -t handoff-XXXXXX.md` (read the file before you write to it).

Suggest the skills to be used, if any, by the next session.

Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

{% if ARGS -%}
Treat this as a description of what the next session will focus on and tailor the doc accordingly:

{{ ARGS | default('') }}
{%- endif %}

Respond with the handoff file path you created as an xml tag using the following format, so that it can be detected by the tools:

<handoff>/tmp/handoff-IZPmwp.md</handoff>
