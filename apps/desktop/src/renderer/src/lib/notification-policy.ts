/**
 * Pure notification-trigger policy, kept dependency-free so the desktop test
 * suite can transpile and exercise it directly (see test/notifications.test.mjs).
 */

export interface LifecycleLike {
  status: string;
}

/** Active → terminal transition of one session's foreground lifecycle. */
export function terminalTransition(
  previous: LifecycleLike | undefined,
  next: LifecycleLike | undefined
): "completed" | "failed" | "cancelled" | undefined {
  const wasActive = previous?.status === "running" || previous?.status === "waiting_approval";
  if (!wasActive || !next) return undefined;
  return next.status === "completed" || next.status === "failed" || next.status === "cancelled"
    ? next.status
    : undefined;
}

/** Only nudge when the user is not already looking at this exact session. */
export function shouldNotify(sessionId: string, activeSessionId: string | undefined, documentHidden: boolean): boolean {
  return documentHidden || sessionId !== activeSessionId;
}

/** Pending interaction counts per session (approvals, questions, plan approvals). */
export function pendingCountsBySession(
  bySession: Record<string, Array<{ status: string }> | undefined>
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [sessionId, list] of Object.entries(bySession)) {
    const pending = (list ?? []).filter((item) => item.status === "pending").length;
    if (pending > 0) counts[sessionId] = pending;
  }
  return counts;
}
