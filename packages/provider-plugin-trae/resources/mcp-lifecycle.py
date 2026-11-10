"""Run native Trae Agent with correct ownership of nested MCP transports."""
from importlib.metadata import version

# Trae Agent 0.1.0 opens the MCP transports in sequence but closes them in
# that same order. AnyIO cancel scopes must close in reverse opening order.
# Keep every server active and let cleanup errors propagate normally.
if version("trae-agent") == "0.1.0":
    from trae_agent.agent.trae_agent import TraeAgent

    async def close_mcp_transports(self):
        while self.mcp_clients:
            client = self.mcp_clients.pop()
            await client.cleanup("cleanup")

    TraeAgent.cleanup_mcp_clients = close_mcp_transports

from trae_agent.cli import main

main()
