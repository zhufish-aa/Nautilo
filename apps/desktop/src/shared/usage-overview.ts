import type { UsageComponents, UsageOverviewPayload, UsageOverviewQuery, UsageRank, UsageSessionRow, UsageSourceRow } from "@agenthub/schemas";
import { buildUsageRecords, inUsageDateRange, sumUsageNumbers, usageDateRange, usageRecordMetrics } from "../renderer/src/lib/usage-analytics";
import { estimateSnapshot, knownUsageNumber, usageSnapshotKey, type UsageEvent, type UsageSnapshot } from "../renderer/src/lib/session-usage";
import { referenceRates } from "./usage-reference-prices";

interface MeasuredRun {
  model?: string;
  harness?: string;
  timestamp?: string;
  baseline: boolean;
  totalTokens?: number;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheInput?: number;
  cacheRead?: number;
  estimate?: number;
  reported?: number;
  source?: "configured" | "reference" | "estimated";
}

function measure(rows: UsageSourceRow[], now: Date): MeasuredRun[] {
  const byRun = new Map<string, UsageSourceRow>();
  const journal: UsageEvent[] = [];
  for (const row of rows) {
    if (!row.runId) continue;
    byRun.set(row.runId, row);
    journal.push({ eventId: row.runId, runId: row.runId, sequence: 0, type: "run.started", timestamp: row.timestamp ?? undefined, payload: {} });
    if (row.eventId && row.usage) {
      const payload = Object.fromEntries(Object.entries(row.usage).filter(([, value]) => value !== null));
      journal.push({ eventId: row.eventId, runId: row.runId, sequence: row.sequence ?? 0,
        type: "usage.updated", timestamp: row.timestamp ?? undefined, payload: { ...payload, model: row.runModel ?? undefined } });
    }
  }
  const baselines = new Set<string>();
  return buildUsageRecords(journal).map(record => {
    const row = byRun.get(record.id)!;
    const key = record.baseline && usageSnapshotKey(record.baseline, record);
    const firstBaseline = Boolean(key && !baselines.has(key));
    if (key) baselines.add(key);
    const value = record.usage;
    const metrics = usageRecordMetrics(record, firstBaseline);
    const manual = value && (estimateSnapshot(value, value.pricingSnapshot) ?? estimateSnapshot(value, row.customPricing ?? undefined));
    const reported = value?.currency === "USD" ? knownUsageNumber(value.reportedCost) : undefined;
    const estimated = value?.currency === "USD" ? knownUsageNumber(value.estimatedCost) : undefined;
    const reference = value && estimateSnapshot(value, referenceRates(record.model, now));
    const estimate = manual ?? estimated ?? reference;
    const split = metrics.totalTokens !== undefined && metrics.cacheInputTokens !== undefined && metrics.cachedInputTokens !== undefined
      && metrics.outputTokens !== undefined && metrics.cacheInputTokens + metrics.outputTokens === metrics.totalTokens;
    return {
      model: record.model, harness: row.runHarness ?? row.harness ?? undefined, timestamp: record.timestamp, baseline: Boolean(record.baseline),
      totalTokens: metrics.totalTokens, inputTokens: split ? metrics.cacheInputTokens! - metrics.cachedInputTokens! : undefined,
      cachedTokens: split ? metrics.cachedInputTokens : undefined, outputTokens: split ? metrics.outputTokens : undefined,
      cacheWriteTokens: metrics.cacheWriteTokens, cacheInput: split ? metrics.cacheInputTokens : undefined,
      cacheRead: split ? metrics.cachedInputTokens : undefined,
      estimate, reported, source: manual !== undefined ? "configured" : estimated !== undefined ? "estimated" : reference !== undefined ? "reference" : undefined,
    };
  });
}

function summarize(runs: MeasuredRun[]): UsageComponents {
  const sum = (field: "totalTokens" | "inputTokens" | "cachedTokens" | "outputTokens" | "cacheWriteTokens" | "cacheInput" | "cacheRead" | "estimate") =>
    sumUsageNumbers(runs.map(run => run[field]));
  const inputTokens = sum("inputTokens"), cachedTokens = sum("cachedTokens"), outputTokens = sum("outputTokens");
  const cacheInput = sum("cacheInput"), cacheRead = sum("cacheRead");
  return {
    totalTokens: sum("totalTokens"), inputTokens, cachedTokens, outputTokens, cacheWriteTokens: sum("cacheWriteTokens"),
    breakdownTokens: (inputTokens ?? 0) + (cachedTokens ?? 0) + (outputTokens ?? 0),
    cacheHitRate: cacheInput && cacheRead !== undefined ? cacheRead / cacheInput * 100 : undefined,
    estimatedCostUsd: sum("estimate"),
  };
}

export function buildUsageOverview(source: UsageSourceRow[], filters: UsageOverviewQuery, now = new Date()): UsageOverviewPayload {
  const period = filters.period ?? "all";
  const range = period === "24h" ? { start: now.getTime() - 24 * 3600_000, end: now.getTime() + 1 }
    : usageDateRange(period, now) ?? {};
  const search = filters.query?.trim().toLowerCase() ?? "";
  const bySession = new Map<string, UsageSourceRow[]>();
  const harnesses = new Set<string>();
  for (const item of source) {
    const list = bySession.get(item.sessionId);
    if (list) list.push(item); else bySession.set(item.sessionId, [item]);
    if (item.harness) harnesses.add(item.harness);
    if (item.runHarness) harnesses.add(item.runHarness);
  }
  const rows: UsageSessionRow[] = [];
  const contributions: Array<{ row: UsageSessionRow; run: MeasuredRun }> = [];
  const unpriced = new Set<string>();
  for (const list of bySession.values()) {
    const { sessionId, title, projectId, projectName, harness, currentModel, updatedAt, parentSessionId, instanceName } = list[0];
    if (parentSessionId && filters.includeChildren === false) continue;
    const sessionMatches = !search || [title, projectName, instanceName, harness, currentModel].some(value => value?.toLowerCase().includes(search));
    const runs = measure(list, now).filter(run => (!filters.harness || filters.harness === run.harness)
      && inUsageDateRange(run.timestamp, range) && (sessionMatches || Boolean(run.model?.toLowerCase().includes(search))));
    if (!runs.length && ((list[0].runId && period !== "all") || !sessionMatches
      || (filters.harness && harness !== filters.harness) || !inUsageDateRange(updatedAt, range))) continue;
    const measured = period === "all" ? runs : runs.map(run => run.baseline ? { ...run, totalTokens: undefined,
      inputTokens: undefined, cachedTokens: undefined, outputTokens: undefined, cacheInput: undefined, cacheRead: undefined, cacheWriteTokens: undefined } : run);
    const totals = summarize(measured);
    const reported = sumUsageNumbers(measured.map(run => run.reported));
    const estimates = new Set(measured.flatMap(run => run.source ? [run.source] : []));
    const row: UsageSessionRow = { sessionId, title, projectId, projectName, harness, currentModel, updatedAt, ...totals,
      models: [...new Set(runs.map(run => run.model ?? ""))],
      harnesses: [...new Set(runs.map(run => run.harness ?? ""))],
      costUsd: reported ?? totals.estimatedCostUsd,
      costSource: reported !== undefined ? "reported" : estimates.size > 1 ? "mixed" : [...estimates][0],
    };
    rows.push(row);
    for (const run of measured) {
      contributions.push({ row, run });
      if (run.model && run.totalTokens !== undefined && run.estimate === undefined && run.reported === undefined) unpriced.add(run.model);
    }
  }

  const measured = contributions.map(({ run }) => run);
  const totals = summarize(measured);
  const periodHourly = period === "24h";
  const floor = (time: number) => {
    const date = new Date(time);
    if (periodHourly) date.setTime(time - date.getMinutes() * 60_000 - date.getSeconds() * 1000 - date.getMilliseconds());
    else date.setHours(0, 0, 0, 0);
    return date;
  };
  const dated = new Map<number, typeof contributions>();
  for (const item of contributions) {
    const { run } = item;
    if (run.baseline || (run.totalTokens === undefined && run.estimate === undefined) || !run.timestamp) continue;
    const time = Date.parse(run.timestamp);
    if (!Number.isFinite(time)) continue;
    const key = floor(time).getTime();
    const group = dated.get(key);
    if (group) group.push(item); else dated.set(key, [item]);
  }
  const times = [...dated.keys()].sort((a, b) => a - b);
  const trendSeries = [];
  if (times.length) {
    const label = new Intl.DateTimeFormat("en-US", periodHourly ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : { month: "numeric", day: "numeric" });
    const cursor = floor(range.start ?? times[0]);
    const end = range.end ?? times[times.length - 1] + 1;
    while (cursor.getTime() < end) {
      const group = dated.get(cursor.getTime()) ?? [];
      trendSeries.push({ bucketKey: cursor.toISOString(), label: label.format(cursor), ...summarize(group.map(({ run }) => run)),
        sessionsCount: new Set(group.map(({ row }) => row.sessionId)).size });
      if (periodHourly) cursor.setTime(cursor.getTime() + 3600_000);
      else cursor.setDate(cursor.getDate() + 1);
    }
  }

  const rank = (dimension: "model" | "harness" | "project"): UsageRank[] => {
    const groups = new Map<string, typeof contributions>();
    for (const item of contributions) {
      if (item.run.totalTokens === undefined) continue;
      const id = dimension === "project" ? item.row.projectId : item.run[dimension] ?? "";
      const group = groups.get(id);
      if (group) group.push(item); else groups.set(id, [item]);
    }
    return [...groups].map(([id, group]) => {
      const totalTokens = group.reduce((sum, item) => sum + (item.run.totalTokens ?? 0), 0);
      const modelHarnesses = dimension === "model" ? new Set(group.map(({ run }) => run.harness)) : undefined;
      return {
        id, name: dimension === "project" ? group[0].row.projectName : id || null,
        harness: modelHarnesses?.size === 1 ? group[0].run.harness : undefined, totalTokens,
        sharePercent: totals.totalTokens ? totalTokens / totals.totalTokens * 100 : 0,
        sessionsCount: new Set(group.map(({ row }) => row.sessionId)).size,
        estimatedCostUsd: sumUsageNumbers(group.map(({ run }) => run.estimate)),
      };
    }).sort((a, b) => b.totalTokens - a.totalTokens);
  };

  return {
    summary: { ...totals, hasBreakdown: totals.inputTokens !== undefined,
      recordedSessions: rows.filter(row => row.totalTokens !== undefined).length, totalSessions: rows.length,
      pricedSessions: rows.filter(row => row.totalTokens !== undefined && row.estimatedCostUsd !== undefined).length,
      totalRequests: contributions.length,
    },
    rows, trendSeries, unpricedModels: unpriced.size, harnesses: [...harnesses].sort(),
    breakdowns: { byModel: rank("model"), byHarness: rank("harness"), byProject: rank("project") },
  };
}
