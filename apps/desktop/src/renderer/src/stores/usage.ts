import { create } from "zustand";
import { requestCore } from "../lib/bridge";
import { aggregateSessionUsage, usageSnapshotKey, type UsageEvent, type UsageTotals, type UsageSnapshot } from "../lib/session-usage";

// Keep only usage events, never another copy of conversations / raw tool output.
const logs = new Map<string, Map<string, UsageEvent>>();
const subscriptions = new Map<string, { id: string; cursor: number }>();
const pending = new Map<string, Promise<void>>();
interface UsageState {
  summaries: Record<string, UsageTotals | undefined>;
  loading: Record<string, boolean>;
  errors: Record<string, string | undefined>;
  refreshedAt: Record<string, string | undefined>;
  ingest: (sessionId: string, events: readonly UsageEvent[]) => void;
  refresh: (sessionId: string) => Promise<void>;
}
export const useUsageStore = create<UsageState>((set, get) => ({
  summaries: {}, loading: {}, errors: {}, refreshedAt: {},
  ingest: (sessionId, events) => {
    const usage = events.filter(event => event.type === "usage.updated");
    if (!usage.length) return;
    const log = logs.get(sessionId) ?? new Map<string, UsageEvent>();
    let changed = false;
    for (const event of usage) {
      const value = event.payload as UsageSnapshot;
      if (value.usageScope === "context") continue;
      // Retain only the latest accounting snapshot, not every streaming update.
      const key = usageSnapshotKey(value, event) ?? JSON.stringify(["legacy", value.agentInstanceId ?? null, event.runId ?? "unknown"]);
      const previous = log.get(key);
      if (!previous || event.sequence > previous.sequence) { log.set(key, event); changed = true; }
    }
    if (!changed) return;
    logs.set(sessionId, log);
    const summary = aggregateSessionUsage([...log.values()]);
    set(state => ({ summaries: { ...state.summaries, [sessionId]: summary } }));
  },
  refresh: (sessionId) => {
    const running = pending.get(sessionId);
    if (running) return running;
    const task = (async () => {
      set(state => ({ loading: { ...state.loading, [sessionId]: true }, errors: { ...state.errors, [sessionId]: undefined } }));
      try {
        let sub = subscriptions.get(sessionId);
        if (!sub) {
          const result = await requestCore<{ subscriptionId: string }>("event.subscribe", { sessionId });
          sub = { id: result.subscriptionId, cursor: 0 };
          subscriptions.set(sessionId, sub);
        }
        const result = await requestCore<{ events: UsageEvent[]; lastSequence: number }>("event.replay", { subscriptionId: sub.id, afterSequence: sub.cursor });
        get().ingest(sessionId, result.events);
        sub.cursor = result.lastSequence;
        set(state => ({ summaries: { ...state.summaries, [sessionId]: state.summaries[sessionId] ?? aggregateSessionUsage([]) }, refreshedAt: { ...state.refreshedAt, [sessionId]: new Date().toISOString() } }));
      } catch (error) {
        subscriptions.delete(sessionId); // next refresh can recover from a daemon restart
        set(state => ({ errors: { ...state.errors, [sessionId]: error instanceof Error ? error.message : String(error) } }));
      } finally {
        set(state => ({ loading: { ...state.loading, [sessionId]: false } }));
      }
    })();
    pending.set(sessionId, task);
    void task.finally(() => pending.delete(sessionId));
    return task;
  }
}));
