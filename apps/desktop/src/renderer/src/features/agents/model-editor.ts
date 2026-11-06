import type { InstanceModelConfig, ModelPricing } from "@agenthub/domain";

export interface ModelRow {
  inputModalities?: Array<"text" | "image">;
  key: string;
  id: string;
  displayName: string;
  contextWindow: string;
  efforts: string;
  defaultReasoningEffort: string;
  enabled: boolean;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}
export const priceKeys = ["input", "output", "cacheRead", "cacheWrite"] as const;
export function modelRow(model: InstanceModelConfig, key: string): ModelRow {
  return { key, id: model.id, displayName: model.displayName ?? "", contextWindow: model.contextWindow ? String(model.contextWindow) : "",
    inputModalities: model.inputModalities ? [...model.inputModalities] : ["text"],
    efforts: model.reasoningEfforts.join(", "), defaultReasoningEffort: model.defaultReasoningEffort ?? model.reasoningEfforts[0] ?? "", enabled: model.enabled !== false,
    input: model.pricing?.input?.toString() ?? "", output: model.pricing?.output?.toString() ?? "", cacheRead: model.pricing?.cacheRead?.toString() ?? "", cacheWrite: model.pricing?.cacheWrite?.toString() ?? "" };
}
export function effortValues(value: string): string[] { return [...new Set(value.split(/[,，]/).map((item) => item.trim()).filter(Boolean))]; }
export function serializeModels(rows: ModelRow[]): InstanceModelConfig[] {
  const ids = new Set<string>();
  return rows.map((row) => {
    const id = row.id.trim();
    if (!id) throw new Error("模型 ID 不能为空 / Model ID is required");
    if (ids.has(id)) throw new Error(`模型 ID 重复 / Duplicate model ID: ${id}`);
    ids.add(id);
    const contextWindow = row.contextWindow.trim() ? Number(row.contextWindow) : undefined;
    if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)) throw new Error("上下文窗口必须为正整数 / Context window must be a positive integer");
    const reasoningEfforts = effortValues(row.efforts);
    const defaultReasoningEffort = row.defaultReasoningEffort.trim() || undefined;
    if (defaultReasoningEffort && !reasoningEfforts.includes(defaultReasoningEffort)) throw new Error("默认推理强度必须包含在选项中 / Default reasoning must be one of the configured values");
    const pricing: ModelPricing = {};
    for (const key of priceKeys) {
      if (!row[key].trim()) continue;
      const value = Number(row[key]);
      if (!Number.isFinite(value) || value < 0) throw new Error("价格必须是非负数字 / Prices must be non-negative numbers");
      pricing[key] = value;
    }
    return { id, displayName: row.displayName.trim() || undefined, enabled: row.enabled, contextWindow, inputModalities: row.inputModalities ? [...row.inputModalities] : undefined, reasoningEfforts, defaultReasoningEffort, pricing: Object.keys(pricing).length ? pricing : undefined };
  });
}
