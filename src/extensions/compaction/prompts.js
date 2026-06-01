// Compaction prompts — summarization system and user prompts.

export const SUMMARIZATION_SYSTEM_PROMPT =
  'You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.';

export const SUMMARIZATION_USER_PROMPT_TEMPLATE = `
The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.

<conversation>
{conversation}
</conversation>`;

// Aggressive summarization prompt — shorter output, less context preserved
export const SUMMARIZATION_USER_PROMPT_SHORT = `The messages above are a conversation to summarize. Produce a CONCISE structured summary.

Use this EXACT format (keep each section very brief):

## Goal
[One sentence]

## Progress
### Done
- [x] [Brief]

### In Progress
- [ ] [Brief]

## Key Decisions
- [Decision]: [Brief rationale]

## Next Steps
1. [Brief]

## Critical Context
- [One-line data or "(none)"]

<conversation>
{conversation}
</conversation>`;
