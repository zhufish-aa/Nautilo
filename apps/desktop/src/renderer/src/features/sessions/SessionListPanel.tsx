import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Folder,
  FolderOpen,
  MessageSquare,
  MessageSquarePlus,
  MinusSquare,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { cn, formatRelativeTime } from "../../lib/utils";
import type { UiSession } from "../../lib/types";
import { flattenSessionForest, type SessionTreeEntry } from "../../lib/session-tree";
import { Button } from "../../components/ui/Button";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { useUiReducedMotion } from "../../lib/ui-motion";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { useTeamsStore } from "../../stores/teams";
import { useAgentsStore } from "../../stores/agents";
import { useConnectionsStore } from "../../stores/connections";
import { groupSidebarEntries, UNGROUPED_PROJECT } from "../../lib/sidebar-navigation";
import { visibleSessionStatus } from "../../lib/session-lifecycle";
import { sessionActivityStatus } from "../../lib/runs-dashboard";
import { useInteractionsStore } from "../../stores/interactions";
import { useProjectNavigation } from "../../stores/project-navigation";
import "./session-sidebar.css";

const INITIAL_PROJECT_LIMIT = 40;
const PROJECT_PAGE_STEP = 60;
const ACCORDION_EASE = [0.22, 1, 0.36, 1] as const;

export function sessionTargetName(
  session: UiSession,
  teams: ReturnType<typeof useTeamsStore.getState>["teams"],
  instances: ReturnType<typeof useAgentsStore.getState>["instances"]
): string {
  const target = session.target;
  if (target.type === "team") {
    return teams.find((team) => team.id === target.teamId)?.name ?? "团队";
  }
  if (target.type === "member") {
    const team = teams.find((item) => item.id === target.teamId);
    return team?.members.find((member) => member.id === target.memberId)?.displayName ?? "成员";
  }
  return instances.find((instance) => instance.id === target.instanceId)?.displayName ?? "Agent";
}

function compactRelativeTime(iso: string, zh: boolean): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return zh ? "刚刚" : "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

type VisibleStatus = ReturnType<typeof visibleSessionStatus>;

const STATUS_DOT: Partial<Record<VisibleStatus, string>> = {
  running: "bg-accent",
  waiting_input: "bg-warn",
  waiting_approval: "bg-warn",
  failed: "bg-danger"
};

function StatusDot({ status }: { status: VisibleStatus }): JSX.Element | null {
  const color = STATUS_DOT[status];
  if (!color) return null;
  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden>
      {status === "running" && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full rounded-full opacity-70",
            color,
            "motion-safe:animate-[pulse-ring_1.6s_ease-out_infinite]"
          )}
        />
      )}
      <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", color)} />
    </span>
  );
}

interface SessionGroupNode {
  root: SessionTreeEntry;
  children: SessionTreeEntry[];
  hasActiveChildren: boolean;
}

function buildProjectTree(
  entries: readonly SessionTreeEntry[],
  liveIds: ReadonlySet<string>,
): SessionGroupNode[] {
  const groups: SessionGroupNode[] = [];
  let current: SessionGroupNode | undefined;
  for (const entry of entries) {
    if (entry.depth === 0) {
      current = { root: entry, children: [], hasActiveChildren: false };
      groups.push(current);
    } else if (current) {
      current.children.push(entry);
      if (liveIds.has(entry.session.id)) current.hasActiveChildren = true;
    } else {
      // Orphan fallback
      current = { root: { ...entry, depth: 0 }, children: [], hasActiveChildren: false };
      groups.push(current);
    }
  }
  return groups;
}

function SessionItem({
  entry,
  active,
  descendantCount,
  hasActiveChildren,
  threadExpanded,
  onToggleThread,
  onSelect,
  onDelete
}: {
  entry: SessionTreeEntry;
  active: boolean;
  descendantCount: number;
  hasActiveChildren: boolean;
  threadExpanded: boolean;
  onToggleThread?: () => void;
  onSelect: () => void;
  onDelete: () => void;
}): JSX.Element {
  const { session, depth } = entry;
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const reduced = useUiReducedMotion();
  const teams = useTeamsStore((state) => state.teams);
  const instances = useAgentsStore((state) => state.instances);
  const connections = useConnectionsStore((state) => state.connections);
  const orchestrationLifecycle = useSessionsStore((state) => state.running[session.id]);
  const foreground = useSessionsStore(state => state.foreground[session.id]);
  const interactions = useInteractionsStore(state => state.bySession[session.id]);
  const status = sessionActivityStatus(session.status, foreground, orchestrationLifecycle, interactions?.filter(item => item.status === "pending").length) as VisibleStatus;
  const statusLabel = STATUS_DOT[status] ? t(`sessions.status.${status}` as MessageKey) : null;
  const isChild = depth > 0;
  const targetName = sessionTargetName(session, teams, instances);
  const timestamp = session.lastMessageAt ?? session.createdAt;
  const timeShort = compactRelativeTime(timestamp, zh);
  const visualDepth = Math.min(depth, 4);

  const providerId = useMemo(() => {
    const target = session.target;
    if (target.type === "agent") {
      const inst = instances.find(item => item.id === target.instanceId);
      if (inst?.providerId) return inst.providerId;
    } else if (target.type === "member") {
      const team = teams.find(item => item.id === target.teamId);
      const member = team?.members.find(item => item.id === target.memberId);
      const inst = member ? instances.find(item => item.id === member.agentInstanceId) : undefined;
      if (inst?.providerId) return inst.providerId;
    }
    if (session.connectionId) {
      return connections.find(c => c.id === session.connectionId)?.harness;
    }
    return undefined;
  }, [session.target, session.connectionId, instances, teams, connections]);

  const hasThread = descendantCount > 0 && Boolean(onToggleThread);

  return (
    <div
      className="sb-session-item group"
      data-session-id={session.id}
      data-row-key={session.id}
      data-child={isChild || undefined}
      data-running={status === "running" || undefined}
      data-waiting={(status === "waiting_approval" || status === "waiting_input") || undefined}
      data-unread={session.unreadCount > 0 || undefined}
      data-has-thread={hasThread || undefined}
      style={{ paddingInlineStart: isChild ? `${14 + visualDepth * 12}px` : "4px" }}
    >
      {isChild && (
        <span
          className="sb-tree-guide"
          style={{ insetInlineStart: `${12 + (visualDepth - 1) * 12}px` }}
          aria-hidden
        />
      )}
      <button
        type="button"
        data-list-action
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        className="sb-session-btn"
      >
        {active && (
          <motion.span
            layoutId="sb-session-active"
            className="sb-active-pill"
            aria-hidden
            transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 460, damping: 36, mass: 0.8 }}
          />
        )}
        <span className="sb-session-leading">
          {STATUS_DOT[status] ? (
            <StatusDot status={status} />
          ) : isChild ? (
            <CornerDownRight size={11} aria-label={t("sessions.panel.subSessions")} />
          ) : session.target.type === "team" ? (
            <Users size={13} aria-hidden />
          ) : providerId ? (
            <ProviderAvatar providerId={providerId} size="sm" />
          ) : (
            <MessageSquare size={13} aria-hidden />
          )}
        </span>

        <span
          title={[session.title, targetName, session.model, statusLabel, formatRelativeTime(timestamp, locale)].filter(Boolean).join(" · ")}
          className="sb-session-title"
        >
          {session.title}
        </span>

        <span className="sb-session-meta">
          {session.unreadCount > 0 && (
            <span className="sb-session-unread">{session.unreadCount}</span>
          )}
          {hasThread && (
            <span
              role="button"
              tabIndex={0}
              className="sb-thread-toggle"
              aria-expanded={threadExpanded}
              data-active-children={hasActiveChildren || undefined}
              title={threadExpanded
                ? (zh ? `收起 ${descendantCount} 个子会话` : `Collapse ${descendantCount} sub-sessions`)
                : (zh ? `展开 ${descendantCount} 个子会话` : `Expand ${descendantCount} sub-sessions`)}
              onClick={event => { event.stopPropagation(); onToggleThread?.(); }}
              onKeyDown={event => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onToggleThread?.();
                }
              }}
            >
              {hasActiveChildren && !threadExpanded && <span className="sb-thread-live-dot" aria-hidden />}
              <ChevronRight size={10} className="sb-thread-chevron" aria-hidden />
              <span>{descendantCount}</span>
            </span>
          )}
          {timeShort && <span className="sb-session-time">{timeShort}</span>}
        </span>

        {statusLabel && <span className="sr-only">{statusLabel}</span>}
      </button>

      <button
        type="button"
        onClick={event => { event.stopPropagation(); onDelete(); }}
        className="sb-session-delete"
        aria-label={t("sessions.delete")}
        title={t("sessions.delete")}
      >
        <Trash2 size={13} aria-hidden />
      </button>
    </div>
  );
}

export function SessionListPanel({
  activeSessionId,
  onSelect,
  onNew,
  onDelete,
  mode,
  embedded = false
}: {
  activeSessionId?: string;
  onSelect: (id: string) => void;
  onNew: (projectId?: string) => void;
  onDelete: (session: UiSession) => void;
  /** When set, only sessions of this mode are listed (undefined means "code"). */
  mode?: "code" | "work";
  /** Share the app sidebar rather than drawing a second navigation column. */
  embedded?: boolean;
}): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const reduced = useUiReducedMotion();
  const allSessions = useSessionsStore((state) => state.sessions);
  const runningMap = useSessionsStore((state) => state.running);
  const foregroundMap = useSessionsStore((state) => state.foreground);
  const interactionsBySession = useInteractionsStore((state) => state.bySession);
  const projects = useProjectsStore((state) => state.projects);
  const collapsedProjects = useSettingsStore((state) => state.collapsedProjects);
  const toggleProjectCollapsed = useSettingsStore((state) => state.toggleProjectCollapsed);
  const navigation = useProjectNavigation();
  const scrollRef = useRef<HTMLDivElement>(null);

  /** Parent sessions whose child threads are explicitly expanded. Default: all collapsed! */
  const [expandedParents, setExpandedParents] = useState<Set<string>>(() => new Set());
  const [projectLimits, setProjectLimits] = useState<Record<string, number>>({});
  const [activeOnly, setActiveOnly] = useState(false);

  const sessions = useMemo(
    () => mode ? allSessions.filter((session) => (session.mode ?? "code") === mode) : allSessions,
    [allSessions, mode]
  );

  const isSessionLive = useMemo(() => {
    const live = new Set<string>();
    for (const session of sessions) {
      const pendingCount = interactionsBySession[session.id]?.filter(item => item.status === "pending").length ?? 0;
      const status = sessionActivityStatus(session.status, foregroundMap[session.id], runningMap[session.id], pendingCount) as VisibleStatus;
      if (status === "running" || status === "waiting_approval" || status === "waiting_input") {
        live.add(session.id);
      }
    }
    return live;
  }, [sessions, foregroundMap, runningMap, interactionsBySession]);

  const liveCount = isSessionLive.size;
  const filteringActive = activeOnly && liveCount > 0;

  const grouped = useMemo(() => groupSidebarEntries(flattenSessionForest(sessions), projects), [sessions, projects]);

  const projectTrees = useMemo(() => grouped.map(([projectId, entries]) => ({
    projectId,
    project: projects.find(item => item.id === projectId),
    tree: buildProjectTree(entries, isSessionLive),
  })), [grouped, projects, isSessionLive]);

  // Auto-expand the project group, visible window, and parent thread holding the active session.
  const autoExpandedForRef = useRef<string>();
  useEffect(() => {
    if (!activeSessionId || autoExpandedForRef.current === activeSessionId) return;
    const byId = new Map(sessions.map(item => [item.id, item]));
    const session = byId.get(activeSessionId);
    if (!session) return;
    autoExpandedForRef.current = activeSessionId;
    const groupId = projects.some((project) => project.id === session.projectId) ? session.projectId : UNGROUPED_PROJECT;
    if (collapsedProjects.includes(groupId)) toggleProjectCollapsed(groupId);

    // Ensure root index is within the rendered window if active session is deep in history.
    const projEntry = projectTrees.find(item => item.projectId === groupId);
    if (projEntry) {
      const idx = projEntry.tree.findIndex(node =>
        node.root.session.id === activeSessionId || node.children.some(child => child.session.id === activeSessionId));
      if (idx >= INITIAL_PROJECT_LIMIT) {
        setProjectLimits(prev => (prev[groupId] ?? INITIAL_PROJECT_LIMIT) > idx ? prev : { ...prev, [groupId]: idx + 12 });
      }
    }

    const ancestors: string[] = [];
    let cursor = session.parentSessionId ? byId.get(session.parentSessionId) : undefined;
    const visited = new Set<string>([session.id]);
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      ancestors.push(cursor.id);
      cursor = cursor.parentSessionId ? byId.get(cursor.parentSessionId) : undefined;
    }
    if (ancestors.length > 0) {
      setExpandedParents(previous => {
        if (ancestors.every(id => previous.has(id))) return previous;
        const next = new Set(previous);
        for (const id of ancestors) next.add(id);
        return next;
      });
    }
  }, [activeSessionId, sessions, projects, collapsedProjects, toggleProjectCollapsed, projectTrees]);

  // Restore and remember scroll position across route transitions.
  const restoredPosRef = useRef(false);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || restoredPosRef.current) return;
    restoredPosRef.current = true;
    const saved = navigation.position;
    if (!saved?.key) return;
    const target = element.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(saved.key)}"]`);
    if (target) {
      element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top + (saved.offset ?? 0);
    }
  }, [navigation.position]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = (): void => {
      const top = element.getBoundingClientRect().top;
      const row = Array.from(element.querySelectorAll<HTMLElement>("[data-row-key]")).find(
        item => item.getBoundingClientRect().bottom > top + 1,
      );
      const key = row?.dataset.rowKey;
      if (key && row) navigation.rememberPosition({ key, offset: Math.max(0, top - row.getBoundingClientRect().top) });
    };
    const onScroll = (): void => { clearTimeout(timer); timer = setTimeout(save, 160); };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => { clearTimeout(timer); element.removeEventListener("scroll", onScroll); };
  }, [navigation.rememberPosition]);

  const toggleParent = (id: string): void => {
    setExpandedParents(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if ((event.target as HTMLElement).matches("input,textarea,select")) return;
    const buttons = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-list-action]") ?? []);
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? buttons.length - 1
      : event.key === "ArrowDown" ? Math.min(buttons.length - 1, current < 0 ? 0 : current + 1)
      : Math.max(0, current < 0 ? 0 : current - 1);
    const target = buttons[next];
    if (!target) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "nearest" });
  };

  const accordionDuration = reduced ? 0 : 0.24;

  return (
    <aside
      aria-label={t("sessions.title")}
      className={cn("session-list-panel flex min-h-0 flex-col overflow-hidden", embedded ? "w-full flex-1" : "w-64 shrink-0 border-r border-line bg-panel")}
    >
      {!embedded && <div className="p-2.5 pb-1.5">
        <Button variant="outline" size="sm" className="w-full" data-tour="sessions-new" onClick={() => onNew()}>
          <MessageSquarePlus className="h-4 w-4" aria-hidden />
          {t("sessions.new")}
        </Button>
      </div>}
      {(liveCount > 0 || expandedParents.size > 0) && (
        <div className="session-list-controls">
          {liveCount > 0 && (
            <button
              type="button"
              className="session-list-chip"
              aria-pressed={filteringActive}
              onClick={() => setActiveOnly(value => !value)}
            >
              <span className="session-list-chip-dot" aria-hidden />
              {zh ? `进行中 ${liveCount}` : `Active ${liveCount}`}
            </button>
          )}
          {expandedParents.size > 0 && (
            <button
              type="button"
              className="session-list-collapse-btn"
              onClick={() => setExpandedParents(new Set())}
              title={zh ? "收起全部子会话" : "Collapse all sub-sessions"}
            >
              <MinusSquare size={11} aria-hidden />
              {zh ? "收起子项" : "Collapse"}
            </button>
          )}
        </div>
      )}
      <div
        ref={scrollRef}
        role="list"
        aria-label={t("sessions.title")}
        onKeyDown={handleKeyDown}
        className="sb-scroll-list min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-3"
      >
        {projectTrees.map(({ projectId, project, tree }) => {
          const filteredTree = filteringActive
            ? tree.filter(node => isSessionLive.has(node.root.session.id) || node.hasActiveChildren)
            : tree;
          if (filteringActive && filteredTree.length === 0) return null;
          const expanded = !collapsedProjects.includes(projectId);
          const limit = projectLimits[projectId] ?? INITIAL_PROJECT_LIMIT;
          const shownTree = filteredTree.slice(0, limit);
          const remaining = filteredTree.length - shownTree.length;
          const hasLiveInProject = tree.some(node => isSessionLive.has(node.root.session.id) || node.hasActiveChildren);

          return (
            <section key={projectId} className="sb-project-group" data-expanded={expanded || undefined}>
              <div className="sb-project-row" data-row-key={`project:${projectId}`}>
                <button
                  type="button"
                  data-list-action
                  aria-expanded={expanded}
                  onClick={() => toggleProjectCollapsed(projectId)}
                  title={project?.rootPath}
                  className="sb-project-trigger"
                >
                  <ChevronDown size={13} className="sb-project-chevron" aria-hidden />
                  {expanded
                    ? <FolderOpen size={14} className="sb-project-folder is-open" aria-hidden />
                    : <Folder size={14} className="sb-project-folder" aria-hidden />}
                  <span className="sb-project-name">{project?.name ?? (zh ? "未分组" : "Ungrouped")}</span>
                  {hasLiveInProject && !expanded && <span className="sb-project-live-dot" aria-hidden />}
                  <span className="sb-project-count">{filteredTree.length}</span>
                </button>
                {project && (
                  <button
                    type="button"
                    onClick={() => onNew(project.id)}
                    className="sb-project-new"
                    aria-label={zh ? `在 ${project.name} 中新建会话` : `New chat in ${project.name}`}
                    title={zh ? `在 ${project.name} 中新建会话` : `New chat in ${project.name}`}
                  >
                    <Plus size={13} aria-hidden />
                  </button>
                )}
              </div>

              <AnimatePresence initial={false}>
                {expanded && (
                  <motion.div
                    key="project-body"
                    className="sb-accordion-shell"
                    initial={reduced ? false : { height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={reduced ? undefined : { height: 0, opacity: 0 }}
                    transition={{ duration: accordionDuration, ease: ACCORDION_EASE }}
                  >
                    <motion.div
                      className="sb-accordion-inner"
                      initial={reduced ? false : { y: -6 }}
                      animate={{ y: 0 }}
                      exit={reduced ? undefined : { y: -6 }}
                      transition={{ duration: accordionDuration, ease: ACCORDION_EASE }}
                    >
                      {shownTree.map(({ root, children, hasActiveChildren }) => {
                        const rootId = root.session.id;
                        const isThreadOpen = expandedParents.has(rootId);
                        return (
                          <div key={rootId} className="sb-thread-group">
                            <SessionItem
                              entry={root}
                              active={rootId === activeSessionId}
                              descendantCount={children.length}
                              hasActiveChildren={hasActiveChildren}
                              threadExpanded={isThreadOpen}
                              onToggleThread={children.length > 0 ? () => toggleParent(rootId) : undefined}
                              onSelect={() => {
                                navigation.remember(projectId, { lastSessionId: rootId });
                                onSelect(rootId);
                              }}
                              onDelete={() => onDelete(root.session)}
                            />
                            <AnimatePresence initial={false}>
                              {children.length > 0 && isThreadOpen && (
                                <motion.div
                                  key="thread-children"
                                  className="sb-accordion-shell"
                                  initial={reduced ? false : { height: 0, opacity: 0 }}
                                  animate={{ height: "auto", opacity: 1 }}
                                  exit={reduced ? undefined : { height: 0, opacity: 0 }}
                                  transition={{ duration: reduced ? 0 : 0.2, ease: ACCORDION_EASE }}
                                >
                                  <motion.div
                                    className="sb-accordion-inner"
                                    initial={reduced ? false : { y: -5 }}
                                    animate={{ y: 0 }}
                                    exit={reduced ? undefined : { y: -5 }}
                                    transition={{ duration: reduced ? 0 : 0.2, ease: ACCORDION_EASE }}
                                  >
                                    {children.map(child => (
                                      <SessionItem
                                        key={child.session.id}
                                        entry={child}
                                        active={child.session.id === activeSessionId}
                                        descendantCount={0}
                                        hasActiveChildren={false}
                                        threadExpanded={false}
                                        onSelect={() => {
                                          navigation.remember(projectId, { lastSessionId: child.session.id });
                                          onSelect(child.session.id);
                                        }}
                                        onDelete={() => onDelete(child.session)}
                                      />
                                    ))}
                                  </motion.div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        );
                      })}
                      {remaining > 0 && (
                        <button
                          type="button"
                          className="sb-load-more"
                          onClick={() => setProjectLimits(prev => ({
                            ...prev,
                            [projectId]: (prev[projectId] ?? INITIAL_PROJECT_LIMIT) + PROJECT_PAGE_STEP,
                          }))}
                        >
                          {zh ? `显示更多会话（还有 ${remaining} 条）` : `Show more (${remaining} left)`}
                        </button>
                      )}
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
