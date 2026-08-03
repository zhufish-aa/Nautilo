# Nautilo

English | [中文](README.md)

Nautilo is a **local, user-configurable multi-agent coding workspace**. It runs as an Electron desktop app that centrally manages the Coding Agent CLIs already installed on your machine (Codex, Claude Code, Kimi Code, and more), lets you organize them into teams, attach local projects, and orchestrate them through a unified session UI.

Nautilo does not train models and does not replace any provider CLI — it is the **orchestration layer and management workbench** on top of those CLIs.

## Features

- **Multi-provider / CLI management**: built-in adapters for Codex, Claude Code, Kimi Code, and Custom CLI; OpenCode and Trae are available as optional plugins. Automatically detects installed CLIs and their versions.
- **Agent instance configuration**: per-instance executable, arguments, environment variables, credentials, base URL, permission mode, and model selection.
- **Team orchestration**: define member names, roles, capabilities, limitations, task types, and concurrency limits; bind agent instances and configure delegation policies.
- **Main-agent task decisions**: the main agent can complete work directly, delegate subtasks, or produce a dependency-aware task DAG executed and persisted by the orchestrator — with result handoff, retry, take-over, and continue.
- **Session workbench**: streaming messages, thinking traces, tool calls, command execution, file changes, usage stats, approvals, and session recovery in one unified interface.
- **Project management**: add/remove local projects, scan directories, Git status awareness, and workspace modes.
- **Git isolation & verification**: worktree isolation, allowedPaths restrictions, file/commit-level diffs, verification commands, a merge queue, and human-approved merges.
- **Permissions & security**: command policies, environment-variable allowlists, path policies, credential encryption, approval flows, log redaction, auditing, and runtime metrics.
- **Run recovery**: persisted runtime events, event subscription/replay, daemon restart recovery, and diagnostics export.
- **Provider plugin system**: install plugins from a local directory or the marketplace with SHA-256 verification; enable/disable/uninstall; plugins can override a built-in provider with the same ID (see [docs/provider-plugins.md](docs/provider-plugins.md)).
- **Onboarding tour**: a game-style, step-by-step spotlight tutorial on first launch, replayable anytime from Settings.
- **Bilingual UI**: Chinese by default, switchable to English.

## Architecture

```text
Electron Renderer (React)  →  Electron Main / Preload (contextBridge allowlist)
        →  IPC Gateway (authenticated JSON Lines: Windows named pipe / macOS·Linux Unix socket)
        →  Application Services
        →  Runtime Services / Repositories
        →  SQLite / Processes / PTY / CLIs
```

The layering and dependency-direction decision is documented in [docs/adr/0001-core-daemon-boundaries.md](docs/adr/0001-core-daemon-boundaries.md).

- **Core Daemon**: a standalone local Node.js daemon spawned by the Electron main process. It owns SQLite persistence, CLI process execution, provider adapters, orchestration, Git, permissions, recovery, auditing, and metrics. Default data directory `~/.agenthub`, database `agenthub.sqlite` (native `node:sqlite`, WAL mode). The IPC channel authenticates with a random token on the first line, then exchanges one JSON request/response per line; no fixed TCP port is opened by default.
- **Electron Desktop**: the renderer runs with Node integration disabled, context isolation and sandbox enabled; the preload layer exposes only an allowlisted API, and all business data flows through the daemon.

### Monorepo layout (pnpm workspace)

| Path | Description |
|---|---|
| `apps/desktop` | Electron desktop app (main / preload / renderer) |
| `packages/core-daemon` | Local core daemon (runtime entry point) |
| `packages/domain` | Shared domain models and state machines |
| `packages/event-protocol` | Unified runtime event protocol |
| `packages/schemas` | Versioned data and IPC schemas |
| `packages/provider-sdk` | Provider plugin SDK (adapter interface, descriptor, manifest) |
| `packages/provider-plugin-opencode` | OpenCode provider plugin |
| `packages/provider-plugin-trae` | Trae provider plugin |
| `packages/provider-plugin-template` | Plugin template: wrap any agent CLI as a Nautilo provider |
| `tests/contract` | Shared domain / schema contract tests |
| `docs` | Plugin documentation and architecture decision records (ADRs) |

## Tech Stack

- **Desktop**: Electron 33 · electron-vite · React 18 · React Router 6 · Zustand · Tailwind CSS v4 · Radix UI · Framer Motion · Lucide
- **Core Daemon**: Node.js ESM · TypeScript (strict / NodeNext / project references) · `node:sqlite` · JSON Lines IPC · node-pty · ACP / MCP SDKs
- **Tooling**: pnpm 10 workspace · TypeScript 5.8 · Node's built-in test runner

## Getting Started

### Prerequisites

- Node.js **>= 22.5** (the daemon relies on `node:sqlite`)
- pnpm **10.12.1** (declared via `packageManager`)
- At least one supported agent CLI installed, e.g. [Codex](https://github.com/openai/codex), Claude Code, or [Kimi Code](https://github.com/MoonshotAI/kimi-cli); OpenCode / Trae can be added via plugins

### Run in development

```bash
pnpm install
pnpm dev:desktop   # builds the Core Daemon and starts Electron in dev mode
```

On first launch, an onboarding tour walks you through: detect CLIs → create an agent instance → (optionally) build a team → add a project → start a session.

### Common commands

| Command | Description |
|---|---|
| `pnpm dev` | Start the Core Daemon dev workflow |
| `pnpm dev:daemon` | Build and start the daemon in serve mode |
| `pnpm build` | Full TypeScript project-references build |
| `pnpm build:desktop` | Build daemon + desktop app |
| `pnpm typecheck` | Type-check root project and desktop app |
| `pnpm test` | All workspace tests + contract tests |
| `pnpm check` | typecheck + test |
| `pnpm package:win` | Build and produce the Windows portable package |

### Packaging (Windows)

```bash
pnpm package:win
```

Produces `release/Nautilo-win32-x64/` and `release/Nautilo-win32-x64.zip`: a portable ZIP (not an installer) containing the renamed `Nautilo.exe` with icon and version metadata, daemon runtime dependencies, and a bundled Node runtime.

## Plugin Development

Built-in providers and third-party plugins share one contract: the `AgentCliAdapter` interface from `@agenthub/provider-sdk` plus an `agenthub-plugin.json` manifest. Integrating your own agent CLI takes three steps:

```bash
# 1. Copy the minimal template (compilable, installable, heavily commented)
cp -r packages/provider-plugin-template packages/provider-plugin-my-cli

# 2. Edit agenthub-plugin.json (id / descriptor) and src/index.ts (protocol translation)
# 3. Build
pnpm --filter <your-package> build
```

Then install via "Agents → Marketplace → Install from local directory", or copy the folder into `~/.agenthub/plugins/<plugin-id>/` and restart the app.

A plugin's core job is a single one: **translate the CLI's output protocol into the unified `AdapterEvent` stream** (messages, thinking, tool calls, commands, file changes, usage, artifacts…). The Provider Descriptor automatically drives the CLI detection page, the instance editor, and the permission-mode picker — **no frontend changes required**. The capability surface includes:

- Session resume (`resume` + `session` events) and streaming deltas
- Slash-command reporting and a dedicated `compact` transport
- User-interaction bridging (structured questions / permission prompts)
- Runtime tools (task delegation) and MCP server injection
- Overriding a built-in provider with the same ID (the built-in is restored on disable/uninstall)

The full development guide — manifest field reference, event protocol, lifecycle, marketplace publishing, and a debugging FAQ — lives in **[docs/provider-plugins.md](docs/provider-plugins.md)** (Chinese). `packages/provider-plugin-opencode/` (server reuse, timeout controls, model discovery) and `packages/provider-plugin-trae/` (dual-transport switching, ACP bridging) are two complete real-world reference implementations.

## Data & Privacy

- All business data stays on your machine in `~/.agenthub/` (SQLite + plugin directory); nothing is uploaded to any server.
- Credentials are stored encrypted; logs and diagnostics exports are redacted.
- Plugins are arbitrary local code and require explicit user confirmation; a failing plugin never blocks the daemon.

## Current Status & Known Limitations

- The Codex / Kimi Code adapters have been verified against the real CLIs; real-CLI verification for Claude Code / OpenCode is still in progress.
- Frontend automated tests and a Windows installer (beyond the portable ZIP) are still on the roadmap.
- Detailed progress is tracked in [outputs/feature-checklist.md](outputs/feature-checklist.md).

## License

No open-source license has been chosen yet. The repository is currently a private project (`private: true`).
