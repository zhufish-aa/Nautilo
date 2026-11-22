export interface UsageOverviewQuery {
  view: "usage";
  sessionId?: string;
  projectId?: string;
  period?: "24h" | "7d" | "30d" | "all";
  query?: string;
  harness?: string;
  includeChildren?: boolean;
}

export interface UsageRates {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface UsageSourceRow {
  sessionId: string;
  title: string | null;
  projectId: string;
  projectName: string | null;
  updatedAt: string;
  parentSessionId: string | null;
  harness: string | null;
  instanceName: string | null;
  currentModel: string | null;
  runId: string | null;
  runHarness: string | null;
  timestamp: string | null;
  runModel: string | null;
  eventId: string | null;
  sequence: number | null;
  usage: unknown;
  customPricing: UsageRates | null;
}

export interface UsageComponents {
  totalTokens?: number;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  breakdownTokens: number;
  cacheHitRate?: number;
  estimatedCostUsd?: number;
}

export interface UsageSessionRow extends UsageComponents {
  sessionId: string;
  title: string | null;
  projectId: string;
  projectName: string | null;
  harness: string | null;
  currentModel: string | null;
  updatedAt: string;
  models: string[];
  harnesses: string[];
  costUsd?: number;
  costSource?: "reported" | "configured" | "reference" | "estimated" | "mixed";
}

export interface UsageTrendBucket extends UsageComponents {
  bucketKey: string;
  label: string;
  sessionsCount: number;
}

export interface UsageRank {
  id: string;
  name: string | null;
  harness?: string;
  totalTokens: number;
  sharePercent: number;
  sessionsCount: number;
  estimatedCostUsd?: number;
}

export interface UsageOverviewPayload {
  summary: UsageComponents & {
    hasBreakdown: boolean;
    recordedSessions: number;
    totalSessions: number;
    totalRequests: number;
    pricedSessions: number;
  };
  trendSeries: UsageTrendBucket[];
  breakdowns: { byModel: UsageRank[]; byHarness: UsageRank[]; byProject: UsageRank[] };
  rows: UsageSessionRow[];
  harnesses: string[];
  unpricedModels: number;
}
