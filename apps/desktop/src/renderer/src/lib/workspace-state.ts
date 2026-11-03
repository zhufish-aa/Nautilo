/** URL selection is independent of historical session mode. No data migration is needed. */
export function resolveWorkspaceSession<T extends { id: string }>(sessions: readonly T[], search: string, activeId?: string): T | undefined {
  const query = new URLSearchParams(search);
  if (query.get("new") === "1") return undefined;
  return sessions.find((session) => session.id === (query.get("session") ?? activeId));
}

export function constrainWorkspacePreview(width: number, available: number): number {
  // Narrow layouts overlay the conversation; desktop keeps at least 340px for it.
  const maximum = available <= 700 ? available : available - 340;
  return Math.max(0, Math.min(Math.max(300, width), maximum));
}

export function requestedWorkspaceFile(request: { sessionId: string; path: string } | undefined, sessionId?: string): string | undefined {
  return request?.sessionId === sessionId ? request?.path : undefined;
}
