/** Usage snapshots are not deltas. Old context-only journals are intentionally not guessed. */
export interface UsageSnapshot {
  usageScope?: "context" | "turn" | "session";
  usageKey?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  inputTokensIncludesCache?: boolean;
  reportedCost?: number;
  estimatedCost?: number;
  currency?: string;
  model?: string;
  agentInstanceId?: string;
  connectionId?: string;
  connectionRevision?: number;
  pricingSnapshot?: UsagePricing;
}
export interface UsageEvent {
  eventId: string;
  sequence: number;
  runId?: string;
  timestamp?: string;
  type: string;
  payload: unknown;
}
export interface UsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
  reportedCost?: number;
  estimatedCost?: number;
  snapshots: UsageSnapshot[];
  accountedTurns: number;
  unclassifiedEvents: number;
}
export const knownUsageNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const sumKnown = (values: Array<number | undefined>): number | undefined => {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length ? known.reduce((a, b) => a + b, 0) : undefined;
};
export function snapshotTotal(value: UsageSnapshot): number | undefined {
  const input = knownUsageNumber(value.inputTokens), output = knownUsageNumber(value.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  if (value.inputTokensIncludesCache === true) return input + output;
  if (value.inputTokensIncludesCache === false) {
    const read = knownUsageNumber(value.cachedInputTokens), write = knownUsageNumber(value.cacheCreationInputTokens);
    return read === undefined || write === undefined ? undefined : input + output + read + write;
  }
  // Unknown input semantics must not double count cache tokens.
  return undefined;
}
/** Native usage IDs are only unique inside a connection revision (or legacy Agent). */
export function usageSnapshotKey(value: UsageSnapshot, event: Pick<UsageEvent, "runId">): string | undefined {
  const nativeKey = value.usageKey ?? (value.usageScope === "turn" ? event.runId : undefined);
  if (!nativeKey) return undefined;
  return JSON.stringify([value.connectionId ?? null, value.connectionRevision ?? null, value.agentInstanceId ?? null, value.usageScope, nativeKey]);
}
export function aggregateSessionUsage(events: readonly UsageEvent[]): UsageTotals {
  const snapshots = new Map<string, UsageSnapshot>();
  const seen = new Set<string>();
  let unclassifiedEvents = 0;
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.type !== "usage.updated" || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    const value = event.payload as UsageSnapshot;
    if (!value || value.usageScope === "context") continue;
    if (value.usageScope !== "turn" && value.usageScope !== "session") { unclassifiedEvents++; continue; }
    const key = usageSnapshotKey(value, event);
    if (!key) { unclassifiedEvents++; continue; }
    snapshots.set(key, value);
  }
  const values = [...snapshots.values()];
  const field = (name: "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheCreationInputTokens") => sumKnown(values.map(v => knownUsageNumber(v[name])));
  // Only USD reports are added. Missing currency is not silently assumed USD.
  const cost = (name: "reportedCost" | "estimatedCost") => sumKnown(values.map(v => v.currency === "USD" ? knownUsageNumber(v[name]) : undefined));
  return { inputTokens: field("inputTokens"), outputTokens: field("outputTokens"), cachedInputTokens: field("cachedInputTokens"), cacheCreationInputTokens: field("cacheCreationInputTokens"), totalTokens: sumKnown(values.map(snapshotTotal)), reportedCost: cost("reportedCost"), estimatedCost: cost("estimatedCost"), snapshots: values, accountedTurns: values.length, unclassifiedEvents };
}
export interface UsagePricing { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
/** User-configured current-rate estimate, never a historical invoice or subscription charge. */
export function estimateSnapshot(value: UsageSnapshot, pricing: UsagePricing | undefined): number | undefined {
  // Session snapshots can span model changes. Without per-model counters their
  // latest model is not a trustworthy price attribution.
  if (!pricing || value.usageScope !== "turn" || value.inputTokensIncludesCache === undefined) return undefined;
  const input = knownUsageNumber(value.inputTokens), output = knownUsageNumber(value.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  const knownRead = knownUsageNumber(value.cachedInputTokens), knownWrite = knownUsageNumber(value.cacheCreationInputTokens);
  // Missing cache counters are unknown, not free. Inclusive protocols have no
  // separate write category; exclusive protocols must report both categories.
  if (value.inputTokensIncludesCache ? input > 0 && knownRead === undefined : knownRead === undefined || knownWrite === undefined) return undefined;
  const read = knownRead ?? 0, write = knownWrite ?? 0;
  const uncached = value.inputTokensIncludesCache ? input - read - write : input;
  if (uncached < 0) return undefined;
  let total = 0;
  for (const [count, rate] of [[uncached, pricing.input], [output, pricing.output], [read, pricing.cacheRead], [write, pricing.cacheWrite]]) {
    if (!count) continue;
    const validRate = knownUsageNumber(rate);
    if (validRate === undefined) return undefined;
    total += count * validRate / 1_000_000;
  }
  return total;
}
