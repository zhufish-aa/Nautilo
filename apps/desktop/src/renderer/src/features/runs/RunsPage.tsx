import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, FileText, Inbox, Loader2 } from "lucide-react";
import { PageHeader } from "../../components/layout/AppShell";
import { Switch } from "../../components/ui/Switch";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { formatDateTime } from "../../lib/utils";
import { sessionLocation } from "../../lib/sidebar-navigation";
import { pendingCountsBySession } from "../../lib/notification-policy";
import { groupSessionsForDashboard } from "../../lib/runs-dashboard";
import type { TimelineEvent, UiSession } from "../../lib/types";
import { sessionTargetName } from "../sessions/SessionListPanel";
import { useAgentsStore } from "../../stores/agents";
import { useInteractionsStore } from "../../stores/interactions";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { useTeamsStore } from "../../stores/teams";

function lastSnippet(events: TimelineEvent[] | undefined): string {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const data = events![index]!.data;
    if (data.kind === "message" && data.text.trim()) return data.text.replace(/\s+/g, " ").trim();
    if (data.kind === "tool_activity") return data.toolName;
    if (data.kind === "tool_group") {
      const snippet = lastSnippet(data.items);
      if (snippet) return snippet;
    }
  }
  return "";
}

export function RunsPage(): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
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
  const pending = useMemo(() => pendingCountsBySession(bySession), [bySession]);
  const groups = useMemo(
    () => groupSessionsForDashboard({ sessions, foreground, running, pending }),
    [sessions, foreground, running, pending]
  );
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  );
  const open = (session: UiSession): void => {
    setActiveSession(session.id);
    navigate(sessionLocation(session));
  };
  const sections = ["waiting", "running", "unread"] as const;
  return (
    <div className="mx-auto max-w-5xl py-3 sm:py-6">
      <PageHeader
        title={t("runsPage.title")}
        actions={
          <div className="flex items-center gap-3 text-sm text-ink-3">
            <span>{t("runsPage.soundToggle")}</span>
            <Switch
              checked={notificationSound}
              onCheckedChange={setNotificationSound}
              disabled={!notificationsEnabled}
              aria-label={t("runsPage.soundToggle")}
            />
          </div>
        }
      />
      <div className="mt-10 space-y-10">
        {sections.map((section) => (
          <section key={section} aria-labelledby={`runs-${section}`}>
            <h2
              id={`runs-${section}`}
              className="mb-4 flex items-center gap-3 text-[15px] font-medium text-ink-2"
            >
              {t(`runsPage.${section}` as MessageKey)}
              <span className="font-normal tabular-nums text-ink-3">{groups[section].length}</span>
            </h2>
            <ul className="divide-y divide-line border-y border-line">
              {!groups[section].length ? (
                <li className="flex items-center gap-3 py-6 text-sm text-ink-3">
                  <Inbox className="h-4 w-4" aria-hidden />
                  {t(`runsPage.empty${section[0].toUpperCase()}${section.slice(1)}` as MessageKey)}
                </li>
              ) : (
                groups[section].map((session) => {
                  const meta = [
                    projectNames.get(session.projectId),
                    sessionTargetName(session, teams, instances)
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  const snippet = lastSnippet(events[session.id]);
                  return (
                    <li key={session.id}>
                      <button
                        type="button"
                        onClick={() => open(session)}
                        aria-label={`${t("runsPage.open")}: ${session.title || t("runsPage.untitled")}`}
                        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-3 rounded-lg px-2 py-4 text-left transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]"
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <FileText className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {session.title || t("runsPage.untitled")}
                            </span>
                            <span className="mt-1 block truncate text-sm text-ink-3" title={meta}>
                              {meta}
                            </span>
                          </span>
                        </span>
                        <span className="col-start-1 row-start-2 flex min-w-0 items-center gap-2 pl-7 text-sm text-ink-3 sm:col-auto sm:row-auto sm:pl-0">
                          {section === "running" && (
                            <Loader2
                              className="h-4 w-4 shrink-0 motion-safe:animate-spin"
                              aria-hidden
                            />
                          )}
                          {section === "unread" && (
                            <span
                              className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3"
                              aria-hidden
                            />
                          )}
                          <span className="truncate" title={snippet}>
                            {section === "waiting"
                              ? t("runsPage.pendingBadge", { count: pending[session.id] ?? 0 })
                              : snippet ||
                                (section === "running"
                                  ? t("runsPage.running")
                                  : `${zh ? "未读" : "Unread"} ${session.unreadCount}`)}
                          </span>
                        </span>
                        <span className="col-start-2 row-start-1 flex items-center gap-2 text-sm text-ink-3 sm:col-auto">
                          {section === "unread" ? (
                            <time
                              className="hidden sm:block"
                              dateTime={session.lastMessageAt ?? session.updatedAt}
                            >
                              {formatDateTime(session.lastMessageAt ?? session.updatedAt, locale)}
                            </time>
                          ) : (
                            <span className="hidden sm:block">
                              {section === "waiting"
                                ? zh
                                  ? "查看"
                                  : "Review"
                                : zh
                                  ? "打开会话"
                                  : "Open"}
                            </span>
                          )}
                          <ChevronRight className="h-4 w-4" aria-hidden />
                        </span>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
