import {
  estimateSnapshot,
  knownUsageNumber,
  snapshotTotal,
  usageSnapshotKey,
  type UsageEvent,
  type UsageSnapshot,
} from "./session-usage";

export type UsageStatus = "running" | "completed" | "failed" | "waiting" | "unknown";
export type UsagePeriod = "today" | "yesterday" | "7d" | "30d" | "all" | "custom";
export type UsageMetric = "requests" | "tokens" | "cost";

export interface UsageRecord {
  id: string;
  runId?: string;
  timestamp?: string;
  status: UsageStatus;
  model?: string;
  agentInstanceId?: string;
  connectionId?: string;
  connectionRevision?: number;
  /** Only usage attributable to this execution. */
  usage?: UsageSnapshot;
  /** The first native-thread counter may include history outside Nautilo. */
  baseline?: UsageSnapshot;
  durationMs?: number;
  firstResponseMs?: number;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const timestamp = (value: string | undefined): number | undefined => {
  const result = value ? Date.parse(value) : NaN;
  return Number.isFinite(result) ? result : undefined;
};

/** Retain accounting and lifecycle metadata, never conversation/tool contents.
 * Session counters are retained per run so date filters can use real deltas.
 * Replays may arrive after live updates; sequence comparisons work both ways.
 */
export function retainUsageEvents(log: Map<string, UsageEvent>, events: readonly UsageEvent[]): boolean {
  let changed = false;
  for (const event of events) {
    const payload = object(event.payload);
    let key: string;
    let earliest = false;
    let safePayload: unknown = {};
    if (event.type === "usage.updated") {
      if (payload.usageScope === "context") continue;
      const value = payload as UsageSnapshot;
      key = JSON.stringify(["usage", usageSnapshotKey(value, event) ?? "legacy", event.runId ?? null]);
      safePayload = Object.fromEntries([
        "usageScope", "usageKey", "inputTokens", "outputTokens", "cachedInputTokens",
        "cacheCreationInputTokens", "reasoningOutputTokens", "inputTokensIncludesCache",
        "reportedCost", "estimatedCost", "currency", "model", "agentInstanceId",
        "connectionId", "connectionRevision", "pricingSnapshot",
      ].filter(name => payload[name] !== undefined).map(name => [name, payload[name]]));
    } else {
      if (!event.runId) continue;
      if (event.type === "run.started") {
        key = JSON.stringify([event.runId, "start"]);
        earliest = true;
      } else if (event.type === "agent.status" && payload.phase === "turn_started") {
        key = JSON.stringify([event.runId, "provider-start"]);
        earliest = true;
        safePayload = { phase: "turn_started" };
      } else if (event.type === "agent.message_delta" && typeof payload.text === "string" && payload.text.length > 0 && !payload.subagentDispatchId) {
        key = JSON.stringify([event.runId, "first-response"]);
        earliest = true;
      } else if (["run.completed", "run.failed", "run.waiting"].includes(event.type)) {
        key = JSON.stringify([event.runId, "status"]);
      } else continue;
    }
    const previous = log.get(key);
    if (previous && (earliest ? previous.sequence <= event.sequence : previous.sequence >= event.sequence)) continue;
    log.set(key, {
      eventId: event.eventId, sequence: event.sequence, runId: event.runId,
      timestamp: event.timestamp, type: event.type, payload: safePayload,
    });
    changed = true;
  }
  return changed;
}

const counterNames = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens", "reportedCost", "estimatedCost"] as const;

function sessionDelta(current: UsageSnapshot, previous: UsageSnapshot): UsageSnapshot | undefined {
  if (current.inputTokensIncludesCache !== previous.inputTokensIncludesCache || current.currency !== previous.currency) return undefined;
  // A counter reset creates a new baseline, never negative throughput.
  if (counterNames.some(name => {
    const a = knownUsageNumber(current[name]), b = knownUsageNumber(previous[name]);
    return a !== undefined && b !== undefined && a < b;
  })) return undefined;
  const result: UsageSnapshot = { ...current, usageScope: "turn" };
  for (const name of counterNames) {
    const a = knownUsageNumber(current[name]), b = knownUsageNumber(previous[name]);
    result[name] = a !== undefined && b !== undefined ? a - b : undefined;
  }
  return result;
}

export function buildUsageRecords(events: readonly UsageEvent[]): UsageRecord[] {
  const runs = new Map<string, { events: UsageEvent[]; usage?: UsageEvent }>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const value = object(event.payload) as UsageSnapshot;
    const id = event.runId ?? (event.type === "usage.updated" ? usageSnapshotKey(value, event) ?? event.eventId : undefined);
    if (!id) continue;
    const run = runs.get(id) ?? { events: [] };
    run.events.push(event);
    if (event.type === "usage.updated" && value.usageScope !== "context") {
      // An explicit turn snapshot is preferable if a provider also emits a session counter.
      if (!run.usage || value.usageScope === "turn" || (run.usage.payload as UsageSnapshot).usageScope !== "turn") run.usage = event;
    }
    runs.set(id, run);
  }
  const previous = new Map<string, UsageSnapshot>();
  // Counter order comes from journal sequence, never wall-clock strings or mutable session dates.
  const ordered = [...runs.entries()].sort((a, b) => (a[1].usage?.sequence ?? a[1].events[0].sequence) - (b[1].usage?.sequence ?? b[1].events[0].sequence));
  return ordered.map(([id, run]) => {
    const value = run.usage?.payload as UsageSnapshot | undefined;
    let usage: UsageSnapshot | undefined;
    let baseline: UsageSnapshot | undefined;
    if (value?.usageScope === "turn" && usageSnapshotKey(value, run.usage!)) usage = value;
    if (value?.usageScope === "session") {
      const key = usageSnapshotKey(value, run.usage!);
      if (key) {
        const prior = previous.get(key);
        usage = prior ? sessionDelta(value, prior) : undefined;
        if (!usage) baseline = value;
        previous.set(key, value);
      }
    }
    const started = run.events.find(event => event.type === "run.started");
    const providerStarted = run.events.find(event => event.type === "agent.status");
    const response = run.events.find(event => event.type === "agent.message_delta");
    const state = [...run.events].reverse().find(event => ["run.completed", "run.failed", "run.waiting"].includes(event.type));
    const startMs = timestamp(providerStarted?.timestamp ?? started?.timestamp);
    const endMs = state && state.type !== "run.waiting" ? timestamp(state.timestamp) : undefined;
    const responseMs = timestamp(response?.timestamp);
    return {
      id, runId: run.usage?.runId ?? started?.runId ?? run.events[0].runId,
      timestamp: run.usage?.timestamp ?? state?.timestamp ?? started?.timestamp,
      status: state?.type === "run.completed" ? "completed" : state?.type === "run.failed" ? "failed" : state?.type === "run.waiting" ? "waiting" : started ? "running" : "unknown",
      // A cumulative baseline may span model changes; it has no reliable model attribution.
      model: baseline ? undefined : value?.model,
      agentInstanceId: value?.agentInstanceId,
      connectionId: value?.connectionId,
      connectionRevision: value?.connectionRevision,
      usage, baseline,
      durationMs: startMs !== undefined && endMs !== undefined && endMs >= startMs ? endMs - startMs : undefined,
      firstResponseMs: startMs !== undefined && responseMs !== undefined && responseMs >= startMs && (endMs === undefined || responseMs <= endMs) ? responseMs - startMs : undefined,
    } satisfies UsageRecord;
  });
}

export interface UsageRecordMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
  costSource?: "reported" | "estimated";
  cacheInputTokens?: number;
  tokensPerSecond?: number;
}

/** All-time can show an unallocated baseline; date ranges cannot claim it. */
export function usageRecordMetrics(record: UsageRecord, includeBaseline = false): UsageRecordMetrics {
  const value = record.usage ?? (includeBaseline ? record.baseline : undefined);
  if (!value) return {};
  const input = knownUsageNumber(value.inputTokens), read = knownUsageNumber(value.cachedInputTokens);
  const write = knownUsageNumber(value.cacheCreationInputTokens);
  const output = knownUsageNumber(value.outputTokens);
  const fresh = value.inputTokensIncludesCache === false ? input
    : value.inputTokensIncludesCache === true && input !== undefined && read !== undefined && input >= read + (write ?? 0) ? input - read - (write ?? 0) : undefined;
  const denominator = fresh !== undefined && read !== undefined && (value.inputTokensIncludesCache === true || write !== undefined) ? fresh + read + (write ?? 0) : undefined;
  const reported = value.currency === "USD" ? knownUsageNumber(value.reportedCost) : undefined;
  const estimate = value.currency === "USD" ? knownUsageNumber(value.estimatedCost) : undefined;
  const calculated = estimateSnapshot(value, value.pricingSnapshot);
  const cost = reported ?? estimate ?? calculated;
  return {
    inputTokens: fresh, outputTokens: output, cachedInputTokens: read, cacheWriteTokens: write,
    totalTokens: snapshotTotal(value), cost,
    costSource: cost === undefined ? undefined : reported !== undefined ? "reported" : "estimated",
    cacheInputTokens: denominator,
    tokensPerSecond: record.usage && record.status === "completed" && record.durationMs && output !== undefined ? output / (record.durationMs / 1000) : undefined,
  };
}

export function sumUsageNumbers(values: readonly (number | undefined)[]): number | undefined {
  const known = values.filter((value): value is number => knownUsageNumber(value) !== undefined);
  return known.length ? known.reduce((total, value) => total + value, 0) : undefined;
}

export function summarizeUsage(metrics: readonly UsageRecordMetrics[]) {
  const cacheKnown = metrics.filter(row => row.cacheInputTokens !== undefined && row.cachedInputTokens !== undefined);
  const cacheInput = sumUsageNumbers(cacheKnown.map(row => row.cacheInputTokens));
  const cacheRead = sumUsageNumbers(cacheKnown.map(row => row.cachedInputTokens));
  const sum = (field: keyof UsageRecordMetrics) => sumUsageNumbers(metrics.map(row => typeof row[field] === "number" ? row[field] as number : undefined));
  return {
    requests: metrics.length, cost: metrics.length ? sum("cost") : 0,
    totalTokens: metrics.length ? sum("totalTokens") : 0,
    inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cachedInputTokens: sum("cachedInputTokens"),
    cacheHitRate: cacheInput !== undefined && cacheInput > 0 && cacheRead !== undefined ? cacheRead / cacheInput : undefined,
    pricedRecords: metrics.filter(row => row.cost !== undefined).length,
    tokenRecords: metrics.filter(row => row.totalTokens !== undefined).length,
    cacheRecords: cacheKnown.length,
  };
}

export interface UsageDateRange { start?: number; end?: number }
export function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
const localDate = (value: string): Date | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return localDateKey(date) === value ? date : undefined;
};
export function usageDateRange(period: UsagePeriod, now: Date, from?: string, to?: string): UsageDateRange | undefined {
  if (period === "all") return {};
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  if (period === "custom") {
    const a = localDate(from ?? ""), b = localDate(to ?? "");
    if (!a || !b || b < a) return undefined;
    b.setDate(b.getDate() + 1);
    return { start: a.getTime(), end: b.getTime() };
  }
  if (period === "yesterday") { end.setDate(end.getDate() - 1); start.setDate(start.getDate() - 1); }
  if (period === "7d") start.setDate(start.getDate() - 6);
  if (period === "30d") start.setDate(start.getDate() - 29);
  return { start: start.getTime(), end: end.getTime() };
}
export function inUsageDateRange(value: string | undefined, range: UsageDateRange): boolean {
  if (range.start === undefined && range.end === undefined) return true;
  const time = timestamp(value);
  return time !== undefined && (range.start === undefined || time >= range.start) && (range.end === undefined || time < range.end);
}

export interface UsageChartBucket {
  key: string;
  start: number;
  end: number;
  requests: number;
  tokens?: number;
  cost?: number;
}
export function usageChartBuckets(rows: readonly { record: UsageRecord; metrics: UsageRecordMetrics }[], range: UsageDateRange, now: Date): { granularity: "hour" | "day" | "month"; buckets: UsageChartBucket[] } {
  const times = rows.map(row => timestamp(row.record.timestamp)).filter((value): value is number => value !== undefined);
  const lower = range.start ?? (times.length ? times.reduce((a, b) => Math.min(a, b)) : now.getTime());
  const upper = range.end ?? (times.length ? times.reduce((a, b) => Math.max(a, b)) + 1 : now.getTime() + 1);
  const granularity = upper - lower <= 25 * 3600_000 ? "hour" : upper - lower <= 62 * 86400_000 ? "day" : "month";
  const cursor = new Date(lower);
  cursor.setMinutes(0, 0, 0);
  if (granularity !== "hour") cursor.setHours(0);
  if (granularity === "month") cursor.setDate(1);
  const buckets: UsageChartBucket[] = [];
  while (cursor.getTime() < upper && buckets.length < 2400) {
    const start = cursor.getTime();
    if (granularity === "hour") cursor.setTime(start + 3600_000);
    else if (granularity === "day") cursor.setDate(cursor.getDate() + 1);
    else cursor.setMonth(cursor.getMonth() + 1);
    buckets.push({ key: String(start), start, end: cursor.getTime(), requests: 0, tokens: 0, cost: 0 });
  }
  // Sorted intervals let a single traversal allocate all rows, including local DST days.
  const sorted = rows.flatMap(row => {
    const time = timestamp(row.record.timestamp);
    return time === undefined ? [] : [{ ...row, time }];
  }).sort((a, b) => a.time - b.time);
  let index = 0;
  for (const row of sorted) {
    while (index < buckets.length && buckets[index].end <= row.time) index++;
    const bucket = buckets[index];
    if (!bucket || row.time < bucket.start || row.time < lower || row.time >= upper) continue;
    bucket.requests++;
    // Unallocated lifetime baselines never become a spike in the date chart.
    const measured = usageRecordMetrics(row.record);
    bucket.tokens = sumUsageNumbers([bucket.requests === 1 ? undefined : bucket.tokens, measured.totalTokens]);
    bucket.cost = sumUsageNumbers([bucket.requests === 1 ? undefined : bucket.cost, measured.cost]);
  }
  return { granularity, buckets };
}
