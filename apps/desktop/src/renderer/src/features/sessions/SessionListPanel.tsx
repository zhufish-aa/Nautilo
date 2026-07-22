import { useMemo } from "react";
import { CornerDownRight, MessageSquarePlus } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { cn, formatRelativeTime } from "../../lib/utils";
import type { UiSession } from "../../lib/types";
import { StatusChip } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
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

function SessionItem({
  session,
  active,
  onSelect
}: {
  session: UiSession;
  active: boolean;
  onSelect: () => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const teams = useTeamsStore((state) => state.teams);
  const instances = useAgentsStore((state) => state.instances);
  const orchestrationLifecycle = useSessionsStore((state) => state.running[session.id]);
  const status = visibleSessionStatus(session.status, orchestrationLifecycle);
  const statusTone =
    status === "running"
      ? "accent"
      : status === "waiting_approval"
        ? "warn"
        : status === "failed"
          ? "danger"
          : "muted";

  return (
    <li>
      <button
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-all duration-150 outline-none",
          "focus-visible:ring-2 focus-visible:ring-accent/70",
          active
            ? "border-accent/40 bg-accent-soft/70"
            : "border-transparent hover:border-line hover:bg-card-hover"
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className={cn("flex min-w-0 items-center gap-1 text-[13px] font-medium", active ? "text-accent" : "text-ink")}>
              {session.parentSessionId && (
                <CornerDownRight
                  className="h-3.5 w-3.5 shrink-0 text-ink-3"
                  aria-label={t("sessions.panel.subSessions")}
                />
              )}
              <span className="truncate">{session.title}</span>
            </span>
            {session.unreadCount > 0 && (
              <span className="flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-on-accent">
                {session.unreadCount}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="truncate text-xs text-ink-3">{sessionTargetName(session, teams, instances)}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              {status !== "idle" && status !== "completed" && (
                <StatusChip
                  tone={statusTone}
                  label={t(`sessions.status.${status}` as MessageKey)}
                  pulse={status === "running"}
                  className="h-5 px-1.5 text-[10px]"
                />
              )}
              {session.lastMessageAt && (
                <time className="text-[10px] text-ink-3">{formatRelativeTime(session.lastMessageAt, locale)}</time>
              )}
            </span>
          </div>
        </div>
      </button>
    </li>
  );
}

export function SessionListPanel({
  activeSessionId,
  onSelect,
  onNew
}: {
  activeSessionId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const sessions = useSessionsSorted();
  const projects = useProjectsStore((state) => state.projects);

  const grouped = useMemo(() => {
    const map = new Map<string, UiSession[]>();
    for (const session of sessions) {
      const list = map.get(session.projectId) ?? [];
      list.push(session);
      map.set(session.projectId, list);
    }
    return [...map.entries()];
  }, [sessions]);

  return (
    <aside aria-label={t("sessions.title")} className="flex w-60 shrink-0 flex-col border-r border-line bg-panel backdrop-blur-xl">
      <div className="border-b border-line p-3">
        <Button variant="primary" className="w-full" onClick={onNew}>
          <MessageSquarePlus className="h-4 w-4" aria-hidden />
          {t("sessions.new")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {grouped.map(([projectId, projectSessions]) => {
          const project = projects.find((item) => item.id === projectId);
          return (
            <section key={projectId} className="mb-4">
              <h3 className="mb-1.5 flex items-center justify-between px-1.5 text-[11px] font-semibold tracking-widest text-ink-3 uppercase">
                <span className="truncate">{project?.name ?? projectId}</span>
                <span>{projectSessions.length}</span>
              </h3>
              <ul className="space-y-1">
                {projectSessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    active={session.id === activeSessionId}
                    onSelect={() => onSelect(session.id)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function useSessionsSorted(): UiSession[] {
  const sessions = useSessionsStore((state) => state.sessions);
  return useMemo(
    () => [...sessions].sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt)),
    [sessions]
  );
}
