# AgentHub

AgentHub is a local desktop workspace for managing user-defined Coding Agent teams.

## Workspace layout

- apps/desktop — desktop shell entry point
- packages/domain — shared domain types
- packages/schemas — schema/version contracts
- packages/event-protocol — runtime event contracts
- packages/core-daemon — local runtime entry point

## Commands

    pnpm install
    pnpm check
    pnpm build
    pnpm dev

The repository now contains the Electron workbench, authenticated Core Daemon IPC, SQLite persistence, Codex/Kimi adapters, optional main-Agent delegation, isolated Git/verification workflows, permission enforcement, restart recovery, audit metrics and redacted diagnostics.

Runtime status is tracked in [outputs/feature-checklist.md](outputs/feature-checklist.md). The latest security and recovery implementation is documented in [outputs/security-recovery-observability-implementation.md](outputs/security-recovery-observability-implementation.md).
