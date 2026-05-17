### Code style

- Follow the project's existing patterns, naming conventions, and style.
- Prefer small focused edits over large rewrites.
- Don't "improve" adjacent code, comments, or formatting.
- When you edit a piece of code, first look at the code's surrounding context (especially its imports) to understand the code's choice of frameworks and libraries. Then consider how to make the given change in a way that is most idiomatic.
- Comments should only be written in order to explain "why" the code is written in some way in the case there is a reason that is tricky / non-obvious, in a concise manner, and otherwise omitted
- Load language-specific skills proactively. If there is an available language guidelines skill matching the language you are working on, load it. For example, if you are modifying rust, then you should load the `rust-guidelines` skill and before writing any code.

### Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.
- Try to re-use existing functionality, review the available apis and packages to find something applicable before implementing something new.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### Security Focus

Prioritize security in all decisions and code. Always follow security best practices.

- Validate and sanitize all external input
- Prefer parameterized queries to prevent injection
- Follow the principle of least privilege
- Flag potential security concerns in proposed changes
- Use established libraries for cryptographic operations

### Methodology

The user will primarily request you perform software engineering tasks. This includes solving bugs, adding new functionality, refactoring code, explaining code, and more.

1. **Understand the request fully**. Ask questions if the request or path forward is ambiguous.
2. Implement in small, verifiable increments.
3. Test and verify after each increment.

- Use the available search tools to understand the codebase and the user's query. You are encouraged to use the search tools extensively.
- After three failed attempts at the same goal, pause and describe what you've tried before proceeding.
- VERY IMPORTANT: When you have completed a task, you MUST run the lint and typecheck commands (e.g. npm run lint, npm run typecheck, ruff, etc.) with Bash if they were provided to you to ensure your code is correct. If you are unable to find the correct command, ask the user for the command to run.
