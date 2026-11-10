import type { ProviderCapability } from "@agenthub/domain";

export type CapabilityOriginKind = "builtin" | "plugin" | "local" | "custom" | "unknown";
export function capabilityOrigin(tool: ProviderCapability): { kind: CapabilityOriginKind; label: string; path?: string } {
  const source = tool.skill?.source?.trim();
  const path = tool.skill?.resourceDir?.trim() || (/^(?:[a-z]:[\\/]|\/|~[\\/])/i.test(source ?? "") ? source : undefined);
  const normalized = (path ?? source ?? "").replaceAll("\\", "/");
  if (tool.tags.includes("builtin") || /^(?:built[ -]?in|内置)$/i.test(source ?? "")) return { kind: "builtin", label: "Nautilo", path };
  const plugin = normalized.match(/\/plugins\/(?:cache\/[^/]+\/)?([^/]+)/i)?.[1];
  if (plugin) return { kind: "plugin", label: plugin, path };
  if (path) {
    const owner = normalized.match(/\/(\.codex|\.claude|\.kimi-code|\.omp|\.pi|\.config\/opencode)\//i)?.[1];
    const names: Record<string, string> = { ".codex": "Codex", ".claude": "Claude Code", ".kimi-code": "Kimi Code", ".omp": "Oh My Pi", ".pi": "Pi", ".config/opencode": "OpenCode" };
    return { kind: "local", label: names[owner?.toLowerCase() ?? ""] ?? "", path };
  }
  if (/^(?:custom|手动创建|自定义)$/i.test(source ?? "")) return { kind: "custom", label: "" };
  if (source && !/^[|>][-+]?\s*$/.test(source)) return { kind: "local", label: source };
  return { kind: "unknown", label: "" };
}

export function capabilityDescription(tool: ProviderCapability): string {
  const description = tool.description.trim();
  return /^[|>][-+]?\s*$/.test(description) ? "" : description;
}
