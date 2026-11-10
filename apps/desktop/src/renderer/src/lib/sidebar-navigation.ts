import type { SessionTreeEntry } from "./session-tree";
import type { UiSession } from "./types";

/** Keep history links deterministic, including IDs containing URL delimiters. */
export function sessionLocation(session: Pick<UiSession, "id" | "mode">): string {
  return `/sessions?session=${encodeURIComponent(session.id)}`;
}

/** Searching is read-only and includes all conversations, not only this mode. */
export function searchSidebarSessions<T extends Pick<UiSession, "title" | "projectId" | "lastMessageAt" | "updatedAt">>(
  sessions: readonly T[],
  projects: readonly { id: string; name: string }[],
  query: string
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return sessions.filter((session) => !needle || `${session.title} ${names.get(session.projectId) ?? ""}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt));
}

/** Keep initial history bounded while always revealing the selected thread and its ancestry. */
export function visibleSidebarEntries(entries: readonly SessionTreeEntry[], limit: number, activeId?: string): SessionTreeEntry[] {
  const visible = new Set(entries.slice(0, limit));
  const activeIndex = entries.findIndex((entry) => entry.session.id === activeId);
  if (activeIndex >= limit) {
    visible.add(entries[activeIndex]);
    let depth = entries[activeIndex].depth;
    for (let index = activeIndex - 1; index >= 0 && depth > 0; index--) {
      if (entries[index].depth < depth) {
        visible.add(entries[index]);
        depth = entries[index].depth;
      }
    }
  }
  return entries.filter((entry) => visible.has(entry));
}

export const UNGROUPED_PROJECT = "__nautilo_ungrouped__";

/** Include empty projects; sessions with missing/removed projects remain discoverable. */
export function groupSidebarEntries(entries: readonly SessionTreeEntry[], projects: readonly { id: string; name: string }[]): Array<[string, SessionTreeEntry[]]> {
  const groups = new Map<string, SessionTreeEntry[]>(projects.map((project) => [project.id, []]));
  for (const entry of entries) {
    const id = groups.has(entry.session.projectId) ? entry.session.projectId : UNGROUPED_PROJECT;
    const group = groups.get(id) ?? [];
    group.push(entry);
    groups.set(id, group);
  }
  return [...groups];
}
