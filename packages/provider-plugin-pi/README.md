# AgentHub Pi provider

AgentHub provider plugin for the Pi coding agent. It uses Pi's native JSONL RPC
mode, so streaming text, thinking, tool execution, usage, model discovery,
extension questions, steering, and native session resume remain structured.

## Requirements

Install Pi so that `pi` is on `PATH`, or set the AgentHub instance executable
to the Pi binary/wrapper. The adapter requires a Pi version whose help lists
`--mode` with `rpc` support.

## Permission modes

- `standard`: trusts project-local Pi resources and keeps Pi's configured tools.
- `read-only`: trusts project-local Pi resources but only enables read-only tools.
- `isolated`: ignores project-local Pi resources and keeps Pi's configured tools.

Pi authentication and custom model configuration continue to use Pi's own
configuration and environment variables when no endpoint is configured on the
AgentHub instance. When an AgentHub instance has a base URL, API key, API type,
and model rows, the plugin injects them as an isolated `agenthub` Pi provider
for that process without changing the user's global `models.json`.

## MCP servers

MCP capabilities enabled for the Pi provider are injected into each Pi RPC
process through AgentHub's generated Pi extension. The extension supports both
STDIO and Streamable HTTP servers, discovers their tools at session startup,
registers namespaced Pi tools such as `mcp_firecrawl_search`, forwards tool
calls and cancellation, and closes MCP sessions when the Pi session ends.

## Skills

AgentHub passes the skills enabled for Pi through the provider SDK. The plugin
materializes them in a run-scoped directory, including bundled `scripts/`,
`references/`, and assets, then loads each one through Pi's repeatable native
`--skill <path>` flag. Nothing is written to the user's global Pi directory.
Skills are available as `/skill:<name>` and may also be selected automatically
from their frontmatter descriptions.
