/**
 * Runs dashboard ("并行驾驶舱") grouping logic, kept dependency-free so the
 * desktop test suite can transpile and exercise it directly.
 */

export interface DashboardSessionLike {
  id: string;
  title: string;
  unreadCount: number;
  updatedAt: string;
  lastMessageAt?: string;
}

export interface DashboardLifecycleLike {
  status: string;
}

export interface DashboardGroups<TSession extends DashboardSessionLike = DashboardSessionLike> {
  /** Sessions with a pending approval/question waiting on the user. */
  waiting: TSession[];
  /** Sessions with an active foreground/background run. */
  running: TSession[];
  /** Finished sessions with unread activity. */
  unread: TSession[];
}

const ACTIVE = new Set(["running", "waiting_approval"]);

export function groupSessionsForDashboard<TSession extends DashboardSessionLike>(input: {
  sessions: TSession[];
  foreground: Record<string, DashboardLifecycleLike | undefined>;
  running: Record<string, DashboardLifecycleLike | undefined>;
  /** Pending interaction counts per session (see pendingCountsBySession). */
  pending: Record<string, number>;
}): DashboardGroups<TSession> {
  const waiting: TSession[] = [];
  const running: TSession[] = [];
  const unread: TSession[] = [];
  for (const session of input.sessions) {
    const active = ACTIVE.has(input.foreground[session.id]?.status ?? "") || ACTIVE.has(input.running[session.id]?.status ?? "");
    if ((input.pending[session.id] ?? 0) > 0) {
      waiting.push(session);
      continue;
    }
    if (active) {
      running.push(session);
      continue;
    }
    if (session.unreadCount > 0) unread.push(session);
  }
  const recentFirst = (left: TSession, right: TSession): number =>
    (right.lastMessageAt ?? right.updatedAt).localeCompare(left.lastMessageAt ?? left.updatedAt);
  return {
    waiting: waiting.sort(recentFirst),
    running: running.sort(recentFirst),
    unread: unread.sort(recentFirst)
  };
}
