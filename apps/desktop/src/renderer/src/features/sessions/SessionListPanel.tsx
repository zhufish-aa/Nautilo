import { useEffect, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, CornerDownRight, MessageSquarePlus, Trash2 } from "lucide-react";
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

const STATUS_TEXT: Partial<Record<VisibleStatus, string>> = {
  running: "text-accent",
  waiting_input: "text-warn",
  waiting_approval: "text-warn",
  failed: "text-danger"
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
  const showTargetName = targetName !== session.title;
  const timestamp = session.lastMessageAt ?? session.updatedAt;
  const visualDepth = Math.min(depth, 4);

  return (
    <li
      className="group relative min-w-0"
      role="treeitem"
      aria-level={depth + 1}
      style={{ paddingInlineStart: `${visualDepth * 12}px` }}
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
          "relative flex w-full min-w-0 items-start gap-2 overflow-hidden rounded-lg py-2 pr-8 pl-2 text-left transition-colors duration-150 outline-none",
          "focus-visible:ring-2 focus-visible:ring-accent/70",
          active
            ? "bg-accent-soft/80 shadow-[inset_2px_0_0_var(--color-accent)]"
            : "hover:bg-card-hover",
          isChild && "py-1.5"
        )}
      >
        <span className="mt-1 flex h-3 w-3 shrink-0 items-center justify-center">
          {isChild ? (
            <CornerDownRight
              className="h-3 w-3 text-ink-3"
              aria-label={t("sessions.panel.subSessions")}
            />
          ) : (
            <StatusDot status={status} />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              title={session.title}
              className={cn(
                "block min-w-0 flex-1 truncate text-[13px] leading-5 text-ink",
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

          <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-ink-3">
            <span className="min-w-0 flex-1 truncate">
              {showTargetName ? targetName : null}
              {showTargetName && statusLabel ? " · " : null}
              {statusLabel ? (
                <span className={cn("font-medium", STATUS_TEXT[status])}>{statusLabel}</span>
              ) : null}
            </span>
            <time className="shrink-0 tabular-nums opacity-80 transition-opacity group-hover:opacity-0">
              {formatRelativeTime(timestamp, locale)}
            </time>
          </span>
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
    </li>
  );
}

export function SessionListPanel({
  activeSessionId,
  onSelect,
  onNew,
  onDelete,
  mode
}: {
  activeSessionId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (session: UiSession) => void;
  /** When set, only sessions of this mode are listed (undefined means "code"). */
  mode?: "code" | "work";
}): JSX.Element {
  const { t } = useI18n();
  const allSessions = useSessionsStore((state) => state.sessions);
  const projects = useProjectsStore((state) => state.projects);
  const collapsedProjects = useSettingsStore((state) => state.collapsedProjects);
  const toggleProjectCollapsed = useSettingsStore((state) => state.toggleProjectCollapsed);
  const sessions = useMemo(
    () => mode ? allSessions.filter((session) => (session.mode ?? "code") === mode) : allSessions,
    [allSessions, mode]
  );

  const grouped = useMemo(() => {
    const map = new Map<string, SessionTreeEntry[]>();
    for (const entry of flattenSessionForest(sessions)) {
      const list = map.get(entry.session.projectId) ?? [];
      list.push(entry);
      map.set(entry.session.projectId, list);
    }
    return [...map.entries()];
  }, [sessions]);

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
    if (collapsedProjects.includes(session.projectId)) toggleProjectCollapsed(session.projectId);
  }, [activeSessionId, sessions, collapsedProjects, toggleProjectCollapsed]);

  return (
    <aside
      aria-label={t("sessions.title")}
      className="session-list-panel flex w-64 shrink-0 flex-col overflow-hidden border-r border-line/80 bg-card/95 backdrop-blur-xl"
    >
      <div className="p-2.5 pb-1.5">
        <Button variant="outline" size="sm" className="w-full" onClick={onNew}>
          <MessageSquarePlus className="h-4 w-4" aria-hidden />
          {t("sessions.new")}
        </Button>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-2 pt-1 pb-3">
        {grouped.map(([projectId, projectEntries]) => {
          const project = projects.find((item) => item.id === projectId);
          const containsActive = projectEntries.some((entry) => entry.session.id === activeSessionId);
          const expanded = !collapsedProjects.includes(projectId);
          return (
            <section key={projectId} className="min-w-0 overflow-hidden mt-3.5 first:mt-1">
              <button
                type="button"
                onClick={() => toggleProjectCollapsed(projectId)}
                aria-expanded={expanded}
                title={t(expanded ? "sessions.panel.collapseGroup" : "sessions.panel.expandGroup")}
                className="mb-1 flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-medium tracking-wide text-ink-3 transition-colors outline-none hover:bg-card-hover hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-accent/70"
              >
                <ChevronDown
                  className={cn("h-3 w-3 shrink-0 transition-transform duration-200", !expanded && "-rotate-90")}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate">{project?.name ?? projectId}</span>
                {!expanded && containsActive && (
                  // The active session lives inside this collapsed group.
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                )}
                <span className="shrink-0 tabular-nums opacity-70">{projectEntries.length}</span>
              </button>
              <AnimatePresence initial={false}>
                {expanded && (
                  <motion.ul
                    key="list"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18, ease: "easeOut" }}
                    className="min-w-0 space-y-0.5 overflow-hidden"
                    role="tree"
                  >
                    {projectEntries.map((entry) => (
                      <SessionItem
                        key={entry.session.id}
                        entry={entry}
                        active={entry.session.id === activeSessionId}
                        onSelect={() => onSelect(entry.session.id)}
                        onDelete={() => onDelete(entry.session)}
                      />
                    ))}
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
