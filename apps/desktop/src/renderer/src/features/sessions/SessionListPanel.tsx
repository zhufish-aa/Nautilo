import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, CornerDownRight, FileText, Folder, Plus, MessageSquarePlus, Trash2 } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { cn, formatRelativeTime } from "../../lib/utils";
import type { UiSession } from "../../lib/types";
import { flattenSessionForest, type SessionTreeEntry } from "../../lib/session-tree";
import { Button } from "../../components/ui/Button";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { useTeamsStore } from "../../stores/teams";
import { useAgentsStore } from "../../stores/agents";
import { groupSidebarEntries, UNGROUPED_PROJECT, visibleSidebarEntries } from "../../lib/sidebar-navigation";
import { visibleSessionStatus } from "../../lib/session-lifecycle";

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

function SessionItem({
  entry,
  active,
  onSelect,
  onDelete
}: {
  entry: SessionTreeEntry;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}): JSX.Element {
  const { session, depth, hasChildren } = entry;
  const { t, locale } = useI18n();
  const teams = useTeamsStore((state) => state.teams);
  const instances = useAgentsStore((state) => state.instances);
  const orchestrationLifecycle = useSessionsStore((state) => state.running[session.id]);
  const status = visibleSessionStatus(session.status, orchestrationLifecycle);
  const statusLabel = STATUS_DOT[status] ? t(`sessions.status.${status}` as MessageKey) : null;
  const isChild = depth > 0;
  const targetName = sessionTargetName(session, teams, instances);
  const timestamp = session.lastMessageAt ?? session.createdAt;
  const visualDepth = Math.min(depth, 4);

  return (
    <motion.li
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, height: 0, marginTop: 0, overflow: "hidden" }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="group relative min-w-0"
      data-session-id={session.id}
      style={{ paddingInlineStart: `${24 + visualDepth * 12}px` }}
    >
      {isChild && (
        <span
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-line/70"
          style={{ insetInlineStart: `${visualDepth * 12 - 6}px` }}
          aria-hidden
        />
      )}
      <button
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md py-1.5 pr-8 pl-2 text-left transition-[background-color,box-shadow] duration-150 outline-none",
          "focus-visible:ring-2 focus-visible:ring-accent/70",
          active
            ? "bg-card-hover"
            : "hover:bg-card-hover",
          isChild && "py-1.5"
        )}
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          {isChild ? (
            <CornerDownRight
              className="h-3 w-3 text-ink-3"
              aria-label={t("sessions.panel.subSessions")}
            />
          ) : (
            STATUS_DOT[status] ? <StatusDot status={status} /> : <FileText className="h-3.5 w-3.5 text-ink-3" aria-hidden />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              title={[session.title, targetName, statusLabel, formatRelativeTime(timestamp, locale)].filter(Boolean).join(" · ")}
              className={cn(
                "block min-w-0 flex-1 truncate text-[14px] font-medium leading-5 text-ink",
                (active || session.unreadCount > 0 || hasChildren) && "font-medium"
              )}
            >
              {session.title}
            </span>
            {session.unreadCount > 0 && (
              <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-on-accent">
                {session.unreadCount}
              </span>
            )}
          </span>

          {statusLabel && <span className="sr-only">{statusLabel}</span>}

        </span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="absolute top-1/2 right-1.5 z-10 -translate-y-1/2 rounded-md p-1 text-ink-3 opacity-0 transition-[opacity,color,background-color] hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-danger/60 focus-visible:outline-none group-hover:opacity-100"
        aria-label={t("sessions.delete")}
        title={t("sessions.delete")}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </button>
    </motion.li>
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
  const [limits, setLimits] = useState<Record<string, number>>({});
  const allSessions = useSessionsStore((state) => state.sessions);
  const projects = useProjectsStore((state) => state.projects);
  const collapsedProjects = useSettingsStore((state) => state.collapsedProjects);
  const toggleProjectCollapsed = useSettingsStore((state) => state.toggleProjectCollapsed);
  const sessions = useMemo(
    () => mode ? allSessions.filter((session) => (session.mode ?? "code") === mode) : allSessions,
    [allSessions, mode]
  );

  const grouped = useMemo(() => groupSidebarEntries(flattenSessionForest(sessions), projects), [sessions, projects]);

  // Auto-expand the group holding the active session exactly once per
  // selection change (covers first load / persisted-state restore and jumps
  // from other entry points). It is NOT a render-time condition: an explicit
  // click on the group header always wins afterwards.
  const autoExpandedForRef = useRef<string>();
  useEffect(() => {
    if (!activeSessionId || autoExpandedForRef.current === activeSessionId) return;
    const session = sessions.find((item) => item.id === activeSessionId);
    if (!session) return; // sessions not hydrated yet; retry on the next update
    autoExpandedForRef.current = activeSessionId;
    const groupId = projects.some((project) => project.id === session.projectId) ? session.projectId : UNGROUPED_PROJECT;
    if (collapsedProjects.includes(groupId)) toggleProjectCollapsed(groupId);
  }, [activeSessionId, sessions, projects, collapsedProjects, toggleProjectCollapsed]);

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
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-3">
        {grouped.map(([projectId, projectEntries]) => {
          const project = projects.find((item) => item.id === projectId);
          const containsActive = projectEntries.some((entry) => entry.session.id === activeSessionId);
          const expanded = !collapsedProjects.includes(projectId);
          const limit = limits[projectId] ?? 60;
          const visibleEntries = visibleSidebarEntries(projectEntries, limit, activeSessionId);
          return (
            <section key={projectId} className="min-w-0 overflow-hidden mt-1.5 first:mt-0">
              <div className="flex min-w-0 items-center gap-1">
                <button type="button" onClick={() => toggleProjectCollapsed(projectId)} aria-expanded={expanded}
                  className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[14px] font-medium text-ink hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                  title={project?.rootPath ?? (locale === "zh-CN" ? "未分组" : "Ungrouped")}>
                  <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-150", !expanded && "-rotate-90")} aria-hidden />
                  {project && <Folder className="h-4 w-4 shrink-0 text-ink-2" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">{project?.name ?? (locale === "zh-CN" ? "未分组" : "Ungrouped")}</span>
                  {!expanded && containsActive && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />}
                </button>
                {project && <button type="button" onClick={() => onNew(project.id)}
                  className="rounded-md p-1.5 text-ink-3 hover:bg-card-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                  aria-label={locale === "zh-CN" ? `在 ${project.name} 中新建会话` : `New chat in ${project.name}`} title={locale === "zh-CN" ? "新会话" : "New chat"}>
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                </button>}
              </div>
              <AnimatePresence initial={false}>
                {expanded && (
                  <motion.ul
                    key="list"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18, ease: "easeOut" }}
                    className="min-w-0 space-y-0.5 overflow-hidden"
                  >
                    <AnimatePresence initial={false}>
                      {visibleEntries.map((entry) => (
                        <SessionItem
                          key={entry.session.id}
                          entry={entry}
                          active={entry.session.id === activeSessionId}
                          onSelect={() => onSelect(entry.session.id)}
                          onDelete={() => onDelete(entry.session)}
                        />
                      ))}
                    </AnimatePresence>
                    {visibleEntries.length < projectEntries.length && <li><button type="button" onClick={() => setLimits((current) => ({ ...current, [projectId]: limit + 60 }))} className="w-full rounded-lg px-4 py-2 text-left text-xs text-ink-3 hover:bg-card-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">{locale === "zh-CN" ? "显示更多对话" : "Show more chats"}</button></li>}
                  </motion.ul>
                )}
              </AnimatePresence>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
