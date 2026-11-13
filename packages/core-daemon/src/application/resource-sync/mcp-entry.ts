import type { capabilityToMcpServer } from "../capability-service.js";

// Single-entry native serialization. Never regenerates an entire user config.
export function nativeMcp(
  server: ReturnType<typeof capabilityToMcpServer> & {},
  provider: string,
): Record<string, unknown> {
  const remote = server.transport === "http";
  if (provider === "opencode")
    return remote
      ? {
          enabled: true,
          type: "remote",
          url: server.url,
          ...(Object.keys(server.headers ?? {}).length
            ? { headers: server.headers }
            : {}),
        }
      : {
          enabled: true,
          type: "local",
          command: [server.command, ...(server.args ?? [])],
          ...(Object.keys(server.env ?? {}).length
            ? { environment: server.env }
            : {}),
        };
  const value: Record<string, unknown> =
    provider === "codex" ? {} : { type: remote ? "http" : "stdio" };
  for (const key of remote
    ? (["url", "headers"] as const)
    : (["command", "args", "env", "cwd"] as const))
    if (server[key] !== undefined)
      value[provider === "codex" && key === "headers" ? "http_headers" : key] =
        server[key];
  return value;
}
export function safe(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      ["env", "environment", "headers", "http_headers"].includes(key) &&
      v &&
      typeof v === "object"
        ? Object.fromEntries(Object.keys(v).map((k) => [k, "[REDACTED]"]))
        : v,
    ]),
  );
}
