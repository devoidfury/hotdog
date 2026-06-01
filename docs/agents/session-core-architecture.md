> **⚠️ OBSOLETE — This design was never implemented.**
>
> The actual code uses an extension-based architecture with hooks. See `docs/agents/architecture.md` for the current architecture.
>
> This document is preserved as a design artifact. The target architecture described below was replaced by the extension system implemented in `src/core/extensions.js` and `src/hooks.js`.

# Session Core Architecture — Restructuring Plan

> **Status**: Superseded by extension architecture
> **Created**: 2025-05-19
> **Actual Implementation**: Extension-based architecture (2026)

---

## What Replaced This Plan

The extension architecture described in `docs/agents/architecture.md` achieves the same goals:

| This Plan's Component | Actual Implementation |
|----------------------|----------------------|
| `SessionCore` | `src/core/session.js` (SessionManager) |
| `EventRouter` | `src/main.js` MessageBus |
| `TaskOrchestrator` | `src/session/task_manager.js` |
| `AgentSink` | `src/session/agent_sink.js` |
| `ClientApp` layer | `src/ui/session.js` (thin readline) |
| `Duplex Event Queue` | `src/context/output.js` OutputSink |
| Extension system | `src/core/extensions.js` + `src/hooks.js` |

All features (tools, compaction, MCP, skills, prompts, LSP, subcommands) are now implemented as extensions in `extensions/` that plug into the core via hooks.
