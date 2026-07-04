---
name: code-review
description: Structured code review prompt with recent changes
---

# Code Review Request

Please review the following code changes. Focus on:
1. Correctness and potential bugs
2. Performance implications
3. Code style and readability
4. Security concerns

## View Recent Changes

`git log --oneline -10`

## Specific Focus

{{ ARGS | default(value="General review") }}

## Guidelines

- Be specific about issues found
- Suggest concrete improvements
- Note any breaking changes
- Consider edge cases
