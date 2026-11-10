import type { AdapterEvent } from "@agenthub/provider-sdk";
type Usage = Extract<AdapterEvent, { kind: "usage" }>;

// Kept local so a copied plugin remains executable without host dependencies.
export class TurnUsage {
  private requests = new Map<string, Usage>();
  update(key: string, usage: Usage): Usage {
    this.requests.set(key, usage);
    const total: Usage = { kind: "usage", usageScope: "turn", inputTokensIncludesCache: false };
    for (const field of ["inputTokens", "outputTokens", "cachedInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens"] as const) {
      const values = [...this.requests.values()].map(value => value[field]);
      total[field] = values.every((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)
        ? values.reduce((a, b) => a + b, 0) : undefined;
    }
    return total;
  }
}
