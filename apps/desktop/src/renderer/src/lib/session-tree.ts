import type { UiSession } from "./types";

export interface SessionTreeEntry {
  session: UiSession;
  depth: number;
  hasChildren: boolean;
}

interface SessionTreeNode {
  session: UiSession;
  children: SessionTreeNode[];
  originalIndex: number;
  ownActivity: number;
  subtreeActivity: number;
}

function activityTime(session: UiSession): number {
  const parsed = Date.parse(session.lastMessageAt ?? session.updatedAt ?? session.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Finds sessions that participate in a parent cycle. Their parent edge is
 * ignored so malformed legacy data cannot hide the session or recurse forever.
 */
function cycleMembers(sessions: readonly UiSession[], byId: ReadonlyMap<string, UiSession>): Set<string> {
  const members = new Set<string>();

  for (const session of sessions) {
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let current: UiSession | undefined = session;

    while (current) {
      const repeatedAt = pathIndex.get(current.id);
      if (repeatedAt !== undefined) {
        for (const id of path.slice(repeatedAt)) members.add(id);
        break;
      }

      pathIndex.set(current.id, path.length);
      path.push(current.id);

      const parent: UiSession | undefined = current.parentSessionId
        ? byId.get(current.parentSessionId)
        : undefined;
      current = parent?.projectId === current.projectId ? parent : undefined;
    }
  }

  return members;
}

function compareNodes(a: SessionTreeNode, b: SessionTreeNode): number {
  return (
    b.subtreeActivity - a.subtreeActivity ||
    b.ownActivity - a.ownActivity ||
    a.originalIndex - b.originalIndex
  );
}

/**
 * Builds a presentation forest from durable parentSessionId relationships.
 *
 * Sorting is applied to complete subtrees rather than individual sessions, so
 * a recently active child lifts its parent group without separating the child
 * from that parent. Missing, cross-project, self, and cyclic parents are
 * intentionally rendered as roots.
 */
export function flattenSessionForest(sessions: readonly UiSession[]): SessionTreeEntry[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const nodes = new Map<string, SessionTreeNode>(
    sessions.map((session, originalIndex) => {
      const ownActivity = activityTime(session);
      return [
        session.id,
        {
          session,
          children: [],
          originalIndex,
          ownActivity,
          subtreeActivity: ownActivity
        }
      ];
    })
  );
  const cyclic = cycleMembers(sessions, byId);
  const roots: SessionTreeNode[] = [];

  for (const session of sessions) {
    const node = nodes.get(session.id);
    if (!node) continue;

    const parent = session.parentSessionId ? nodes.get(session.parentSessionId) : undefined;
    const hasValidParent =
      parent !== undefined &&
      parent.session.id !== session.id &&
      parent.session.projectId === session.projectId &&
      !cyclic.has(session.id);

    if (hasValidParent) parent.children.push(node);
    else roots.push(node);
  }

  const updateSubtreeActivity = (node: SessionTreeNode): number => {
    let latest = node.ownActivity;
    for (const child of node.children) latest = Math.max(latest, updateSubtreeActivity(child));
    node.subtreeActivity = latest;
    node.children.sort(compareNodes);
    return latest;
  };

  for (const root of roots) updateSubtreeActivity(root);
  roots.sort(compareNodes);

  const flattened: SessionTreeEntry[] = [];
  const visit = (node: SessionTreeNode, depth: number): void => {
    flattened.push({
      session: node.session,
      depth,
      hasChildren: node.children.length > 0
    });
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);

  return flattened;
}
