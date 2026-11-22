import { useEffect, useState } from "react";
import type { AccountQuota, IpcRequestMap } from "@agenthub/schemas";
import { requestCore } from "@/lib/bridge";

type QuotaLookup = IpcRequestMap["connection.quota"]["input"];
type QuotaState = { quota?: AccountQuota; status: "loading" | "ready" | "failed" | "unavailable" };
const reads = new Map<string, { expires: number; request: Promise<AccountQuota> }>();
const nativeSnapshots = new Map<string, AccountQuota>();
let queue = Promise.resolve();

function lastQuota(key: string, account: boolean): AccountQuota | undefined {
  if (!account) return nativeSnapshots.get(key);
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as AccountQuota | null;
    return Array.isArray(value?.windows) && value.windows.length ? value : undefined;
  } catch { return undefined; }
}

function readQuota(key: string, lookup: QuotaLookup, force: boolean, unpinned: boolean): Promise<AccountQuota> {
  const existing = reads.get(key);
  if (existing && (existing.expires === Infinity || !force && existing.expires > Date.now())) return existing.request;
  const read = { expires: Infinity, request: queue.then(() => requestCore<AccountQuota>("connection.quota", lookup)) };
  reads.set(key, read);
  queue = read.request.then(quota => {
    // Native CLI sign-in can change independently of Nautilo. Fetch it again
    // on mount and keep its balance out of persisted or stale snapshots.
    if (unpinned) { reads.delete(key); return; }
    read.expires = Date.now() + 120_000;
    if (!quota.windows.length) return;
    if ("connectionId" in lookup) {
      try { localStorage.setItem(key, JSON.stringify(quota)); } catch { /* Storage can be unavailable in the current window. */ }
    } else nativeSnapshots.set(key, quota);
  }, () => { reads.delete(key); });
  return read.request;
}

export function useAccountQuota(lookup: QuotaLookup, enabled = true, verifiedAt?: string, unpinned = false): QuotaState & { refresh: () => void } {
  const connectionId = "connectionId" in lookup ? lookup.connectionId : undefined;
  const revision = "revision" in lookup ? lookup.revision : undefined;
  const sessionId = "sessionId" in lookup ? lookup.sessionId : undefined;
  const agentInstanceId = "agentInstanceId" in lookup ? lookup.agentInstanceId : undefined;
  const key = connectionId ? `nautilo.account-quota:${connectionId}:${revision}`
    : agentInstanceId ? `quota-harness:${agentInstanceId}` : `session:${sessionId}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<QuotaState>(() => ({ quota: enabled && !unpinned ? lastQuota(key, !!connectionId) : undefined, status: enabled ? "loading" : "unavailable" }));
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setState(current => ({ quota: unpinned ? undefined : lastQuota(key, !!connectionId) ?? current.quota, status: "loading" }));
    const request = sessionId ? { sessionId } : agentInstanceId ? { agentInstanceId } : { connectionId: connectionId!, revision };
    void readQuota(key, request, attempt > 0 || verifiedAt !== undefined, unpinned).then(quota => {
      if (active) setState(current => quota.windows.length ? { quota, status: "ready" }
        : { quota: unpinned ? quota : current.quota, status: "unavailable" });
    }, () => {
      if (active) setState(current => ({ ...current, status: "failed" }));
    });
    return () => { active = false; };
  }, [key, connectionId, revision, sessionId, agentInstanceId, enabled, attempt, verifiedAt, unpinned]);
  return { ...(enabled ? state : { status: "unavailable" as const }), refresh: () => setAttempt(value => value + 1) };
}
