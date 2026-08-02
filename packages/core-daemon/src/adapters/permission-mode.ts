import type { AgentInstance } from "@agenthub/domain";

/** Empty/whitespace session values mean “follow the instance setting”. */
export function normalizePermissionMode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

/** Resolves session override precedence without letting an empty string mask the instance default. */
export function resolvePermissionMode(instance: AgentInstance, request?: { permissionMode?: string }): string | undefined {
  return normalizePermissionMode(request?.permissionMode)
    ?? normalizePermissionMode(instance.providerOptions?.permissionMode);
}
