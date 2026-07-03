---
name: complexity-audit
description: Structured code review prompt with recent changes
---
# Code Audit & Refactoring Workflow

## Goal
Systematically identify high-complexity code, prioritize improvements by impact vs effort, and execute changes while verifying correctness.

## Process

### 1. Discover
- List all source files and their line counts
- Measure cyclomatic complexity (CCN) (count `if`, `match`, `for`, `while`, `&&`, `||`, `?` decision points per function)
- Flag functions above threshold (10–15 depending on language)
- For example, using lizard with threshold 15 `/home/ubuntu/shared/python-tools-venv/bin/lizard -C 15 -w path/`
- Cross-reference for duplicate code (same pattern in 2+ files)

### 2. Prioritize
Rank findings using an impact/effort matrix:

| | Low Effort | Medium Effort | High Effort |
|---|---|---|---|
| **High Impact** | Quick Wins | Strategic | — |
| **Low Impact** | Cleanup | — | — |

- **Quick Wins**: Fix bugs, extract helpers, deduplicate — do first
- **Strategic**: Extract sub-loops, refactor large functions — do next
- **Cleanup**: Minor pattern improvements — do when time allows

### 3. Execute
- Implement quick wins first (build + verify after each)
- For strategic refactors: extract inner loops into separate functions, extract outcome enums, verify complexity drops
- Always re-run complexity measurement after changes to confirm improvement

### 4. Verify
- Build passes (`cargo check`, `npm test`, etc.)
- Complexity measurement shows improvement
- No new warnings or errors introduced

## Common Patterns to Target

**Duplicate code across files**: Extract to shared utility module
**Repeated match arms**: Extract guard condition into helper function
**Nested loops**: Extract inner loop into separate function with clear return type
**Duplicated setup/teardown**: Extract into shared function
**Buggy implementations**: Fix first (e.g., byte-slicing instead of char iteration for UTF-8)

## Output Format

Present findings as:
```
# Code Audit Report

## Quick Wins (HIGH Impact, LOW Effort)
1. **[Title]** — One-sentence problem. Location: `file:line`. Fix: concrete action.

## Strategic Improvements (HIGH Impact, MEDIUM+ Effort)
...

## Cleanup (MEDIUM Impact, LOW Effort)
...
```

Each finding includes location, fix, and impact justification.
