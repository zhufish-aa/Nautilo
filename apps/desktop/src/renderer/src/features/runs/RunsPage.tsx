import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { BellRing, Inbox, Loader2, MailWarning } from "lucide-react";
import { PageHeader } from "../../components/layout/AppShell";
import { EmptyState } from "../../components/ui/EmptyState";
import { Switch } from "../../components/ui/Switch";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { formatDateTime } from "../../lib/utils";
import { pendingCountsBySession } from "../../lib/notification-policy";
import { groupSessionsForDashboard, type DashboardGroups } from "../../lib/runs-dashboard";
import type { TimelineEvent, UiSession } from "../../lib/types";
import { sessionTargetName } from "../sessions/SessionListPanel";
import { useAgentsStore } from "../../stores/agents";
import { useInteractionsStore } from "../../stores/interactions";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { useTeamsStore } from "../../stores/teams";

/** Latest human-readable line of a session, for the card preview. */
function lastSnippet(events: TimelineEvent[] | undefined): string {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const data = events![index]!.data;
    if (data.kind === "message" && data.text.trim()) return data.text.replace(/\s+/g, " ").trim();
    if (data.kind === "tool_activity") return data.toolName;
  }
  return "";
}

function SessionCard({
  session,
  meta,
  snippet,
  badge,
  tone,
  onOpen
}: {
  session: UiSession;
  meta: string;
  snippet: string;
  badge?: string;
  tone: "warn" | "accent" | "info";
  onOpen: () => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const toneClass = tone === "warn" ? "border-warn/40 bg-warn/10 text-warn" : tone === "accent" ? "border-accent/40 bg-accent-soft text-accent" : "border-info/40 bg-info/10 text-info";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${t("runsPage.open")}: ${session.title || t("runsPage.untitled")}`}
      className="group flex w-full flex-col gap-1.5 rounded-2xl border border-line bg-card px-4 py-3.5 text-left transition-all hover:border-accent/50 hover:shadow-pop focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
    >
      <div className="flex w-full items-center justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-medium text-ink">{session.title || t("runsPage.untitled")}</span>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${toneClass}`}>{badge}</span>
      </div>
      <p className="w-full truncate text-[11px] text-ink-3">{meta}</p>
      <p className="w-full truncate text-xs text-ink-2">{snippet || "—"}</p>
      <time className="text-[10px] text-ink-3">{formatDateTime(session.lastMessageAt ?? session.updatedAt, locale)}</time>
    </button>
  );
}

export function RunsPage(): JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const sessions = useSessionsStore((state) => state.sessions);
  const foreground = useSessionsStore((state) => state.foreground);
  const running = useSessionsStore((state) => state.running);
  const events = useSessionsStore((state) => state.events);
  const bySession = useInteractionsStore((state) => state.bySession);
  const setActiveSession = useSessionsStore((state) => state.setActiveSession);
  const teams = useTeamsStore((state) => state.teams);
  const instances = useAgentsStore((state) => state.instances);
  const projects = useProjectsStore((state) => state.projects);
  const notificationsEnabled = useSettingsStore((state) => state.notificationsEnabled);
  const notificationSound = useSettingsStore((state) => state.notificationSound);
  const setNotificationSound = useSettingsStore((state) => state.setNotificationSound);

  const groups: DashboardGroups<UiSession> = useMemo(
    () => groupSessionsForDashboard({ sessions, foreground, running, pending: pendingCountsBySession(bySession) }),
    [sessions, foreground, running, bySession]
  );

  const open = (sessionId: string): void => {
    setActiveSession(sessionId);
    navigate("/sessions");
  };
  const meta = (session: UiSession): string => {
    const project = projects.find((item) => item.id === session.projectId)?.name ?? "";
    return `${project} · ${sessionTargetName(session, teams, instances)}`;
  };

  const sections: Array<{ key: "waiting" | "running" | "unread"; icon: typeof Inbox; tone: "warn" | "accent" | "info"; badge: (session: UiSession) => string | undefined }> = [
    {
      key: "waiting",
      icon: BellRing,
      tone: "warn",
      badge: (session) => t("runsPage.pendingBadge", { count: pendingCountsBySession(bySession)[session.id] ?? 0 })
    },
    { key: "running", icon: Loader2, tone: "accent", badge: () => t("runsPage.running") },
    { key: "unread", icon: MailWarning, tone: "info", badge: (session) => String(session.unreadCount) }
  ];

  return (
    <>
      <PageHeader title={t("runsPage.title")} subtitle={t("runsPage.subtitle")} />
      <div className="mb-4 flex items-center justify-end gap-2 text-xs text-ink-3">
        <span>{t("runsPage.soundToggle")}</span>
        <Switch
          checked={notificationSound}
          onCheckedChange={setNotificationSound}
          disabled={!notificationsEnabled}
          aria-label={t("runsPage.soundToggle")}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {sections.map((section) => {
          const Icon = section.icon;
          const list = groups[section.key];
          return (
            <section key={section.key} className="flex flex-col gap-2.5">
              <h2 className="flex items-center gap-2 px-1 text-xs font-semibold tracking-[0.16em] text-ink-3">
                <Icon className={`h-3.5 w-3.5 ${section.key === "running" && list.length > 0 ? "animate-spin" : ""}`} aria-hidden />
                {t(`runsPage.${section.key}` as MessageKey)}
                <span className="rounded-full bg-line/60 px-1.5 py-px text-[10px] font-semibold text-ink-3">{list.length}</span>
              </h2>
              {list.length === 0 ? (
                <EmptyState icon={Icon} title={t(`runsPage.empty${section.key[0].toUpperCase()}${section.key.slice(1)}` as MessageKey)} description="" />
              ) : (
                <div className="flex flex-col gap-2.5">
                  {list.map((session) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      meta={meta(session)}
                      snippet={lastSnippet(events[session.id])}
                      badge={section.badge(session)}
                      tone={section.tone}
                      onOpen={() => open(session.id)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
