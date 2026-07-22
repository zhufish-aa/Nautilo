import type { AgentInstance, ProviderModel, ProviderModelCatalog } from "@agenthub/domain";
import type { AdapterInvocation } from "../process-adapter.js";

export interface KimiModelDiscoveryRuntime {
  capture(command: string, args: string[], env?: Record<string, string | undefined>): Promise<{ text: string; exitCode: number | null }>;
  invocation(instance: AgentInstance, args: string[]): AdapterInvocation;
}

/** Reads only the locally configured Kimi aliases; credentials from the raw JSON are discarded. */
export async function discoverKimiModels(owner: KimiModelDiscoveryRuntime, instance: AgentInstance, env?: Record<string, string | undefined>): Promise<ProviderModelCatalog> {
  const jsonInvocation = owner.invocation(instance, ["provider", "list", "--json"]);
  const jsonResult = await owner.capture(jsonInvocation.command, jsonInvocation.args, env);
  if (jsonResult.exitCode !== 0) throw new Error(jsonResult.text.trim() || `kimi provider list --json exited with ${jsonResult.exitCode ?? "unknown"}`);

  let defaultModel: string | undefined;
  try {
    const textInvocation = owner.invocation(instance, ["provider", "list"]);
    const textResult = await owner.capture(textInvocation.command, textInvocation.args, env);
    if (textResult.exitCode === 0) defaultModel = parseKimiDefaultModel(textResult.text);
  } catch {
    // The configured model aliases are still useful when the human-readable fallback changes.
  }
  return parseKimiModelList(jsonResult.text, defaultModel);
}

export function parseKimiModelList(text: string, defaultModel?: string): ProviderModelCatalog {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { throw new Error("Kimi 返回了无法解析的模型配置。" ); }
  const root = asRecord(parsed);
  const configuredDefault = stringValue(root.defaultModel) || stringValue(root.default_model) || defaultModel;
  const modelEntries = Object.entries(asRecord(root.models));
  const models = modelEntries.map(([alias, value]): ProviderModel => {
    const model = asRecord(value);
    return {
      id: alias,
      displayName: stringValue(model.displayName) || alias,
      isDefault: alias === configuredDefault,
      contextWindow: numberValue(model.maxContextSize),
      capabilities: stringArray(model.capabilities),
      reasoningEfforts: stringArray(model.supportEfforts),
      defaultReasoningEffort: stringValue(model.defaultEffort),
      serviceTiers: []
    };
  });
  return {
    providerId: "kimi-code",
    models,
    defaultModel: configuredDefault,
    source: "provider_cli",
    fetchedAt: new Date().toISOString()
  };
}

export function parseKimiDefaultModel(text: string): string | undefined {
  return /^Default model:\s*(\S+)\s*$/mi.exec(text)?.[1];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
